//! The record of agent runs (`web/app/doc/workshop/runs.md`): every turn of any backend, as the page saw it, kept
//! here for admins to read. The page sends each run's events as they come and the contents they name as blobs; the
//! server appends them to the run's record, untouched but for who sent them, and folds them into the index.
//!
//! - `POST /api/runs/{id}/events` `[envelope…]` (signed in): appends what's new of them
//! - `POST /api/runs/blobs/missing` `[sha…]` → the ones not kept yet; `PUT /api/runs/blobs/{sha}` keeps one
//! - admins: `GET /api/admin/runs` (a page of the index, filtered), `…/summary` (grouped), `…/facets`, `…/{id}` (its
//!   events, in pages), `…/blobs/{sha}`, `POST …/{id}/notes`, `GET …/{id}/export` (a zip of its record and blobs)

pub mod index;
pub mod prices;
pub mod store;

use std::collections::{BTreeMap, BTreeSet};

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::auth::{Admin, SignedIn};
use crate::{ApiError, ApiResult, AppState, now_iso};
use index::Summary;
use store::{Store, is_run_id, is_sha};

/// at most this many events in one batch
const MAX_BATCH: usize = 5000;
const MAX_BATCH_BYTES: usize = 16 * 1024 * 1024;
const MAX_BLOB: usize = 64 * 1024 * 1024;
/// at most this many runs' rows are summed for one summary
const SUMMARY_ROWS: i64 = 10_000;

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

/// What the page may send: an event of the run it names, of its own kind (`owner` and `note` are the server's).
fn check_event(id: &str, e: &Value) -> Result<i64, String> {
    let o = e.as_object().ok_or("an event is an object")?;
    if o.get("v").and_then(Value::as_i64) != Some(1) { return Err("v: 1".into()); }
    if o.get("run").and_then(Value::as_str) != Some(id) { return Err("run: the run's id".into()); }
    let seq = o.get("seq").and_then(Value::as_i64).filter(|s| *s >= 0).ok_or("seq: 0 or more")?;
    let ty = o.get("type").and_then(Value::as_str).ok_or("type: a string")?;
    if matches!(ty, "owner" | "note") || o.contains_key("by") { return Err(format!("{ty}: not the page's to write")); }
    if o.get("at").and_then(Value::as_str).is_none() { return Err("at: when".into()); }
    Ok(seq)
}

async fn append(State(state): State<AppState>, me: SignedIn, Path(id): Path<String>, Json(events): Json<Vec<Value>>) -> ApiResult<Json<Value>> {
    if !is_run_id(&id) { return Err(ApiError::BadRequest("a run's id: 16 to 64 lowercase letters and digits".into())); }
    if events.len() > MAX_BATCH { return Err(ApiError::TooLarge(format!("at most {MAX_BATCH} events at once"))); }
    let mut seqs = Vec::with_capacity(events.len());
    for e in &events { seqs.push(check_event(&id, e).map_err(ApiError::BadRequest)?); }
    let _w = state.runs.writes.lock().await;
    let existing = state.db.with(|c| index::load(c, &id))?;
    let (mut summary, rel, mut lines) = match existing {
        Some((s, rel)) => {
            if s.account != me.0.id { return Err(ApiError::NotFound); }
            (s, rel, vec![])
        }
        None => {
            // a draft a run names is the account's own
            if let Some(draft) = events.iter().find(|e| e["type"] == "start").and_then(|e| e["draft"].as_str())
                && state.db.draft(draft, &me.0.id)?.is_none() && state.db.draft_exists(draft)? {
                return Err(ApiError::Forbidden);
            }
            let day = events.iter().filter_map(|e| e["at"].as_str()).min().map_or_else(now_iso, str::to_owned);
            let day = if day.len() >= 10 && day.as_bytes()[4] == b'-' { day[..10].to_owned() } else { now_iso()[..10].to_owned() };
            let mut s = Summary::default();
            let owner = json!({"v": 1, "run": id, "seq": -1, "type": "owner", "by": "server", "at": now_iso(), "account": me.0.id});
            s.server_seq = -2;
            s.fold(&owner);
            (s, Store::new_path(&id, &day), vec![owner])
        }
    };
    let mut accepted = 0;
    for (e, seq) in events.into_iter().zip(seqs) {
        if !summary.first_time(seq) { continue; }
        summary.fold(&e);
        lines.push(e);
        accepted += 1;
    }
    if !lines.is_empty() {
        let store = &state.runs.store;
        store.append(&rel, &lines).map_err(io)?;
        state.db.with(|c| index::save(c, &id, &rel, &summary))?;
    }
    Ok(Json(json!({ "accepted": accepted })))
}

async fn missing(State(state): State<AppState>, _me: SignedIn, Json(shas): Json<Vec<String>>) -> ApiResult<Json<Vec<String>>> {
    if shas.len() > MAX_BATCH { return Err(ApiError::TooLarge(format!("at most {MAX_BATCH} at once"))); }
    Ok(Json(shas.into_iter().filter(|s| is_sha(s) && !state.runs.store.has_blob(s)).collect()))
}

async fn put_blob(State(state): State<AppState>, _me: SignedIn, Path(sha): Path<String>, body: Bytes) -> ApiResult<StatusCode> {
    if !is_sha(&sha) { return Err(ApiError::BadRequest("a blob's name is its sha256, in lowercase hex".into())); }
    state.runs.store.put_blob(&sha, &body).map_err(ApiError::BadRequest)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Filter {
    since: Option<String>,
    until: Option<String>,
    backend: Option<String>,
    model: Option<String>,
    kind: Option<String>,
    purpose: Option<String>,
    outcome: Option<String>,
    /// `yes` or `no`
    rated: Option<String>,
    draft: Option<String>,
    /// a page after this one: `<started>|<id>` of the last row seen
    before: Option<String>,
    limit: Option<i64>,
    by: Option<String>,
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
        (w.join(" AND "), p)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Row {
    id: String,
    account: String,
    started: String,
    last_at: Option<String>,
    draft: Option<String>,
    kind: Option<String>,
    purpose: Option<String>,
    backend: Option<String>,
    models: Option<String>,
    billing: Option<String>,
    outcome: Option<String>,
    waiting: bool,
    wall_ms: Option<i64>,
    first_output_ms: Option<i64>,
    requests: i64,
    input: i64,
    output: i64,
    cache_read: i64,
    cache_write: i64,
    cost_usd: Option<f64>,
    tools: i64,
    tool_failures: i64,
    check_ok: Option<bool>,
    files_changed: i64,
    errors: i64,
    rating: Option<i64>,
    comment: Option<String>,
    notes: i64,
}

const COLUMNS: &str = "id, account, started, last_at, draft, kind, purpose, backend, models, billing, outcome, waiting, wall_ms,
    first_output_ms, requests, input, output, cache_read, cache_write, cost_usd, tools, tool_failures, check_ok, files_changed,
    errors, rating, comment, notes";

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Row> {
    Ok(Row {
        id: r.get(0)?, account: r.get(1)?, started: r.get(2)?, last_at: r.get(3)?, draft: r.get(4)?, kind: r.get(5)?, purpose: r.get(6)?,
        backend: r.get(7)?, models: r.get(8)?, billing: r.get(9)?, outcome: r.get(10)?, waiting: r.get(11)?, wall_ms: r.get(12)?,
        first_output_ms: r.get(13)?, requests: r.get(14)?, input: r.get(15)?, output: r.get(16)?, cache_read: r.get(17)?,
        cache_write: r.get(18)?, cost_usd: r.get(19)?, tools: r.get(20)?, tool_failures: r.get(21)?, check_ok: r.get(22)?,
        files_changed: r.get(23)?, errors: r.get(24)?, rating: r.get(25)?, comment: r.get(26)?, notes: r.get(27)?,
    })
}

fn rows(conn: &Connection, f: &Filter, limit: i64, cursor: bool) -> rusqlite::Result<Vec<Row>> {
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

async fn list(State(state): State<AppState>, _admin: Admin, Query(f): Query<Filter>) -> ApiResult<Json<Value>> {
    let limit = f.limit.unwrap_or(50).clamp(1, 100);
    let found = state.db.with(|c| rows(c, &f, limit + 1, true))?;
    let more = found.len() as i64 > limit;
    let found: Vec<Row> = found.into_iter().take(limit as usize).collect();
    let next = if more { found.last().map(|r| format!("{}|{}", r.started, r.id)) } else { None };
    Ok(Json(json!({ "runs": found, "next": next, "pricesAsOf": prices::AS_OF })))
}

fn quantile(sorted: &[i64], q: f64) -> Option<i64> {
    if sorted.is_empty() { return None; }
    Some(sorted[((sorted.len() - 1) as f64 * q).round() as usize])
}

async fn summary(State(state): State<AppState>, _admin: Admin, Query(f): Query<Filter>) -> ApiResult<Json<Value>> {
    let all = state.db.with(|c| rows(c, &f, SUMMARY_ROWS, false))?;
    let by = f.by.as_deref().unwrap_or("backend");
    let key = |r: &Row| -> String {
        match by {
            "model" => r.models.clone(),
            "kind" => r.kind.clone(),
            "purpose" => r.purpose.clone(),
            "day" => Some(r.started.chars().take(10).collect()),
            "draft" => r.draft.clone(),
            _ => r.backend.clone(),
        }
        .unwrap_or_else(|| "—".into())
    };
    let mut groups: BTreeMap<String, Vec<&Row>> = BTreeMap::new();
    for r in &all { groups.entry(key(r)).or_default().push(r); }
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
    Ok(Json(json!({ "by": by, "groups": out, "rows": all.len(), "capped": all.len() as i64 == SUMMARY_ROWS, "pricesAsOf": prices::AS_OF })))
}

async fn facets(State(state): State<AppState>, _admin: Admin) -> ApiResult<Json<Value>> {
    let distinct = |c: &Connection, col: &str| -> rusqlite::Result<Vec<String>> {
        let mut st = c.prepare(&format!("SELECT DISTINCT {col} FROM runs WHERE {col} IS NOT NULL ORDER BY {col}"))?;
        st.query_map([], |r| r.get(0))?.collect()
    };
    let (backends, models, kinds, purposes, outcomes) = state.db.with(|c| -> rusqlite::Result<_> {
        Ok((distinct(c, "backend")?, distinct(c, "models")?, distinct(c, "kind")?, distinct(c, "purpose")?, distinct(c, "outcome")?))
    })?;
    // a run of several models lists them all: each model once
    let models: BTreeSet<String> = models.iter().flat_map(|m| m.split(", ").map(str::to_owned)).collect();
    Ok(Json(json!({ "backends": backends, "models": models, "kinds": kinds, "purposes": purposes, "outcomes": outcomes })))
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct EventsQuery {
    after: Option<i64>,
    limit: Option<usize>,
    /// `only`: the backend's raw stream alone; otherwise everything but it
    trace: Option<String>,
}

async fn detail(State(state): State<AppState>, _admin: Admin, Path(id): Path<String>, Query(q): Query<EventsQuery>) -> ApiResult<Json<Value>> {
    let (summary, rel) = state.db.with(|c| index::load(c, &id))?.ok_or(ApiError::NotFound)?;
    let only_trace = q.trace.as_deref() == Some("only");
    let mut events = state.runs.store.read(&rel).map_err(io)?;
    events.retain(|e| (e["type"] == "trace") == only_trace);
    // the page's in its order, then what the server wrote (owner, notes) by when
    events.sort_by(|a, b| {
        let (sa, sb) = (a["seq"].as_i64().unwrap_or(0), b["seq"].as_i64().unwrap_or(0));
        (sa < 0).cmp(&(sb < 0)).then(if sa < 0 { a["at"].as_str().cmp(&b["at"].as_str()) } else { sa.cmp(&sb) })
    });
    // what the server wrote (seq below zero) comes with the first page
    let first = q.after.is_none();
    let after = q.after.unwrap_or(-1);
    let limit = q.limit.unwrap_or(500).clamp(1, 2000);
    let (mut page, mut server, mut next) = (vec![], vec![], None);
    for e in events {
        let seq = e["seq"].as_i64().unwrap_or(0);
        if seq < 0 { if first { server.push(e); } continue; }
        if seq <= after { continue; }
        if page.len() == limit { next = page.last().and_then(|l: &Value| l["seq"].as_i64()); break; }
        page.push(e);
    }
    page.extend(server);
    let row = state.db.with(|c| c.query_row(&format!("SELECT {COLUMNS} FROM runs WHERE id = ?1"), [&id], row))?;
    Ok(Json(json!({ "run": row, "backendLabel": summary.backend_label, "throttles": summary.throttles, "reasoning": summary.reasoning, "unpriced": summary.unpriced, "events": page, "next": next })))
}

async fn get_blob(State(state): State<AppState>, _admin: Admin, Path(sha): Path<String>) -> ApiResult<Response> {
    if !is_sha(&sha) { return Err(ApiError::NotFound); }
    let bytes = state.runs.store.blob(&sha).ok_or(ApiError::NotFound)?;
    Ok(([(header::CONTENT_TYPE, "application/octet-stream"), (header::CACHE_CONTROL, "private, max-age=31536000, immutable")], bytes).into_response())
}

#[derive(Deserialize)]
struct Note {
    text: String,
}

async fn add_note(State(state): State<AppState>, admin: Admin, Path(id): Path<String>, Json(n): Json<Note>) -> ApiResult<StatusCode> {
    let text = n.text.trim();
    if text.is_empty() { return Err(ApiError::BadRequest("a note says something".into())); }
    if text.len() > 20_000 { return Err(ApiError::TooLarge("a note of at most 20000 characters".into())); }
    let _w = state.runs.writes.lock().await;
    let (mut s, rel) = state.db.with(|c| index::load(c, &id))?.ok_or(ApiError::NotFound)?;
    let note = json!({"v": 1, "run": id, "seq": s.server_seq, "type": "note", "by": admin.0.id, "at": now_iso(), "text": text});
    s.server_seq -= 1;
    s.fold(&note);
    state.runs.store.append(&rel, &[note]).map_err(io)?;
    state.db.with(|c| index::save(c, &id, &rel, &s))?;
    Ok(StatusCode::NO_CONTENT)
}

async fn export(State(state): State<AppState>, _admin: Admin, Path(id): Path<String>) -> ApiResult<Response> {
    let (_, rel) = state.db.with(|c| index::load(c, &id))?.ok_or(ApiError::NotFound)?;
    let lines = state.runs.store.read(&rel).map_err(io)?;
    let mut shas = BTreeSet::new();
    for l in &lines { store::blobs_in(l, &mut shas); }
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let zerr = |e: zip::result::ZipError| ApiError::Internal(e.to_string());
    zip.start_file(format!("{id}/run.jsonl"), options).map_err(zerr)?;
    for l in &lines { std::io::Write::write_all(&mut zip, format!("{l}\n").as_bytes()).map_err(io)?; }
    for sha in shas {
        if let Some(b) = state.runs.store.blob(&sha) {
            zip.start_file(format!("{id}/blobs/{sha}"), options).map_err(zerr)?;
            std::io::Write::write_all(&mut zip, &b).map_err(io)?;
        }
    }
    let bytes = zip.finish().map_err(zerr)?.into_inner();
    let disposition = format!("attachment; filename=\"run-{id}.zip\"");
    Ok(([(header::CONTENT_TYPE, "application/zip".to_owned()), (header::CONTENT_DISPOSITION, disposition)], bytes).into_response())
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/runs/{id}/events", post(append).layer(DefaultBodyLimit::max(MAX_BATCH_BYTES)))
        .route("/runs/blobs/missing", post(missing))
        .route("/runs/blobs/{sha}", put(put_blob).layer(DefaultBodyLimit::max(MAX_BLOB)))
        .route("/admin/runs", get(list))
        .route("/admin/runs/summary", get(summary))
        .route("/admin/runs/facets", get(facets))
        .route("/admin/runs/blobs/{sha}", get(get_blob))
        .route("/admin/runs/{id}", get(detail))
        .route("/admin/runs/{id}/notes", post(add_note))
        .route("/admin/runs/{id}/export", get(export))
}
