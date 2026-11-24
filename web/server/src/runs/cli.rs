//! `thia-server admin runs …`: the record of agent runs read from a terminal, by an admin or an agent investigating
//! runs (`.claude/skills/runs/SKILL.md`). It reads the data folder directly, so it runs where that is: on the box over
//! ssh, or locally on `server-data/`. Everything but `note` only reads.

use std::io::Write;

use clap::{Args, Subcommand};
use regex::Regex;
use serde_json::{Value, json};

use super::{Filter, Row, Runs, SUMMARY_ROWS, index, read};
use crate::db::Db;

#[derive(Args, Default)]
pub struct Which {
    /// from this day or time on (`2026-11-16`), or the last N days (`7d`)
    #[arg(long)]
    since: Option<String>,
    /// before this day or time
    #[arg(long)]
    until: Option<String>,
    /// the backend's id: claude-cli, ollama, gemini, server
    #[arg(long)]
    backend: Option<String>,
    #[arg(long)]
    app_commit: Option<String>,
    #[arg(long)]
    server_commit: Option<String>,
    #[arg(long)]
    bridge_commit: Option<String>,
    #[arg(long)]
    provider_version: Option<String>,
    /// a model, or part of its name
    #[arg(long)]
    model: Option<String>,
    #[arg(long)]
    kind: Option<String>,
    /// turn, or complete (a one-off answer)
    #[arg(long)]
    purpose: Option<String>,
    /// completed, failed, stopped
    #[arg(long)]
    outcome: Option<String>,
    /// yes or no
    #[arg(long)]
    rated: Option<String>,
    /// the latest rating at least this
    #[arg(long)]
    rating_min: Option<i64>,
    /// the latest rating at most this
    #[arg(long)]
    rating_max: Option<i64>,
    #[arg(long)]
    draft: Option<String>,
}

#[derive(Subcommand)]
pub enum Command {
    /// The runs, newest first, a line each
    List {
        #[command(flatten)]
        which: Which,
        #[arg(long, default_value_t = 50)]
        limit: i64,
        /// the index's rows as JSON
        #[arg(long)]
        json: bool,
    },
    /// The runs summed by backend, model, kind, purpose, day, draft, a component commit or provider version
    Summary {
        #[command(flatten)]
        which: Which,
        #[arg(long, default_value = "backend")]
        by: String,
        #[arg(long)]
        json: bool,
    },
    /// One run without its raw stream: its facts, what it was sent, its timeline
    Show {
        id: String,
        /// long texts whole
        #[arg(long)]
        full: bool,
    },
    /// What a run changed, as a unified diff against what it was sent
    Diff { id: String, path: Option<String> },
    /// A run's raw stream (the backend's provider, as it came), a line per message
    Stream {
        id: String,
        /// only the lines this regex finds
        #[arg(long)]
        grep: Option<String>,
        /// lines whole
        #[arg(long)]
        full: bool,
    },
    /// A blob's bytes, as kept
    Blob { sha: String },
    /// Writes a note on a run, as the admin with this email (best on a run that's over)
    Note {
        id: String,
        #[arg(long)]
        by: String,
        text: String,
    },
}

/// `7d`: that many days back from `now_ms`, as an ISO time; anything else as it is.
fn since(s: &str, now_ms: i64) -> String {
    match s.strip_suffix('d').and_then(|n| n.parse::<i64>().ok()) {
        Some(days) => gestalts_core::iso_datetime(now_ms - days * 86_400_000),
        None => s.to_owned(),
    }
}

impl Which {
    fn filter(self) -> Filter {
        Filter {
            since: self.since.map(|s| since(&s, crate::now_ms())),
            until: self.until,
            backend: self.backend,
            app_commit: self.app_commit,
            server_commit: self.server_commit,
            bridge_commit: self.bridge_commit,
            provider_version: self.provider_version,
            model: self.model,
            kind: self.kind,
            purpose: self.purpose,
            outcome: self.outcome,
            rated: self.rated,
            rating_min: self.rating_min,
            rating_max: self.rating_max,
            draft: self.draft,
            ..Filter::default()
        }
    }
}

fn line(r: &Row) -> String {
    let o = |v: &Option<String>| v.clone().unwrap_or_else(|| "—".into());
    let wall = r.wall_ms.map_or("—".into(), |w| format!("{:.0}s", w as f64 / 1000.0));
    let check = match r.check_ok { Some(true) => "check ok", Some(false) => "check FAILED", None => "unchecked" };
    let rating = r.rating.map_or("unrated".into(), |n| format!("rated {n}"));
    let comment = r.comment.as_deref().map(|c| {
        let c: String = c.chars().take(80).collect::<String>().replace('\n', " ");
        format!(" \"{c}\"")
    }).unwrap_or_default();
    format!("{}  {}  {}  {}  {}  {wall}  tools {}/{} failed  {check}  {}{comment}  draft {}{}",
        r.id, &r.started[..r.started.len().min(16)], o(&r.backend), o(&r.models), o(&r.outcome), r.tools, r.tool_failures, rating, o(&r.draft),
        if r.notes > 0 { format!("  notes {}", r.notes) } else { String::new() })
}

/// Runs `cmd` on the runs under `data`, writing what it reads to `out`.
pub fn run(db: &Db, data: &std::path::Path, cmd: Command, out: &mut impl Write) -> Result<(), String> {
    let runs = db.with(|c| Ok(Runs::open(c, data.join("runs"), false))).map_err(|e| e.to_string())??;
    let store = &runs.store;
    let w = |out: &mut dyn Write, s: &str| out.write_all(s.as_bytes()).map_err(|e| e.to_string());
    let load = |id: &str| -> Result<(Row, index::Summary, Vec<Value>), String> {
        let (summary, rel) = db.with(|c| index::load(c, id)).map_err(|e| e.to_string())?.ok_or(format!("no run {id}"))?;
        let row = db.with(|c| super::row_of(c, id)).map_err(|e| e.to_string())?.ok_or(format!("no run {id}"))?;
        Ok((row, summary, store.read(&rel).map_err(|e| e.to_string())?))
    };
    match cmd {
        Command::List { which, limit, json } => {
            let found = db.with(|c| super::rows(c, &which.filter(), limit.clamp(1, SUMMARY_ROWS), false)).map_err(|e| e.to_string())?;
            if json {
                w(out, &format!("{}\n", serde_json::to_string_pretty(&found).unwrap_or_default()))?;
            } else {
                for r in &found { w(out, &format!("{}\n", line(r)))?; }
                w(out, &format!("{} run(s){}\n", found.len(), if found.len() as i64 == limit { " (more with --limit)" } else { "" }))?;
            }
        }
        Command::Summary { which, by, json } => {
            let all = db.with(|c| super::rows(c, &which.filter(), SUMMARY_ROWS, false)).map_err(|e| e.to_string())?;
            let sum = super::summarize(&all, &by);
            if json {
                w(out, &format!("{}\n", serde_json::to_string_pretty(&sum).unwrap_or_default()))?;
            } else {
                for g in sum["groups"].as_array().into_iter().flatten() {
                    let n = |k: &str| g[k].as_i64().unwrap_or(0);
                    let mean = g["ratingMean"].as_f64().map_or("—".into(), |m| format!("{m:.1}"));
                    let secs = |k: &str| g[k].as_i64().map_or("—".into(), |v| format!("{:.0}s", v as f64 / 1000.0));
                    w(out, &format!("{}: {} runs, {} completed, {} failed, check {}/{}, wall median {} p90 {}, rating {mean} ({} rated), tool failures {}, cost ${:.2}\n",
                        g["key"].as_str().unwrap_or("—"), n("runs"), n("completed"), n("failed"), n("checkPassed"), n("checked"),
                        secs("wallMedian"), secs("wallP90"), n("rated"), n("toolFailures"), g["costAll"].as_f64().unwrap_or(0.0)))?;
                }
                if sum["capped"] == json!(true) { w(out, &format!("(only the newest {SUMMARY_ROWS} runs)\n"))?; }
            }
        }
        Command::Show { id, full } => {
            let (row, summary, lines) = load(&id)?;
            w(out, &read::show(store, &row, summary.backend_label.as_deref(), &lines, full))?;
        }
        Command::Diff { id, path } => {
            let (_, _, lines) = load(&id)?;
            w(out, &read::diff(store, &lines, path.as_deref()))?;
        }
        Command::Stream { id, grep, full } => {
            let re = grep.map(|g| Regex::new(&g).map_err(|e| e.to_string())).transpose()?;
            let (_, _, lines) = load(&id)?;
            w(out, &read::stream(store, &lines, re.as_ref(), full))?;
        }
        Command::Blob { sha } => {
            let b = store.blob(&sha).ok_or(format!("no blob {sha}"))?;
            out.write_all(&b).map_err(|e| e.to_string())?;
        }
        Command::Note { id, by, text } => {
            let text = super::check_note(&text)?;
            let (admin, _) = db.account_by_email(&by.trim().to_lowercase()).map_err(|e| e.to_string())?.ok_or(format!("no account {by}"))?;
            if !admin.admin { return Err(format!("{by} isn't an admin")); }
            if !db.with(|c| Ok(super::note(c, store, &id, &admin.id, text))).map_err(|e| e.to_string())?? { return Err(format!("no run {id}")); }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn since_takes_days_or_a_time() {
        assert_eq!(super::since("7d", 7 * 86_400_000), gestalts_core::iso_datetime(0));
        assert_eq!(super::since("2026-11-16", 0), "2026-11-16");
    }
}
