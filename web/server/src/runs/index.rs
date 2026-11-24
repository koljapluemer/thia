//! The index of runs: one row per run, folded from its record's lines, for listing and summing them. It is derived,
//! never the truth: the records are (`store.rs`). When what's derived changes (a column, how a total is counted, a
//! price), [`VERSION`] goes up, and the server rebuilds the index from the records when it starts.

use std::collections::BTreeSet;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::prices;

/// What the index holds and how it's counted; a change rebuilds it.
pub const VERSION: &str = "2";

pub const SCHEMA: &str = r"
    DROP TABLE IF EXISTS runs;
    CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        account TEXT NOT NULL,
        path TEXT NOT NULL,
        started TEXT NOT NULL,
        last_at TEXT,
        draft TEXT,
        kind TEXT,
        purpose TEXT,
        backend TEXT,
        app_commit TEXT,
        app_build TEXT,
        server_commit TEXT,
        server_build TEXT,
        bridge_commit TEXT,
        bridge_version TEXT,
        provider_version TEXT,
        models TEXT,
        billing TEXT,
        outcome TEXT,
        waiting INTEGER NOT NULL DEFAULT 0,
        wall_ms INTEGER,
        first_output_ms INTEGER,
        requests INTEGER NOT NULL DEFAULT 0,
        input INTEGER NOT NULL DEFAULT 0,
        output INTEGER NOT NULL DEFAULT 0,
        cache_read INTEGER NOT NULL DEFAULT 0,
        cache_write INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL,
        tools INTEGER NOT NULL DEFAULT 0,
        tool_failures INTEGER NOT NULL DEFAULT 0,
        check_ok INTEGER,
        files_changed INTEGER NOT NULL DEFAULT 0,
        errors INTEGER NOT NULL DEFAULT 0,
        rating INTEGER,
        comment TEXT,
        notes INTEGER NOT NULL DEFAULT 0,
        summary TEXT NOT NULL
    );
    CREATE INDEX runs_by_started ON runs(started DESC, id DESC);
    CREATE TABLE IF NOT EXISTS runs_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
";

/// Everything the index knows of one run, kept as JSON beside the columns so each batch folds on from where it was.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Summary {
    pub account: String,
    pub started: Option<String>,
    pub last_at: Option<String>,
    pub draft: Option<String>,
    pub kind: Option<String>,
    pub purpose: Option<String>,
    pub backend: Option<String>,
    pub backend_label: Option<String>,
    pub app_commit: Option<String>,
    pub app_build: Option<String>,
    pub server_commit: Option<String>,
    pub server_build: Option<String>,
    pub bridge_commit: Option<String>,
    pub bridge_version: Option<String>,
    pub provider_version: Option<String>,
    pub models: BTreeSet<String>,
    pub billing: BTreeSet<String>,
    pub outcome: Option<String>,
    pub waiting: bool,
    pub wall_ms: Option<i64>,
    pub first_output_ms: Option<i64>,
    pub events: i64,
    pub requests: i64,
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub reasoning: i64,
    /// what the priced requests cost, API and notional (a subscription's) alike; `cost_api` is what was paid
    pub cost_usd: f64,
    pub cost_api: f64,
    /// requests with tokens but no price (a model unknown to `prices.rs`)
    pub unpriced: i64,
    pub tools: i64,
    pub tool_failures: i64,
    pub throttles: i64,
    /// the last check's (`tool_result` named check, or `settled`): at which seq, and whether it passed
    pub check: Option<(i64, bool)>,
    pub files_changed: i64,
    pub errors: i64,
    /// the latest rating: at which seq, the score, the comment
    pub rating: Option<(i64, i64, Option<String>)>,
    pub notes: i64,
    /// the page's seqs already kept, as ranges: a batch sent again is dropped, one out of order is kept
    pub seen: Vec<(i64, i64)>,
    /// the next seq for a line the server writes itself (an owner, a note): below zero, apart from the page's
    pub server_seq: i64,
}

impl Summary {
    /// Whether `seq` is new; marks it seen.
    pub fn first_time(&mut self, seq: i64) -> bool {
        if self.seen.iter().any(|&(a, b)| a <= seq && seq <= b) { return false; }
        self.seen.push((seq, seq));
        self.seen.sort_unstable();
        let mut merged: Vec<(i64, i64)> = Vec::with_capacity(self.seen.len());
        for &(a, b) in &self.seen {
            match merged.last_mut() {
                Some(last) if a <= last.1 + 1 => last.1 = last.1.max(b),
                _ => merged.push((a, b)),
            }
        }
        self.seen = merged;
        true
    }

    /// Folds one line of the record in. Unknown types and missing fields are fine: they count as an event and no more.
    pub fn fold(&mut self, e: &Value) {
        let s = |k: &str| e.get(k).and_then(Value::as_str).map(str::to_owned);
        let n = |k: &str| e.get(k).and_then(Value::as_i64).unwrap_or(0);
        let seq = e.get("seq").and_then(Value::as_i64).unwrap_or(0);
        let ms = e.get("ms").and_then(Value::as_i64);
        self.events += 1;
        if let Some(at) = s("at") {
            if self.started.as_deref().is_none_or(|x| at.as_str() < x) && e.get("by").is_none() { self.started = Some(at.clone()); }
            if self.last_at.as_deref().is_none_or(|x| at.as_str() > x) { self.last_at = Some(at); }
        }
        if let Some(ms) = ms && e.get("by").is_none() { self.wall_ms = Some(self.wall_ms.map_or(ms, |w| w.max(ms))); }
        let ty = e.get("type").and_then(Value::as_str).unwrap_or("");
        match ty {
            "owner" => {
                if let Some(a) = s("account") { self.account = a; }
                self.fold_provenance(e.get("provenance"));
            }
            "start" => {
                if let Some(at) = s("at") { self.started = Some(at); }
                self.draft = s("draft").or(self.draft.take());
                self.kind = s("kind").or(self.kind.take());
                self.purpose = s("purpose").or(self.purpose.take());
                if let Some(b) = e.get("backend") {
                    self.backend = b.get("id").and_then(Value::as_str).map(str::to_owned).or(self.backend.take());
                    self.backend_label = b.get("label").and_then(Value::as_str).map(str::to_owned).or(self.backend_label.take());
                }
                self.fold_provenance(e.get("provenance"));
            }
            "provenance" => self.fold_provenance(e.get("provenance")),
            "text" | "tool" | "files" | "ask" => {
                if let Some(ms) = ms { self.first_output_ms = Some(self.first_output_ms.map_or(ms, |f| f.min(ms))); }
                if ty == "tool" { self.tools += 1; }
                if ty == "files" { self.files_changed += e.get("files").and_then(Value::as_object).map_or(0, |f| f.len() as i64); }
            }
            "usage" => {
                self.requests += 1;
                let (input, output, read, write) = (n("input"), n("output"), n("cacheRead"), n("cacheWrite"));
                self.input += input;
                self.output += output;
                self.cache_read += read;
                self.cache_write += write;
                self.reasoning += n("reasoning");
                let model = s("model");
                if let Some(m) = &model { self.models.insert(m.clone()); }
                let billing = s("billing").unwrap_or_else(|| "unknown".into());
                self.billing.insert(billing.clone());
                let cost = match e.get("costUsd").and_then(Value::as_f64) {
                    Some(c) => Some(c),
                    None if billing == "free" => Some(0.0),
                    None => model.as_deref().and_then(|m| prices::cost(m, input, output, read, write)),
                };
                match cost {
                    Some(c) => {
                        self.cost_usd += c;
                        if billing == "api" { self.cost_api += c; }
                    }
                    None if input + output + read + write > 0 => self.unpriced += 1,
                    None => {}
                }
            }
            "tool_result" => {
                let ok = e.get("ok").and_then(Value::as_bool).unwrap_or(true);
                if !ok { self.tool_failures += 1; }
                if s("name").as_deref() == Some("check") { self.set_check(seq, ok); }
            }
            "settled" => self.set_check(seq, e.get("ok").and_then(Value::as_bool).unwrap_or(false)),
            "throttle" => self.throttles += 1,
            "error" => self.errors += 1,
            "done" => {
                if e.get("waiting").and_then(Value::as_bool) == Some(true) { self.waiting = true; }
                if self.outcome.is_none() && let Some(o) = s("outcome") { self.outcome = Some(o); }
            }
            "end" => {
                if let Some(o) = s("outcome") { self.outcome = Some(o); }
                if e.get("waiting").and_then(Value::as_bool) == Some(true) { self.waiting = true; }
            }
            "rating" => {
                if let Some(score) = e.get("score").and_then(Value::as_i64)
                    && self.rating.as_ref().is_none_or(|r| seq >= r.0) {
                    self.rating = Some((seq, score, s("comment")));
                }
            }
            "note" => self.notes += 1,
            _ => {}
        }
    }

    fn fold_provenance(&mut self, provenance: Option<&Value>) {
        let text = |component: &str, field: &str| provenance?.get(component)?.get(field)?.as_str().map(str::to_owned);
        if let Some(v) = text("app", "commit") { self.app_commit = Some(v); }
        if let Some(v) = text("app", "tag") { self.app_build = Some(v); }
        if let Some(v) = text("server", "commit") { self.server_commit = Some(v); }
        if let Some(v) = text("server", "tag") { self.server_build = Some(v); }
        if let Some(v) = text("bridge", "commit") { self.bridge_commit = Some(v); }
        if let Some(v) = text("bridge", "version") { self.bridge_version = Some(v); }
        if let Some(v) = text("provider", "version") { self.provider_version = Some(v); }
    }

    fn set_check(&mut self, seq: i64, ok: bool) {
        if self.check.is_none_or(|(at, _)| seq >= at) { self.check = Some((seq, ok)); }
    }

    fn priced(&self) -> Option<f64> {
        if self.requests == 0 || self.unpriced == self.requests { None } else { Some(self.cost_usd) }
    }
}

/// The summary kept for `id`, with its record's path.
pub fn load(conn: &Connection, id: &str) -> rusqlite::Result<Option<(Summary, String)>> {
    conn.query_row("SELECT summary, path FROM runs WHERE id = ?1", [id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .optional()
        .map(|o| o.map(|(s, p)| (serde_json::from_str(&s).unwrap_or_default(), p)))
}

pub fn save(conn: &Connection, id: &str, path: &str, s: &Summary) -> rusqlite::Result<()> {
    let join = |set: &BTreeSet<String>| if set.is_empty() { None } else { Some(set.iter().cloned().collect::<Vec<_>>().join(", ")) };
    conn.execute(
        "INSERT OR REPLACE INTO runs (id, account, path, started, last_at, draft, kind, purpose, backend,
            app_commit, app_build, server_commit, server_build, bridge_commit, bridge_version, provider_version, models, billing, outcome, waiting,
            wall_ms, first_output_ms, requests, input, output, cache_read, cache_write, cost_usd, tools, tool_failures, check_ok,
            files_changed, errors, rating, comment, notes, summary)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,
            ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32, ?33, ?34, ?35, ?36, ?37)",
        params![
            id, s.account, path, s.started.clone().unwrap_or_default(), s.last_at, s.draft, s.kind, s.purpose, s.backend,
            s.app_commit, s.app_build, s.server_commit, s.server_build, s.bridge_commit, s.bridge_version, s.provider_version,
            join(&s.models), join(&s.billing), s.outcome, s.waiting, s.wall_ms, s.first_output_ms, s.requests, s.input, s.output,
            s.cache_read, s.cache_write, s.priced(), s.tools, s.tool_failures, s.check.map(|c| c.1), s.files_changed, s.errors,
            s.rating.as_ref().map(|r| r.1), s.rating.as_ref().and_then(|r| r.2.clone()), s.notes,
            serde_json::to_string(s).unwrap_or_default(),
        ],
    )
    .map(drop)
}

/// Whether the index is of [`VERSION`]; else it's made anew and empty, to be filled from the records.
pub fn ensure(conn: &Connection) -> rusqlite::Result<bool> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS runs_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);")?;
    let v: Option<String> = conn.query_row("SELECT value FROM runs_meta WHERE key = 'version'", [], |r| r.get(0)).optional()?;
    if v.as_deref() == Some(VERSION) { return Ok(true); }
    conn.execute_batch(SCHEMA)?;
    conn.execute("INSERT OR REPLACE INTO runs_meta (key, value) VALUES ('version', ?1)", [VERSION])?;
    Ok(false)
}

/// Makes the index anew, empty.
pub fn clear(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(SCHEMA)?;
    conn.execute("INSERT OR REPLACE INTO runs_meta (key, value) VALUES ('version', ?1)", [VERSION]).map(drop)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn folds_what_it_knows_and_counts_the_rest() {
        let mut s = Summary::default();
        for e in [
            json!({"type": "start", "seq": 0, "ms": 0, "at": "2026-11-23T10:00:00Z", "draft": "d", "kind": "view", "purpose": "turn",
                "backend": {"id": "cli", "label": "Claude"}, "provenance": {"app": {"commit": "app1", "tag": "deploy1"}}}),
            json!({"type": "owner", "seq": -1, "by": "server", "provenance": {"server": {"commit": "server1", "tag": "deploy1"}}}),
            json!({"type": "provenance", "seq": 10, "provenance": {"bridge": {"commit": "bridge1", "version": "0.1.0"}, "provider": {"version": "cli 2"}}}),
            json!({"type": "usage", "seq": 1, "ms": 900, "model": "claude-opus-5-5", "input": 1_000_000, "billing": "subscription"}),
            json!({"type": "text", "seq": 2, "ms": 1000}),
            json!({"type": "something-new", "seq": 3, "ms": 1100, "whatever": [1, 2]}),
            json!({"type": "tool_result", "seq": 4, "ms": 1200, "name": "check", "ok": false}),
            json!({"type": "usage", "seq": 5, "model": "qwen3.5:9b", "input": 10, "billing": "free"}),
            json!({"type": "usage", "seq": 6, "model": "unknown-model", "input": 10}),
            json!({"type": "end", "seq": 7, "ms": 2000, "outcome": "completed"}),
            json!({"type": "rating", "seq": 9, "score": 2}),
            json!({"type": "rating", "seq": 8, "score": 5}),
        ] { s.fold(&e); }
        assert_eq!((s.events, s.requests, s.input), (12, 3, 1_000_020));
        assert_eq!((s.cost_usd, s.cost_api, s.unpriced), (4.0, 0.0, 1));
        assert_eq!((s.first_output_ms, s.wall_ms, s.outcome.as_deref()), (Some(1000), Some(2000), Some("completed")));
        assert_eq!((s.check, s.tool_failures), (Some((4, false)), 1));
        assert_eq!(s.rating, Some((9, 2, None)));
        assert_eq!(s.backend.as_deref(), Some("cli"));
        assert_eq!((s.app_commit.as_deref(), s.server_commit.as_deref(), s.bridge_commit.as_deref(), s.provider_version.as_deref()),
            (Some("app1"), Some("server1"), Some("bridge1"), Some("cli 2")));
    }

    #[test]
    fn a_seq_counts_once_in_any_order() {
        let mut s = Summary::default();
        assert!(s.first_time(2) && s.first_time(0) && s.first_time(1));
        assert!(!s.first_time(1));
        assert_eq!(s.seen, vec![(0, 2)]);
        assert!(s.first_time(5));
        assert_eq!(s.seen, vec![(0, 2), (5, 5)]);
    }
}
