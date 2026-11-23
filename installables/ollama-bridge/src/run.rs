//! One turn: the page's files kept in memory, Ollama asked in a loop with tools on them (ported from the server's
//! agent, `web/server/src/agent.rs`) and the page's own tools (handed to the page), until it answers without a tool.
//! Then the draft's files it changed go back. The page's draft stays the truth: every turn brings it anew.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Mutex;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot, watch};

use crate::ollama::{Ollama, tool};

/// What the page sends (as to claude-bridge).
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FromPage {
    Start(Box<Start>),
    ToolResult {
        id: String,
        #[serde(default)]
        content: Vec<Value>,
        #[serde(default, rename = "isError")]
        is_error: bool,
    },
    Cancel,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Start {
    /// the page's name for this workspace (a draft's id); a session resumes only in its own workspace
    pub workspace: String,
    pub session: Option<String>,
    pub prompt: String,
    pub system: Option<String>,
    /// text files by path
    #[serde(default)]
    pub files: BTreeMap<String, String>,
    /// other files by path, as base64: listed, not read
    #[serde(default)]
    pub binary: BTreeMap<String, String>,
    /// which paths are the draft (a regex matching the whole path): what may be changed and what comes back
    pub keep: String,
    #[serde(default)]
    pub tools: Vec<ToolSpec>,
    /// an Ollama model, instead of the bridge's
    pub model: Option<String>,
    // claude-bridge's `maxBudgetUsd` and `effort` mean nothing here and are ignored
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSpec {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub input_schema: Value,
}

/// What the page hears (as from claude-bridge).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToPage {
    Text { text: String },
    Tool { name: String, summary: String },
    ToolCall { id: String, name: String, input: Value, files: BTreeMap<String, String> },
    /// the files the turn changed; `null`: deleted
    Files { files: BTreeMap<String, Option<String>> },
    Done { session: Option<String> },
    Error { message: String },
    /// one model request's tokens and time, for the page's record of the turn
    Usage { model: Option<String>, input: Option<i64>, output: Option<i64>, ms: Option<i64>, billing: &'static str },
    /// how one of the bridge's own tools came out (the page times its own)
    ToolResult { name: String, ok: bool, ms: i64, content: Vec<Value> },
    /// Ollama's answer as it came, for the page's record
    Trace { source: &'static str, data: Value },
}

/// What an answer says of its tokens and time (`prompt_eval_count`, `eval_count`, `total_duration` in ns).
pub fn usage_of(model: &str, raw: &Value) -> ToPage {
    let n = |k: &str| raw.get(k).and_then(Value::as_i64);
    ToPage::Usage {
        model: Some(raw.get("model").and_then(Value::as_str).unwrap_or(model).to_owned()),
        input: n("prompt_eval_count"), output: n("eval_count"), ms: n("total_duration").map(|ns| ns / 1_000_000), billing: "free",
    }
}

const WORKSPACE_ID: &str = r"^[a-z0-9][a-z0-9-]{0,63}$";
const TOOL_NAME: &str = r"^[a-z][a-z0-9_]{0,39}$";
const MAX_PATH: usize = 300;
const MAX_FILES: usize = 4000;
const MAX_FILE_BYTES: usize = 512 * 1024;
/// what one tool result may hold, so a small context isn't filled by one file
const MAX_OUT: usize = 16_000;
const MAX_ROUNDS: usize = 40;
const OWN_TOOLS: [&str; 6] = ["list_files", "read_file", "write_file", "edit_file", "delete_file", "search"];

/// A request the bridge refuses, else the draft's paths as a regex.
pub fn validate(s: &Start) -> Result<Regex, String> {
    if !Regex::new(WORKSPACE_ID).expect("valid").is_match(&s.workspace) {
        return Err("workspace: lowercase letters, digits and -, at most 64".into());
    }
    if s.prompt.trim().is_empty() { return Err("the prompt is empty".into()); }
    if s.files.len() + s.binary.len() > MAX_FILES { return Err(format!("more than {MAX_FILES} files")); }
    for p in s.files.keys().chain(s.binary.keys()) {
        if !safe_path(p) { return Err(format!("not a path inside the workspace: {p:?}")); }
    }
    let name = Regex::new(TOOL_NAME).expect("valid");
    let mut seen = BTreeSet::new();
    for t in &s.tools {
        if !name.is_match(&t.name) || !seen.insert(&t.name) { return Err(format!("tool name {:?}: lowercase letters, digits and _, once each", t.name)); }
        if OWN_TOOLS.contains(&t.name.as_str()) { return Err(format!("tool name {:?} is the bridge's own", t.name)); }
        if !t.input_schema.is_object() { return Err(format!("tool {}: inputSchema must be a JSON schema object", t.name)); }
    }
    if let Some(m) = &s.model && (m.is_empty() || !m.chars().all(|c| c.is_ascii_alphanumeric() || "-._:/".contains(c))) {
        return Err("model: an Ollama model name, like qwen3.5:9b".into());
    }
    Regex::new(&format!("^(?:{})$", s.keep)).map_err(|e| format!("keep: {e}"))
}

/// A relative path with plain parts.
pub fn safe_path(p: &str) -> bool {
    !p.is_empty() && p.len() <= MAX_PATH && !p.starts_with('/') && !p.contains('\\') && !p.contains(':') && !p.contains('\0')
        && p.split('/').all(|c| !c.is_empty() && c != "." && c != "..")
}

/// A conversation, kept in memory until the bridge stops.
#[derive(Debug, Clone)]
pub struct Session {
    /// the site and the workspace it belongs to
    pub owner: (String, String),
    /// without the system message, which every turn sets anew
    pub messages: Vec<Value>,
    /// the files as the last turn left them
    pub files: BTreeMap<String, String>,
}

/// The turn as it runs: where its events go, the page's tool calls waiting on an answer, and whether it's cancelled.
pub struct Turn {
    pub out: mpsc::UnboundedSender<ToPage>,
    pub pending: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    pub cancel: watch::Receiver<bool>,
}

impl Turn {
    pub fn answer(&self, id: &str, content: Vec<Value>, is_error: bool) {
        if let Some(tx) = self.pending.lock().expect("pending lock").remove(id) {
            let _ = tx.send(json!({ "content": content, "isError": is_error }));
        }
    }

    fn emit(&self, e: ToPage) { let _ = self.out.send(e); }

    fn cancelled(&self) -> bool { *self.cancel.borrow() }

    async fn until_cancelled(&self) {
        let mut c = self.cancel.clone();
        let _ = c.wait_for(|v| *v).await;
    }

    /// Asks the page to run one of its tools on the draft as it is now: the result's text, and whether it failed.
    async fn page_tool(&self, name: &str, input: Value, files: BTreeMap<String, String>) -> (String, bool) {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().expect("pending lock").insert(id.clone(), tx);
        self.emit(ToPage::ToolCall { id: id.clone(), name: name.to_owned(), input, files });
        let r = tokio::select! {
            r = rx => r.ok(),
            _ = self.until_cancelled() => None,
        };
        self.pending.lock().expect("pending lock").remove(&id);
        let Some(r) = r else { return ("cancelled".into(), true) };
        let text = r["content"].as_array().map(|cs| cs.iter().map(|c| match c["type"].as_str() {
            Some("text") => c["text"].as_str().unwrap_or_default().to_owned(),
            Some(other) => format!("[{other} left out: this model reads text only]"),
            None => String::new(),
        }).collect::<Vec<_>>().join("\n")).unwrap_or_default();
        (text, r["isError"].as_bool().unwrap_or(false))
    }
}

/// The turn's files, and what of them is the draft.
struct Workspace<'a> {
    files: BTreeMap<String, String>,
    binary: &'a BTreeMap<String, String>,
    keep: &'a Regex,
}

impl Workspace<'_> {
    fn draft(&self) -> BTreeMap<String, String> {
        self.files.iter().filter(|(p, _)| self.keep.is_match(p)).map(|(p, t)| (p.clone(), t.clone())).collect()
    }

    /// Deletable: a draft file in a folder (a view's `gestalts/`, `data/`), never the draft's top-level files.
    fn deletable(&self, p: &str) -> bool { self.keep.is_match(p) && p.contains('/') }

    /// What a file tool did, as its result text, or an error the model sees.
    fn run(&mut self, name: &str, input: &Value) -> Result<String, String> {
        let s = |k: &str| input.get(k).and_then(Value::as_str);
        let need = |k: &str| s(k).ok_or_else(|| format!("`{k}` is missing"));
        let paths = || self.files.keys().cloned().chain(self.binary.keys().map(|p| format!("{p} (binary, can't be read)")));
        match name {
            "list_files" => {
                let scope = s("path").unwrap_or("").trim_matches('/');
                let all: Vec<String> = paths().filter(|f| scope.is_empty() || scope == "." || f.starts_with(&format!("{scope}/"))).collect();
                if all.is_empty() { return Err(format!("{scope}: no such folder here")); }
                Ok(all.join("\n"))
            }
            "read_file" => {
                let p = need("path")?;
                if self.binary.contains_key(p) { return Err(format!("{p}: not text; it can't be read here")); }
                self.files.get(p).cloned().ok_or_else(|| format!("{p}: no such file"))
            }
            "write_file" => {
                let (p, content) = (need("path")?, need("content")?);
                if !safe_path(p) || !self.keep.is_match(p) { return Err(format!("{p}: only the draft's files can be written (paths matching {})", self.keep.as_str())); }
                if content.len() > MAX_FILE_BYTES { return Err(format!("{p}: longer than {MAX_FILE_BYTES} bytes")); }
                self.files.insert(p.to_owned(), content.to_owned());
                Ok(format!("wrote {p}"))
            }
            "edit_file" => {
                let (p, old, new) = (need("path")?, need("old_string")?, need("new_string")?);
                let all = input.get("replace_all").and_then(Value::as_bool).unwrap_or(false);
                if !self.keep.is_match(p) { return Err(format!("{p}: only the draft's files can be edited")); }
                let text = self.files.get(p).ok_or_else(|| format!("{p}: no such file in the draft"))?;
                let n = text.matches(old).count();
                if old.is_empty() || n == 0 { return Err(format!("{p}: old_string isn't there; read the file again")); }
                if n > 1 && !all { return Err(format!("{p}: old_string is there {n} times; give more context, or replace_all")); }
                let next = if all { text.replace(old, new) } else { text.replacen(old, new, 1) };
                if next.len() > MAX_FILE_BYTES { return Err(format!("{p}: longer than {MAX_FILE_BYTES} bytes")); }
                self.files.insert(p.to_owned(), next);
                Ok(format!("edited {p}"))
            }
            "delete_file" => {
                let p = need("path")?;
                if !self.deletable(p) || self.files.remove(p).is_none() {
                    return Err(format!("{p}: only an existing file of the draft inside a folder can be deleted"));
                }
                Ok(format!("deleted {p}"))
            }
            "search" => {
                let text = need("text")?.to_lowercase();
                let scope = s("path").unwrap_or("").trim_end_matches('/');
                let in_scope = |f: &str| scope.is_empty() || f == scope || f.starts_with(&format!("{scope}/"));
                let mut hits = Vec::new();
                for (f, body) in self.files.iter().filter(|(f, _)| in_scope(f)) {
                    for (i, line) in body.lines().enumerate() {
                        if hits.len() < 60 && line.to_lowercase().contains(&text) {
                            hits.push(format!("{f}:{}: {}", i + 1, line.trim().chars().take(200).collect::<String>()));
                        }
                    }
                }
                Ok(if hits.is_empty() { "nothing found".into() } else { hits.join("\n") })
            }
            other => Err(format!("no tool {other}")),
        }
    }
}

fn own_tools(keep: &str) -> Vec<Value> {
    let path = json!({ "type": "string", "description": "a path as list_files shows it, e.g. view.tsx" });
    vec![
        tool("list_files", "Lists the files, or with `path` those in a folder.", json!({ "type": "object", "properties": { "path": path } })),
        tool("read_file", "Reads a whole file.", json!({ "type": "object", "properties": { "path": path }, "required": ["path"] })),
        tool("write_file", &format!("Writes a whole file of the draft (paths matching the regex {keep})."),
             json!({ "type": "object", "properties": { "path": path, "content": { "type": "string" } }, "required": ["path", "content"] })),
        tool("edit_file", "Replaces `old_string` with `new_string` in a file of the draft. `old_string` must occur exactly once, unless `replace_all`.",
             json!({ "type": "object", "properties": { "path": path, "old_string": { "type": "string" }, "new_string": { "type": "string" }, "replace_all": { "type": "boolean" } }, "required": ["path", "old_string", "new_string"] })),
        tool("delete_file", "Deletes a file of the draft that is inside a folder.", json!({ "type": "object", "properties": { "path": path }, "required": ["path"] })),
        tool("search", "Finds lines containing `text` (case-insensitive) in the files; `path` limits it to a folder or file.",
             json!({ "type": "object", "properties": { "text": { "type": "string" }, "path": path }, "required": ["text"] })),
    ]
}

/// What the model is told: the page's system text, how the tools here work, and the contract (`CLAUDE.md`), which a
/// Claude Code run would read by itself.
fn system(start: &Start, with_files: bool) -> String {
    let mut parts = vec![];
    if let Some(s) = start.system.as_deref().filter(|s| !s.trim().is_empty()) { parts.push(s.trim().to_owned()); }
    if with_files {
        parts.push(format!(
            "There is no disk and no shell: you work on the files through tools. `list_files`, `read_file` and `search` \
             see all of them; `write_file`, `edit_file` and `delete_file` change only the draft's files (paths matching \
             the regex {}). Read a file before you edit it. What you write is kept when you stop calling tools; then say \
             in a few sentences what you did.", start.keep));
        if let Some(c) = start.files.get("CLAUDE.md") { parts.push(c.trim().to_owned()); }
    }
    parts.join("\n\n")
}

fn summary(name: &str, input: &Value) -> String {
    match name {
        "search" => format!("“{}”", input["text"].as_str().unwrap_or_default()),
        _ => input["path"].as_str().unwrap_or_default().to_owned(),
    }
}

fn cut(mut s: String) -> String {
    if s.len() > MAX_OUT {
        let mut at = MAX_OUT;
        while !s.is_char_boundary(at) { at -= 1; }
        s.truncate(at);
        s.push_str(&format!("\n… (cut at {MAX_OUT} bytes; `search` finds the lines you need)"));
    }
    s
}

/// What the turn changed of the draft, against what it started from.
fn changed(before: &BTreeMap<String, String>, after: &BTreeMap<String, String>, keep: &Regex) -> BTreeMap<String, Option<String>> {
    let mut out = BTreeMap::new();
    for (p, t) in after.iter().filter(|(p, _)| keep.is_match(p)) {
        if before.get(p) != Some(t) { out.insert(p.clone(), Some(t.clone())); }
    }
    for p in before.keys().filter(|p| keep.is_match(p) && !after.contains_key(*p)) { out.insert(p.clone(), None); }
    out
}

/// Runs the turn to its end (or until cancelled) and emits `files` and `done`; the conversation, to keep.
pub async fn run(ollama: &Ollama, start: Start, keep: Regex, earlier: Option<Session>, owner: (String, String), turn: &Turn) -> (String, Session) {
    let session_id = start.session.clone().filter(|_| earlier.is_some()).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let with_files = !start.files.is_empty();
    let mut tools = if with_files { own_tools(&start.keep) } else { vec![] };
    tools.extend(start.tools.iter().map(|t| tool(&t.name, &t.description, t.input_schema.clone())));
    let page_tools: BTreeSet<&str> = start.tools.iter().map(|t| t.name.as_str()).collect();

    let mut prompt = start.prompt.clone();
    let mut messages = match earlier {
        Some(e) => {
            let moved: Vec<String> = changed(&e.files, &start.files, &keep).into_keys().collect();
            if !moved.is_empty() {
                prompt = format!("(Changed outside this conversation since your last turn: {}.)\n\n{prompt}", moved.join(", "));
            }
            e.messages
        }
        None => vec![],
    };
    messages.push(json!({ "role": "user", "content": prompt }));

    let model = start.model.clone().unwrap_or_else(|| ollama.model.clone());
    let sys = json!({ "role": "system", "content": system(&start, with_files) });
    let mut ws = Workspace { files: start.files.clone(), binary: &start.binary, keep: &keep };
    let mut rounds = 0;
    while !turn.cancelled() {
        if rounds == MAX_ROUNDS {
            turn.emit(ToPage::Text { text: format!("(stopped after {MAX_ROUNDS} rounds of tool calls)") });
            break;
        }
        rounds += 1;
        let all: Vec<Value> = std::iter::once(sys.clone()).chain(messages.iter().cloned()).collect();
        let reply = tokio::select! {
            r = ollama.chat(&model, &all, &tools) => r,
            _ = turn.until_cancelled() => break,
        };
        let reply = match reply {
            Ok(r) => r,
            Err(e) => { turn.emit(ToPage::Error { message: e }); break; }
        };
        turn.emit(usage_of(&model, &reply.raw));
        turn.emit(ToPage::Trace { source: "ollama", data: reply.raw.clone() });
        if !reply.content.trim().is_empty() { turn.emit(ToPage::Text { text: reply.content.trim().to_owned() }); }
        messages.push(reply.message);
        if reply.calls.is_empty() { break; }
        for (name, input) in reply.calls {
            turn.emit(ToPage::Tool { name: name.clone(), summary: summary(&name, &input) });
            let (text, failed) = if page_tools.contains(name.as_str()) {
                turn.page_tool(&name, input, ws.draft()).await
            } else if with_files && OWN_TOOLS.contains(&name.as_str()) {
                let t0 = std::time::Instant::now();
                let (text, failed) = match ws.run(&name, &input) { Ok(t) => (t, false), Err(e) => (e, true) };
                turn.emit(ToPage::ToolResult { name: name.clone(), ok: !failed, ms: t0.elapsed().as_millis() as i64, content: vec![json!({ "type": "text", "text": text })] });
                (text, failed)
            } else {
                (format!("no tool {name}"), true)
            };
            let content = cut(if failed { format!("Error: {text}") } else { text });
            messages.push(json!({ "role": "tool", "tool_name": name, "content": content }));
        }
    }
    let files = changed(&start.files, &ws.files, &keep);
    if !files.is_empty() { turn.emit(ToPage::Files { files }); }
    let kept = Session { owner, messages, files: ws.files };
    (session_id, kept)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_answer_says_its_tokens_and_time() {
        let raw = json!({ "model": "qwen3.5:9b", "prompt_eval_count": 1200, "eval_count": 80, "total_duration": 4_500_000_000i64 });
        assert_eq!(serde_json::to_value(usage_of("x", &raw)).unwrap(), json!({ "type": "usage", "model": "qwen3.5:9b", "input": 1200, "output": 80, "ms": 4500, "billing": "free" }));
    }

    fn start(files: &[(&str, &str)]) -> Start {
        Start {
            workspace: "d1".into(), session: None, prompt: "go".into(), system: None,
            files: files.iter().map(|(p, t)| (p.to_string(), t.to_string())).collect(), binary: BTreeMap::new(),
            keep: r"view\.tsx|data/[^/]+\.yml".into(), tools: vec![], model: None,
        }
    }

    #[test]
    fn refuses_paths_outside_the_workspace() {
        for bad in ["/etc/passwd", "../x", "a/../b", "a//b", "C:x", "a\\b"] {
            assert!(validate(&start(&[(bad, "")])).is_err(), "{bad}");
        }
        assert!(validate(&start(&[("view.tsx", "")])).is_ok());
        let mut s = start(&[]);
        s.tools = vec![ToolSpec { name: "read_file".into(), description: String::new(), input_schema: json!({}) }];
        assert!(validate(&s).is_err(), "the page can't take the bridge's own tool names");
    }

    #[test]
    fn the_tools_change_only_the_draft() {
        let s = start(&[("view.tsx", "a b a"), ("CLAUDE.md", "contract"), ("data/x.yml", "x")]);
        let keep = validate(&s).unwrap();
        let mut ws = Workspace { files: s.files.clone(), binary: &s.binary, keep: &keep };
        assert!(ws.run("write_file", &json!({ "path": "CLAUDE.md", "content": "mine" })).is_err());
        assert!(ws.run("edit_file", &json!({ "path": "view.tsx", "old_string": "a", "new_string": "c" })).unwrap_err().contains("2 times"));
        ws.run("edit_file", &json!({ "path": "view.tsx", "old_string": "a", "new_string": "c", "replace_all": true })).unwrap();
        assert!(ws.run("delete_file", &json!({ "path": "view.tsx" })).is_err());
        ws.run("delete_file", &json!({ "path": "data/x.yml" })).unwrap();
        ws.run("write_file", &json!({ "path": "data/y.yml", "content": "y" })).unwrap();
        assert_eq!(ws.run("search", &json!({ "text": "CONTRACT" })).unwrap(), "CLAUDE.md:1: contract");
        let c = changed(&s.files, &ws.files, &keep);
        assert_eq!(c, BTreeMap::from([("view.tsx".into(), Some("c b c".into())), ("data/x.yml".into(), None), ("data/y.yml".into(), Some("y".into()))]));
    }

    #[test]
    fn long_results_are_cut() {
        let s = cut("é".repeat(MAX_OUT));
        assert!(s.len() < MAX_OUT + 100 && s.ends_with("you need)"));
    }
}
