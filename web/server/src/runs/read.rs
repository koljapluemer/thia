//! A run as text, for reading it in a terminal (`thia-server admin runs`): what an agent investigating runs reads
//! instead of the record itself. `show` is the run without its raw stream, long texts cut and contents named rather
//! than inlined; `diff` is what it changed; `stream` is the raw stream, filtered.

use std::collections::BTreeMap;
use std::fmt::Write;

use regex::Regex;
use serde_json::Value;

use super::Row;
use super::store::Store;

/// How much of each kind of text `show` keeps, unless `full`.
const TEXT: usize = 600;
const RESULT: usize = 800;
const BRIEF: usize = 4000;
const OTHER: usize = 300;
const TRACE: usize = 400;

fn cut(s: &str, max: usize, full: bool) -> String {
    let s = s.trim();
    if full || s.chars().count() <= max { return s.to_owned(); }
    let kept: String = s.chars().take(max).collect();
    format!("{kept}… [{} more chars]", s.chars().count() - max)
}

/// A text, or the text of the blob it went to.
fn text_of(store: &Store, v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Object(m) => {
            let sha = m.get("$blob")?.as_str()?;
            Some(store.blob(sha).map_or_else(|| format!("[blob {sha} missing]"), |b| String::from_utf8_lossy(&b).into_owned()))
        }
        _ => None,
    }
}

fn s<'a>(e: &'a Value, k: &str) -> Option<&'a str> {
    e.get(k).and_then(Value::as_str)
}

fn secs(ms: i64) -> String {
    format!("{:.1}s", ms as f64 / 1000.0)
}

fn compact(v: &Value) -> String {
    serde_json::to_string(v).unwrap_or_default()
}

/// The facts of a run, from its index row.
fn facts(r: &Row, label: Option<&str>) -> String {
    let mut o = String::new();
    let opt = |v: &Option<String>| v.clone().unwrap_or_else(|| "—".into());
    let _ = writeln!(o, "run {}  started {}  account {}", r.id, r.started, r.account);
    let _ = writeln!(o, "backend {} ({})  models {}  billing {}", opt(&r.backend), label.unwrap_or("—"), opt(&r.models), opt(&r.billing));
    let _ = writeln!(o, "draft {}  kind {}  purpose {}", opt(&r.draft), opt(&r.kind), opt(&r.purpose));
    let _ = writeln!(o, "outcome {}{}  wall {}  first output {}", opt(&r.outcome), if r.waiting { " (waiting on a question)" } else { "" },
        r.wall_ms.map_or("—".into(), secs), r.first_output_ms.map_or("—".into(), secs));
    let _ = writeln!(o, "requests {}  tokens in {} out {} cache read {} write {}  cost {}", r.requests, r.input, r.output, r.cache_read,
        r.cache_write, r.cost_usd.map_or("—".into(), |c| format!("${c:.4}")));
    let check = match r.check_ok { Some(true) => "passed", Some(false) => "FAILED", None => "—" };
    let _ = writeln!(o, "tools {} (failed {})  check {}  files changed {}  errors {}  notes {}", r.tools, r.tool_failures, check,
        r.files_changed, r.errors, r.notes);
    let rating = r.rating.map_or("unrated".into(), |n| format!("rated {n}/5"));
    let _ = writeln!(o, "{rating}{}", r.comment.as_deref().map(|c| format!(": {c}")).unwrap_or_default());
    o
}

/// What a `start` said the run was sent.
fn sent(store: &Store, e: &Value, full: bool) -> String {
    let mut o = String::new();
    for k in ["message", "answer", "diagnostics", "session"] {
        match e.get(k) {
            None | Some(Value::Null) => {}
            Some(Value::String(t)) => { let _ = writeln!(o, "{k}: {}", cut(t, BRIEF, full)); }
            Some(v) => { let _ = writeln!(o, "{k}: {}", cut(&compact(v), BRIEF, full)); }
        }
    }
    let inputs = e.get("inputs");
    for (k, label) in [("files", "the draft's files"), ("binary", "its binaries"), ("template", "the template's files")] {
        let Some(Value::Object(m)) = inputs.and_then(|i| i.get(k)) else { continue };
        let names: Vec<String> = m.iter().map(|(p, v)| match v.get("bytes").and_then(Value::as_i64) {
            Some(b) => format!("{p} ({b} B)"),
            None => p.clone(),
        }).collect();
        let _ = writeln!(o, "{label}: {}", if names.is_empty() { "none".into() } else { names.join(", ") });
    }
    if let Some(brief) = inputs.and_then(|i| i.get("spec")).and_then(|v| text_of(store, v)) {
        let _ = writeln!(o, "brief:\n{}", indent(&cut(&brief, BRIEF, full)));
    }
    o
}

fn indent(t: &str) -> String {
    t.lines().map(|l| format!("    {l}")).collect::<Vec<_>>().join("\n")
}

/// One event of the timeline, without its time.
fn event(store: &Store, e: &Value, full: bool) -> String {
    let ty = s(e, "type").unwrap_or("?");
    match ty {
        "start" => format!("start: {}", s(e, "message").map(|m| cut(m, TEXT, full)).unwrap_or_default()),
        "text" => format!("text: {}", cut(s(e, "text").unwrap_or(""), TEXT, full)),
        "tool" => format!("tool {}: {}", s(e, "name").unwrap_or("?"), cut(s(e, "summary").unwrap_or(""), TEXT, full)),
        "tool_result" => {
            let ok = if e.get("ok").and_then(Value::as_bool) == Some(false) { "FAILED" } else { "ok" };
            let took = e.get("took").and_then(Value::as_i64).map(|t| format!(" in {}", secs(t))).unwrap_or_default();
            let mut out = format!("tool_result {} {ok}{took}", s(e, "name").unwrap_or("?"));
            for c in e.get("content").and_then(Value::as_array).into_iter().flatten() {
                if s(c, "type") == Some("image") {
                    let _ = write!(out, "\n    [image {} {}]", s(c, "$blob").unwrap_or("?"), s(c, "mimeType").unwrap_or(""));
                } else if let Some(t) = c.get("text").map(|t| text_of(store, t)).unwrap_or_else(|| text_of(store, c)) {
                    let _ = write!(out, "\n{}", indent(&cut(&t, RESULT, full)));
                }
            }
            out
        }
        "files" => {
            let m = e.get("files").and_then(Value::as_object);
            let names: Vec<String> = m.into_iter().flatten().map(|(p, v)| if v.is_null() { format!("{p} (deleted)") } else { p.clone() }).collect();
            format!("files: {}", names.join(", "))
        }
        "usage" => {
            let n = |k: &str| e.get(k).and_then(Value::as_i64).unwrap_or(0);
            let took = e.get("took").and_then(Value::as_i64).map(|t| format!(" {}", secs(t))).unwrap_or_default();
            format!("usage {}: in {} out {} cache {}/{}{took}", s(e, "model").unwrap_or("?"), n("input"), n("output"), n("cacheRead"), n("cacheWrite"))
        }
        "error" => format!("ERROR: {}", cut(s(e, "message").unwrap_or(""), RESULT, full)),
        "rating" => format!("rating {}/5{}", e.get("score").map(compact).unwrap_or_default(), s(e, "comment").map(|c| format!(": {c}")).unwrap_or_default()),
        "note" => format!("note by {}: {}", s(e, "by").unwrap_or("?"), s(e, "text").unwrap_or("")),
        "end" => format!("end: {}{}", s(e, "outcome").unwrap_or("?"), if e.get("waiting").and_then(Value::as_bool) == Some(true) { ", waiting on a question" } else { "" }),
        _ => {
            let mut rest = e.clone();
            if let Some(m) = rest.as_object_mut() { for k in ["v", "run", "seq", "at", "ms", "type"] { m.remove(k); } }
            format!("{ty}: {}", cut(&compact(&rest), OTHER, full))
        }
    }
}

/// The run without its raw stream: its facts, what it was sent, and every event as it came.
pub fn show(store: &Store, row: &Row, label: Option<&str>, lines: &[Value], full: bool) -> String {
    let mut events: Vec<Value> = lines.iter().filter(|e| s(e, "type") != Some("trace")).cloned().collect();
    super::in_order(&mut events);
    let traces = lines.len() - events.len();
    let mut o = facts(row, label);
    if let Some(start) = events.iter().find(|e| s(e, "type") == Some("start")) {
        o.push_str("\n## sent\n");
        o.push_str(&sent(store, start, full));
    }
    o.push_str("\n## timeline\n");
    let mut last = 0;
    for e in &events {
        if s(e, "type") == Some("owner") { continue; }
        let line = event(store, e, full);
        match e.get("ms").and_then(Value::as_i64).filter(|_| e.get("by").is_none()) {
            Some(ms) => {
                let gap = if ms - last >= 10_000 { format!(" (+{} gap)", secs(ms - last)) } else { String::new() };
                last = ms;
                let _ = writeln!(o, "{:>8}{gap}  {line}", secs(ms));
            }
            None => { let _ = writeln!(o, "{:>8}  {line}", s(e, "at").unwrap_or("")); }
        }
    }
    let _ = writeln!(o, "\n{traces} raw stream line(s): `runs stream {}`", row.id);
    o
}

/// The files the run changed: each path, its text before (as sent) and after (`None`: deleted, or not there).
pub fn changed(store: &Store, lines: &[Value]) -> Vec<(String, Option<String>, Option<String>)> {
    let mut events: Vec<&Value> = lines.iter().filter(|e| e.get("by").is_none()).collect();
    events.sort_by_key(|e| e.get("seq").and_then(Value::as_i64).unwrap_or(0));
    let mut before: BTreeMap<String, Option<String>> = BTreeMap::new();
    if let Some(Value::Object(m)) = events.iter().find(|e| s(e, "type") == Some("start")).and_then(|e| e.get("inputs")).and_then(|i| i.get("files")) {
        for (p, v) in m { before.insert(p.clone(), text_of(store, v)); }
    }
    let mut after: BTreeMap<String, Option<String>> = BTreeMap::new();
    for e in events.iter().filter(|e| s(e, "type") == Some("files")) {
        for (p, v) in e.get("files").and_then(Value::as_object).into_iter().flatten() {
            after.insert(p.clone(), if v.is_null() { None } else { text_of(store, v) });
        }
    }
    after.into_iter().filter_map(|(p, a)| {
        let b = before.get(&p).cloned().flatten();
        (a != b).then_some((p, b, a))
    }).collect()
}

/// What the run changed as a unified diff, of every file or of `only`.
pub fn diff(store: &Store, lines: &[Value], only: Option<&str>) -> String {
    let mut o = String::new();
    for (p, b, a) in changed(store, lines) {
        if only.is_some_and(|x| x != p) { continue; }
        let (b, a) = (b.unwrap_or_default(), a.unwrap_or_default());
        let d = similar::TextDiff::from_lines(&b, &a);
        let _ = write!(o, "{}", d.unified_diff().context_radius(3).header(&format!("a/{p}"), &format!("b/{p}")));
    }
    if o.is_empty() { o.push_str("no changes\n"); }
    o
}

/// The run's raw stream, a line per `trace`: `ms source data`, the data cut unless `full`, only those `grep` finds.
pub fn stream(store: &Store, lines: &[Value], grep: Option<&Regex>, full: bool) -> String {
    let mut traces: Vec<&Value> = lines.iter().filter(|e| s(e, "type") == Some("trace")).collect();
    traces.sort_by_key(|e| e.get("seq").and_then(Value::as_i64).unwrap_or(0));
    let mut o = String::new();
    for e in traces {
        let data = match e.get("data") {
            Some(Value::String(t)) => t.clone(),
            Some(v @ Value::Object(m)) if m.contains_key("$blob") => text_of(store, v).unwrap_or_default(),
            Some(v) => compact(v),
            None if e.get("truncated").is_some() => "[the rest of the stream was left out]".into(),
            None => String::new(),
        };
        let data = data.replace('\n', "\\n");
        let found = match grep {
            Some(g) => match g.find(&data) { Some(m) => m.start(), None => continue },
            None => 0,
        };
        // what's cut is what comes after the match, a little before it kept
        let from = if full { 0 } else { data[..found].chars().count().saturating_sub(TRACE / 4) };
        let shown: String = data.chars().skip(from).collect();
        let ms = e.get("ms").and_then(Value::as_i64).map(secs).unwrap_or_default();
        let _ = writeln!(o, "{ms:>8}  {}  {}{}", s(e, "source").unwrap_or("?"), if from > 0 { "…" } else { "" }, cut(&shown, TRACE, full));
    }
    o
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sha2::{Digest, Sha256};

    fn blob(store: &Store, text: &str) -> Value {
        let sha: String = Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
        store.put_blob(&sha, text.as_bytes()).unwrap();
        json!({ "$blob": sha, "bytes": text.len() })
    }

    fn row() -> Row {
        Row {
            id: "r1".into(), account: "a".into(), started: "2026-11-23T10:00:00Z".into(), last_at: None, draft: Some("d".into()),
            kind: Some("view".into()), purpose: Some("turn".into()), backend: Some("claude-cli".into()), models: None, billing: None,
            outcome: Some("completed".into()), waiting: false, wall_ms: Some(30_000), first_output_ms: Some(2000), requests: 1,
            input: 10, output: 5, cache_read: 0, cache_write: 0, cost_usd: None, tools: 1, tool_failures: 1, check_ok: Some(false),
            files_changed: 1, errors: 0, rating: Some(1), comment: Some("broke it".into()), notes: 1,
        }
    }

    fn fixture(store: &Store) -> Vec<Value> {
        let long = "x".repeat(5000);
        vec![
            json!({"seq": -1, "type": "owner", "by": "server", "at": "2026-11-23T10:00:00Z", "account": "a"}),
            json!({"seq": 0, "ms": 0, "at": "2026-11-23T10:00:00Z", "type": "start", "message": "make it blue",
                "inputs": {"files": {"View.tsx": blob(store, "a\nb\n"), "old.ts": blob(store, "gone\n")}, "spec": blob(store, "The brief.")}}),
            json!({"seq": 1, "ms": 1000, "type": "text", "text": "on it"}),
            json!({"seq": 2, "ms": 1500, "type": "trace", "source": "claude", "data": "{\"type\":\"assistant\",\"secret\":1}"}),
            json!({"seq": 3, "ms": 2000, "type": "tool_result", "name": "check", "ok": false, "took": 300,
                "content": [{"type": "text", "$blob": blob(store, &long)["$blob"]}, {"type": "image", "mimeType": "image/png", "$blob": "ab"}]}),
            json!({"seq": 4, "ms": 25_000, "type": "files", "files": {"View.tsx": blob(store, "a\nc\n"), "old.ts": null}}),
            json!({"seq": 5, "ms": 26_000, "type": "rating", "score": 1, "comment": "broke it"}),
            json!({"seq": -2, "type": "note", "by": "admin", "at": "2026-11-23T11:00:00Z", "text": "wrong file"}),
        ]
    }

    #[test]
    fn show_is_the_run_without_its_stream() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_path_buf());
        let out = show(&store, &row(), Some("Claude"), &fixture(&store), false);
        assert!(out.contains("check FAILED"), "{out}");
        assert!(out.contains("brief:\n    The brief."), "{out}");
        assert!(out.contains("View.tsx (4 B)"), "{out}");
        assert!(out.contains("tool_result check FAILED in 0.3s"), "{out}");
        assert!(out.contains("[4200 more chars]"), "{out}");
        assert!(out.contains("[image ab image/png]"), "{out}");
        assert!(out.contains("(+23.0s gap)  files: View.tsx, old.ts (deleted)"), "{out}");
        assert!(out.contains("note by admin: wrong file"), "{out}");
        assert!(!out.contains("secret"), "{out}");
        assert!(out.contains("1 raw stream line(s)"), "{out}");
        assert!(show(&store, &row(), None, &fixture(&store), true).contains(&"x".repeat(5000)));
    }

    #[test]
    fn diff_is_what_changed_against_what_was_sent() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_path_buf());
        let lines = fixture(&store);
        let c = changed(&store, &lines);
        assert_eq!(c, vec![
            ("View.tsx".into(), Some("a\nb\n".into()), Some("a\nc\n".into())),
            ("old.ts".into(), Some("gone\n".into()), None),
        ]);
        let d = diff(&store, &lines, Some("View.tsx"));
        assert!(d.contains("-b\n+c\n") && !d.contains("gone"), "{d}");
    }

    #[test]
    fn stream_is_the_raw_lines_filtered() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_path_buf());
        let lines = fixture(&store);
        assert!(stream(&store, &lines, None, false).contains("claude  {\"type\":\"assistant\""));
        assert!(stream(&store, &lines, Some(&Regex::new("nothing like it").unwrap()), false).is_empty());
        let mut far = lines.clone();
        far.push(json!({"seq": 9, "ms": 1, "type": "trace", "source": "claude", "data": format!("{}needle{}", "a".repeat(1000), "b".repeat(1000))}));
        let found = stream(&store, &far, Some(&Regex::new("needle").unwrap()), false);
        assert!(found.contains("…aaa") && found.contains("needlebbb"), "{found}");
    }
}
