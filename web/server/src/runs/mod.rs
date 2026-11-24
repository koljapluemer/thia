//! MCP run recording, owner ratings, and terminal inspection of the record.

pub mod cli;
pub mod index;
pub mod prices;
pub mod read;
pub mod server_run;
pub mod store;

use std::collections::BTreeMap;

use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::post;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::auth::SignedIn;
use crate::{ApiError, ApiResult, AppState, now_iso};
use store::Store;
use index::Summary;

/// at most this many runs' rows are summed for one summary
pub const SUMMARY_ROWS: i64 = 10_000;

pub(crate) fn server_provenance() -> Value {
    json!({ "server": {
        "version": env!("CARGO_PKG_VERSION"), "commit": option_env!("GESTALTS_GIT_COMMIT"),
        "tag": option_env!("GESTALTS_BUILD"), "dirty": option_env!("GESTALTS_GIT_DIRTY").map(|v| v == "true"),
    } })
}

/// The runs' records and the lock that keeps two batches of one run from interleaving.
pub struct Runs {
    pub store: Store,
    writes: tokio::sync::Mutex<()>,
}

impl Runs {
    /// The runs under `root`, with the index rebuilt when it's of another version (or `rebuild`).
    pub fn open(conn: &Connection, root: std::path::PathBuf, rebuild: bool) -> Result<Runs, String> {
        let runs = Runs { store: Store::new(root), writes: tokio::sync::Mutex::default() };
        let current = index::ensure(conn).map_err(|e| e.to_string())?;
        if rebuild || !current { runs.reindex(conn)?; }
        Ok(runs)
    }

    /// The index made anew from every record; how many runs it has.
    pub fn reindex(&self, conn: &Connection) -> Result<usize, String> {
        index::clear(conn).map_err(|e| e.to_string())?;
        let mut n = 0;
        for rel in self.store.records() {
            let Some(id) = rel.rsplit('/').next().and_then(|f| f.strip_suffix(".jsonl")) else { continue };
            let Ok(lines) = self.store.read(&rel) else { continue };
            let mut s = Summary::default();
            for l in &lines {
                let page = l.get("by").is_none();
                let seq = l.get("seq").and_then(Value::as_i64).unwrap_or(-1);
                if page && !s.first_time(seq) { continue; }
                if !page { s.server_seq = s.server_seq.min(seq - 1); }
                s.fold(l);
            }
            if s.account.is_empty() { continue; }
            index::save(conn, id, &rel, &s).map_err(|e| e.to_string())?;
            n += 1;
        }
        Ok(n)
    }
}

fn io(e: std::io::Error) -> ApiError {
    ApiError::Internal(e.to_string())
}

#[derive(Deserialize)]
struct Rating {
    score: i64,
    #[serde(default)]
    comment: Option<String>,
}

/// The account's rating of one of its runs, at the next seq: for the runs the server records (a chat host's), where the
/// page doesn't know the seqs.
async fn rate(State(state): State<AppState>, me: SignedIn, Path(id): Path<String>, Json(r): Json<Rating>) -> ApiResult<StatusCode> {
    if !(1..=5).contains(&r.score) { return Err(ApiError::BadRequest("score: 1 to 5".into())); }
    let comment = r.comment.map(|c| c.trim().to_owned()).filter(|c| !c.is_empty());
    if comment.as_ref().is_some_and(|c| c.len() > 20_000) { return Err(ApiError::BadRequest("a comment of at most 20000 characters".into())); }
    let _w = state.runs.writes.lock().await;
    let (mut s, rel) = state.db.with(|c| index::load(c, &id))?.ok_or(ApiError::NotFound)?;
    if s.account != me.0.id { return Err(ApiError::NotFound); }
    let seq = s.seen.last().map_or(0, |r| r.1 + 1);
    let mut e = json!({ "v": 1, "run": id, "seq": seq, "at": now_iso(), "type": "rating", "score": r.score });
    if let Some(c) = comment { e["comment"] = json!(c); }
    s.first_time(seq);
    s.fold(&e);
    state.runs.store.append(&rel, &[e]).map_err(io)?;
    state.db.with(|c| index::save(c, &id, &rel, &s))?;
    Ok(StatusCode::NO_CONTENT)
}

/// Which runs: the `/api/admin/runs…` query, and `thia-server admin runs`'.
#[derive(Deserialize, Default)]
#[serde(default)]
pub struct Filter {
    pub since: Option<String>,
    pub until: Option<String>,
    pub backend: Option<String>,
    pub session: Option<String>,
    pub app_commit: Option<String>,
    pub server_commit: Option<String>,
    pub bridge_commit: Option<String>,
    pub provider_version: Option<String>,
    pub model: Option<String>,
    pub kind: Option<String>,
    pub purpose: Option<String>,
    pub outcome: Option<String>,
    /// `yes` or `no`
    pub rated: Option<String>,
    /// the latest rating at least / at most this (an unrated run is neither)
    pub rating_min: Option<i64>,
    pub rating_max: Option<i64>,
    pub draft: Option<String>,
    /// a page after this one: `<started>|<id>` of the last row seen
    pub before: Option<String>,
    pub limit: Option<i64>,
    pub by: Option<String>,
}

impl Filter {
    fn sql(&self) -> (String, Vec<String>) {
        let mut w = vec!["1 = 1".to_owned()];
        let mut p: Vec<String> = vec![];
        let mut eq = |col: &str, v: &Option<String>, op: &str| {
            if let Some(v) = v.as_deref().filter(|v| !v.is_empty()) {
                p.push(if op == "LIKE" { format!("%{v}%") } else { v.to_owned() });
                w.push(format!("{col} {op} ?{}", p.len()));
            }
        };
        eq("started", &self.since, ">=");
        eq("started", &self.until, "<");
        eq("backend", &self.backend, "=");
        eq("session", &self.session, "=");
        eq("app_commit", &self.app_commit, "LIKE");
        eq("server_commit", &self.server_commit, "LIKE");
        eq("bridge_commit", &self.bridge_commit, "LIKE");
        eq("provider_version", &self.provider_version, "LIKE");
        eq("models", &self.model, "LIKE");
        eq("kind", &self.kind, "=");
        eq("purpose", &self.purpose, "=");
        eq("outcome", &self.outcome, "=");
        eq("draft", &self.draft, "=");
        match self.rated.as_deref() {
            Some("yes") => w.push("rating IS NOT NULL".into()),
            Some("no") => w.push("rating IS NULL".into()),
            _ => {}
        }
        // numbers, so in the SQL as they are
        if let Some(n) = self.rating_min { w.push(format!("rating >= {n}")); }
        if let Some(n) = self.rating_max { w.push(format!("rating <= {n}")); }
        (w.join(" AND "), p)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub id: String,
    pub account: String,
    pub started: String,
    pub last_at: Option<String>,
    pub draft: Option<String>,
    pub kind: Option<String>,
    pub purpose: Option<String>,
    pub backend: Option<String>,
    pub session: Option<String>,
    pub app_commit: Option<String>,
    pub app_build: Option<String>,
    pub server_commit: Option<String>,
    pub server_build: Option<String>,
    pub bridge_commit: Option<String>,
    pub bridge_version: Option<String>,
    pub provider_version: Option<String>,
    pub models: Option<String>,
    pub billing: Option<String>,
    pub outcome: Option<String>,
    pub waiting: bool,
    pub wall_ms: Option<i64>,
    pub first_output_ms: Option<i64>,
    pub requests: i64,
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub cost_usd: Option<f64>,
    pub tools: i64,
    pub tool_failures: i64,
    pub check_ok: Option<bool>,
    pub files_changed: i64,
    pub errors: i64,
    pub rating: Option<i64>,
    pub comment: Option<String>,
    pub notes: i64,
}

const COLUMNS: &str = "id, account, started, last_at, draft, kind, purpose, backend, session,
    app_commit, app_build, server_commit, server_build, bridge_commit, bridge_version, provider_version,
    models, billing, outcome, waiting, wall_ms,
    first_output_ms, requests, input, output, cache_read, cache_write, cost_usd, tools, tool_failures, check_ok, files_changed,
    errors, rating, comment, notes";

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Row> {
    Ok(Row {
        id: r.get(0)?, account: r.get(1)?, started: r.get(2)?, last_at: r.get(3)?, draft: r.get(4)?, kind: r.get(5)?, purpose: r.get(6)?,
        backend: r.get(7)?, session: r.get(8)?, app_commit: r.get(9)?, app_build: r.get(10)?, server_commit: r.get(11)?, server_build: r.get(12)?,
        bridge_commit: r.get(13)?, bridge_version: r.get(14)?, provider_version: r.get(15)?, models: r.get(16)?,
        billing: r.get(17)?, outcome: r.get(18)?, waiting: r.get(19)?, wall_ms: r.get(20)?, first_output_ms: r.get(21)?,
        requests: r.get(22)?, input: r.get(23)?, output: r.get(24)?, cache_read: r.get(25)?, cache_write: r.get(26)?,
        cost_usd: r.get(27)?, tools: r.get(28)?, tool_failures: r.get(29)?, check_ok: r.get(30)?, files_changed: r.get(31)?,
        errors: r.get(32)?, rating: r.get(33)?, comment: r.get(34)?, notes: r.get(35)?,
    })
}

/// A page of the index, newest first; `cursor`: after `f.before`.
pub fn rows(conn: &Connection, f: &Filter, limit: i64, cursor: bool) -> rusqlite::Result<Vec<Row>> {
    let (mut w, mut p) = f.sql();
    if cursor && let Some((started, id)) = f.before.as_deref().and_then(|b| b.split_once('|')) {
        p.push(started.to_owned());
        p.push(id.to_owned());
        w.push_str(&format!(" AND (started < ?{a} OR (started = ?{a} AND id < ?{b}))", a = p.len() - 1, b = p.len()));
    }
    let sql = format!("SELECT {COLUMNS} FROM runs WHERE {w} ORDER BY started DESC, id DESC LIMIT {limit}");
    let mut st = conn.prepare(&sql)?;
    st.query_map(rusqlite::params_from_iter(p.iter()), row)?.collect()
}

pub fn in_order(events: &mut [Value]) {
    events.sort_by(|a, b| {
        let (sa, sb) = (a["seq"].as_i64().unwrap_or(0), b["seq"].as_i64().unwrap_or(0));
        (sa < 0).cmp(&(sb < 0)).then(if sa < 0 { a["at"].as_str().cmp(&b["at"].as_str()) } else { sa.cmp(&sb) })
    });
}

fn quantile(sorted: &[i64], q: f64) -> Option<i64> {
    if sorted.is_empty() { return None; }
    Some(sorted[((sorted.len() - 1) as f64 * q).round() as usize])
}

pub fn row_of(conn: &Connection, id: &str) -> rusqlite::Result<Option<Row>> {
    use rusqlite::OptionalExtension;
    conn.query_row(&format!("SELECT {COLUMNS} FROM runs WHERE id = ?1"), [id], row).optional()
}

/// The runs `all` (a summary's rows, at most [`SUMMARY_ROWS`]) summed by `by`.
pub fn summarize(all: &[Row], by: &str) -> Value {
    let key = |r: &Row| -> String {
        match by {
            "model" => r.models.clone(),
            "kind" => r.kind.clone(),
            "purpose" => r.purpose.clone(),
            "day" => Some(r.started.chars().take(10).collect()),
            "draft" => r.draft.clone(),
            "session" => r.session.clone(),
            "app-commit" => r.app_commit.clone(),
            "server-commit" => r.server_commit.clone(),
            "bridge-commit" => r.bridge_commit.clone(),
            "provider-version" => r.provider_version.clone(),
            _ => r.backend.clone(),
        }
        .unwrap_or_else(|| "—".into())
    };
    let mut groups: BTreeMap<String, Vec<&Row>> = BTreeMap::new();
    for r in all { groups.entry(key(r)).or_default().push(r); }
    let out: Vec<Value> = groups.into_iter().map(|(k, rs)| {
        let mut wall: Vec<i64> = rs.iter().filter_map(|r| r.wall_ms).collect();
        wall.sort_unstable();
        let mut first: Vec<i64> = rs.iter().filter_map(|r| r.first_output_ms).collect();
        first.sort_unstable();
        let rated: Vec<i64> = rs.iter().filter_map(|r| r.rating).collect();
        let checked: Vec<bool> = rs.iter().filter_map(|r| r.check_ok).collect();
        let cost = |billing: &str| rs.iter().filter(|r| r.billing.as_deref() == Some(billing)).filter_map(|r| r.cost_usd).fold(0.0, |a, b| a + b);
        json!({
            "key": k,
            "runs": rs.len(),
            "completed": rs.iter().filter(|r| r.outcome.as_deref() == Some("completed")).count(),
            "failed": rs.iter().filter(|r| r.outcome.as_deref() == Some("failed")).count(),
            "checked": checked.len(),
            "checkPassed": checked.iter().filter(|c| **c).count(),
            "wallMedian": quantile(&wall, 0.5),
            "wallP90": quantile(&wall, 0.9),
            "firstOutputMedian": quantile(&first, 0.5),
            "requests": rs.iter().map(|r| r.requests).sum::<i64>(),
            "input": rs.iter().map(|r| r.input).sum::<i64>(),
            "output": rs.iter().map(|r| r.output).sum::<i64>(),
            "cacheRead": rs.iter().map(|r| r.cache_read).sum::<i64>(),
            "cacheWrite": rs.iter().map(|r| r.cache_write).sum::<i64>(),
            "costApi": cost("api"),
            "costSubscription": cost("subscription"),
            "costAll": rs.iter().filter_map(|r| r.cost_usd).fold(0.0, |a, b| a + b),
            "rated": rated.len(),
            "ratingMean": if rated.is_empty() { None } else { Some(rated.iter().sum::<i64>() as f64 / rated.len() as f64) },
            "toolFailures": rs.iter().map(|r| r.tool_failures).sum::<i64>(),
        })
    }).collect();
    json!({ "by": by, "groups": out, "rows": all.len(), "capped": all.len() as i64 == SUMMARY_ROWS, "pricesAsOf": prices::AS_OF })
}

/// A note's text, trimmed, if it's one.
pub fn check_note(text: &str) -> Result<&str, String> {
    let text = text.trim();
    if text.is_empty() { return Err("a note says something".into()); }
    if text.len() > 20_000 { return Err("a note of at most 20000 characters".into()); }
    Ok(text)
}

/// Appends an admin's (`by`, an account's id) note to run `id`; false when there's no such run.
pub fn note(conn: &Connection, store: &Store, id: &str, by: &str, text: &str) -> Result<bool, String> {
    let Some((mut s, rel)) = index::load(conn, id).map_err(|e| e.to_string())? else { return Ok(false) };
    let note = json!({"v": 1, "run": id, "seq": s.server_seq, "type": "note", "by": by, "at": now_iso(), "text": text});
    s.server_seq -= 1;
    s.fold(&note);
    store.append(&rel, &[note]).map_err(|e| e.to_string())?;
    index::save(conn, id, &rel, &s).map_err(|e| e.to_string())?;
    Ok(true)
}

pub fn routes() -> Router<AppState> {
    Router::new().route("/runs/{id}/rating", post(rate))
}
