//! The agent, run here on our API key: a tool loop over a draft's files, held in memory, never a filesystem or a shell.
//! It speaks the workshop's job protocol (`@gestalts/workshop`'s `httpBackend`) under `/api/drafts/<id>/agent/`:
//!
//! - `GET status` → `{available, reason?, ask?}`: `ask` is the question the conversation waits on, if it does
//! - `POST turn` `{view, session?, message, files, gestalts, diagnostics, answer?}` → 202 `{job}`
//! - `GET events?job=&after=n` → `{events, next, done}`, waiting up to 20 s for events after the n-th
//! - `POST cancel` `{job}`
//! - `POST complete` `{system, prompt}` → `{text}`: one answer, no tools, low effort, within the budget: what a
//!   feature built on any agent asks (`AgentBackend.complete`), the Claude bridge as well as this
//!
//! Like the local CLI agent, it hands back the files it changed; the browser writes the ymls, which the sync
//! validates. Its tools read and write the draft's files, read the kit's sources and the examples (the agent
//! template's, read-only), search them, and run the check (the worker). One turn at a time per account, each within
//! their monthly token budget.
//!
//! It may also `ask` (`packages/workshop/agent-template/ask.json`): the turn ends with that call open, and the
//! person's answer, whenever and from wherever it comes, is its result at the start of the next turn. So a draft's
//! conversation is kept on disk (`agent/<draft>.json`), open question and all.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Notify;

use crate::auth::SignedIn;
use crate::drafting::contract::MAX_READ_BYTES;
use crate::drafting::workbench::{api_content, page_content, summary};
use crate::drafting::{SERVER_AGENT, ToolOut, Workspace};
pub use crate::drafting::{KindRef, Reference};
use crate::{ApiError, ApiResult, AppState, now_iso, random_hex};

pub const MODEL: &str = "claude-opus-5-5";
const API_VERSION: &str = "2026-10-21";
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
const MAX_TOKENS: u32 = 16_000;
/// Model calls in one turn, at most: a turn that needs more is a turn too big.
const MAX_STEPS: usize = 40;
const EVENT_POLL: Duration = Duration::from_secs(20);
const FINISHED_KEEP: Duration = Duration::from_secs(600);
/// how long a conversation is kept after its last turn: an open question may wait that long for its answer
const SESSION_KEEP: Duration = Duration::from_secs(7 * 24 * 3600);

/// How a visualization's check renders it here (`GESTALTS_VIZ_RENDER`): headless Chromium in the worker, or handed to
/// the workshop page the turn was started from, as the Claude bridge hands every tool to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum VizRender {
    Worker,
    #[default]
    Page,
}

impl std::str::FromStr for VizRender {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "worker" => Ok(VizRender::Worker),
            "page" => Ok(VizRender::Page),
            other => Err(format!("GESTALTS_VIZ_RENDER: worker or page, not {other}")),
        }
    }
}

/// A turn's job: what it did so far, for whoever polls.
pub struct Job {
    pub id: String,
    pub account: String,
    pub draft: String,
    /// the draft's kind, which says what the agent is given
    kind: String,
    /// tools handed to the page the turn came from (`VizRender::Page`), waiting on its answer, by call id
    waiting: Mutex<HashMap<String, tokio::sync::oneshot::Sender<ToolOut>>>,
    events: Mutex<Vec<Value>>,
    done: AtomicBool,
    cancelled: AtomicBool,
    changed: Notify,
    cancel: Notify,
    finished: Mutex<Option<Instant>>,
}

impl Job {
    fn emit(&self, e: Value) {
        self.events.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(e);
        self.changed.notify_waiters();
    }

    fn finish(&self) {
        *self.finished.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(Instant::now());
        self.done.store(true, Ordering::SeqCst);
        self.changed.notify_waiters();
    }
}

/// A draft's conversation, kept between turns: its messages, the files as it last left them, and the question it
/// waits on.
#[derive(Serialize, Deserialize)]
struct Session {
    session: String,
    account: String,
    draft: String,
    messages: Vec<Value>,
    files: BTreeMap<String, String>,
    ask: Option<Ask>,
    /// the last turn's end, in ms
    touched: i64,
}

/// An open question: the `ask` call the conversation ends with, and the results of the calls beside it, which go
/// back with its answer.
#[derive(Serialize, Deserialize, Clone)]
struct Ask {
    id: String,
    questions: Value,
    results: Vec<Value>,
}

/// An answer to an open question, by question: the options picked, or what was written instead.
#[derive(Deserialize)]
pub struct Answer {
    id: String,
    answers: BTreeMap<String, String>,
}

impl AppState {
    fn session_path(&self, draft: &str) -> PathBuf {
        self.data.join("agent").join(format!("{draft}.json"))
    }

    /// The draft's conversation, if it's recent enough to go on.
    fn load_session(&self, draft: &str) -> Option<Session> {
        let s: Session = serde_json::from_slice(&std::fs::read(self.session_path(draft)).ok()?).ok()?;
        (crate::now_ms() - s.touched < SESSION_KEEP.as_millis() as i64).then_some(s)
    }

    fn save_session(&self, s: &Session) -> Result<(), String> {
        let path = self.session_path(&s.draft);
        let dir = path.parent().expect("agent/");
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let tmp = dir.join(format!(".{}.tmp", s.draft));
        std::fs::write(&tmp, serde_json::to_vec(s).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
    }

    /// A deleted draft's conversation goes with it.
    pub fn drop_session(&self, draft: &str) {
        let _ = std::fs::remove_file(self.session_path(draft));
    }
}

/// The questions of an `ask` call, as the card shows them, or what's wrong with them.
fn questions(input: &Value) -> Result<Value, String> {
    let qs = input["questions"].as_array().filter(|q| (1..=4).contains(&q.len())).ok_or("ask: one to four questions")?;
    for q in qs {
        let text = q["question"].as_str().unwrap_or_default();
        if text.trim().is_empty() || q["header"].as_str().is_none_or(|h| h.trim().is_empty()) {
            return Err("ask: each question has `question` and `header`".into());
        }
        let options = q["options"].as_array().filter(|o| (2..=4).contains(&o.len())).ok_or_else(|| format!("ask: “{text}” needs two to four options"))?;
        if options.iter().any(|o| o["label"].as_str().is_none_or(|l| l.trim().is_empty())) {
            return Err(format!("ask: every option of “{text}” has a `label`"));
        }
    }
    Ok(Value::Array(qs.clone()))
}

/// The answer as the agent reads it.
fn answer_text(a: &Answer) -> String {
    let mut out = String::from("They answered:");
    for (q, answer) in &a.answers {
        out.push_str(&format!("\n- {q} → {}", if answer.trim().is_empty() { "(no answer)" } else { answer.trim() }));
    }
    out
}

/// How the agent reaches the model.
#[derive(Clone)]
pub struct Model {
    pub api_key: Option<String>,
    pub base_url: String,
    pub model: String,
}

pub struct Agents {
    jobs: Mutex<HashMap<String, Arc<Job>>>,
    http: reqwest::Client,
    pub model: Model,
    pub reference: Reference,
    /// by kind: the system prompt, or why there's none
    systems: BTreeMap<&'static str, Result<String, String>>,
    pub viz_render: VizRender,
}

impl Agents {
    pub fn new(model: Model, reference: Reference, viz_render: VizRender) -> Self {
        let systems = ["view", "viz"].into_iter().map(|k| (k, reference.kind(k).expect("a kind the agent makes").system(&SERVER_AGENT))).collect();
        let http = reqwest::Client::builder().timeout(Duration::from_secs(600)).build().expect("an HTTP client");
        Agents { jobs: Mutex::default(), http, model, reference, systems, viz_render }
    }

    fn prune(&self) {
        self.jobs.lock().unwrap_or_else(std::sync::PoisonError::into_inner).retain(|_, j| {
            j.finished.lock().unwrap_or_else(std::sync::PoisonError::into_inner).is_none_or(|t| t.elapsed() < FINISHED_KEEP)
        });
    }

    /// Why the agent can't take a turn now, if it can't; with a kind, on a draft of that kind.
    pub(crate) fn unavailable(&self, kind: Option<&str>) -> Option<String> {
        if self.model.api_key.is_none() {
            return Some("the agent isn't set up on this server (no API key)".into());
        }
        let kind = kind?;
        match self.systems.get(kind) {
            Some(Ok(_)) => None,
            Some(Err(e)) => Some(e.clone()),
            None => Some(format!("the agent doesn't work on a draft of kind {kind}")),
        }
    }

    async fn call_model(&self, system: &str, tools: &Value, messages: &[Value], notes: &mut Vec<Value>) -> Result<Value, String> {
        self.send(&json!({
            "model": self.model.model,
            "max_tokens": MAX_TOKENS,
            // thinking is always on for this model; effort decides how much
            "output_config": { "effort": "high" },
            "system": [{ "type": "text", "text": system, "cache_control": { "type": "ephemeral" } }],
            "tools": tools,
            "messages": messages,
            // the conversation so far, cached as it grows
            "cache_control": { "type": "ephemeral" },
            // a request a safety classifier declines is retried on the model that fits, in the same call
            "fallbacks": "default",
        }), notes)
        .await
    }

    /// One answer, without tools, at low effort, whose text is the answer. Cached like a turn's system prompt.
    pub(crate) async fn call_once(&self, system: &str, user: &str) -> Result<Value, String> {
        self.send(&json!({
            "model": self.model.model,
            "max_tokens": MAX_TOKENS,
            "output_config": { "effort": "low" },
            "system": [{ "type": "text", "text": system, "cache_control": { "type": "ephemeral" } }],
            "messages": [{ "role": "user", "content": [{ "type": "text", "text": user }] }],
            "fallbacks": "default",
        }), &mut vec![])
        .await
    }

    /// A request to the Messages API, retried as it says; each retry is noted (a `throttle` event for the run's record).
    async fn send(&self, body: &Value, notes: &mut Vec<Value>) -> Result<Value, String> {
        let mut wait = Duration::from_secs(2);
        for attempt in 0..4 {
            let res = self
                .http
                .post(format!("{}/v1/messages", self.model.base_url.trim_end_matches('/')))
                .header("x-api-key", self.model.api_key.as_deref().unwrap_or_default())
                .header("anthropic-version", API_VERSION)
                .header("anthropic-beta", FALLBACK_BETA)
                .json(body)
                .send()
                .await;
            let retry = match res {
                Ok(r) if r.status().is_success() => return r.json::<Value>().await.map_err(|e| format!("the model's answer: {e}")),
                Ok(r) => {
                    let status = r.status();
                    let should = r.headers().get("x-should-retry").and_then(|v| v.to_str().ok()).map(|v| v == "true");
                    let text = r.text().await.unwrap_or_default();
                    let message = serde_json::from_str::<Value>(&text).ok().and_then(|v| v["error"]["message"].as_str().map(str::to_owned)).unwrap_or(text);
                    let retryable = should.unwrap_or(status.as_u16() == 429 || status.as_u16() == 408 || status.as_u16() == 409 || status.is_server_error());
                    if !retryable || attempt == 3 {
                        return Err(format!("the model answered {status}: {message}"));
                    }
                    notes.push(json!({ "type": "throttle", "model": body["model"], "status": status.as_u16(), "waitMs": wait.as_millis() as u64, "reason": message }));
                    message
                }
                Err(e) if attempt == 3 => return Err(format!("reaching the model: {e}")),
                Err(e) => {
                    notes.push(json!({ "type": "throttle", "model": body["model"], "waitMs": wait.as_millis() as u64, "reason": e.to_string() }));
                    e.to_string()
                }
            };
            eprintln!("agent: retrying a model call ({retry})");
            tokio::time::sleep(wait).await;
            wait *= 2;
        }
        unreachable!("the last attempt returns")
    }
}

/// An assistant turn as it may be sent back: after a fallback mid-answer, what the declining model started (its
/// thinking and tool calls) is left out before the last `fallback` block, which stays where it was.
fn echoable(content: &[Value]) -> Vec<Value> {
    let Some(last) = content.iter().rposition(|b| b["type"] == "fallback") else { return content.to_vec() };
    content
        .iter()
        .enumerate()
        .filter(|(i, b)| *i >= last || !matches!(b["type"].as_str(), Some("thinking" | "redacted_thinking" | "tool_use" | "server_tool_use")))
        .map(|(_, b)| b.clone())
        .collect()
}

#[derive(Deserialize)]
pub struct TurnRequest {
    view: String,
    session: Option<String>,
    message: String,
    files: BTreeMap<String, String>,
    /// read-only files, as base64: a viz's `files/<label>`
    #[serde(default)]
    binary: BTreeMap<String, String>,
    /// the brief kept with the draft, which the agent reads as SPEC.md
    #[serde(default)]
    spec: Option<String>,
    #[serde(default)]
    gestalts: Vec<String>,
    #[serde(default)]
    diagnostics: Vec<Value>,
    /// to the question the conversation waits on
    #[serde(default)]
    answer: Option<Answer>,
}

/// The first instant of this calendar month, as the budget counts.
pub(crate) fn month_start() -> String {
    format!("{}-01T00:00:00.000Z", &now_iso()[..7])
}

async fn status(State(state): State<AppState>, me: SignedIn, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let (draft, _) = state.own_draft(&me, &id)?;
    let reason = match state.agents.unavailable(Some(&draft.kind)) {
        Some(r) => Some(r),
        None if state.db.tokens_since(&me.0.id, &month_start())? >= me.0.token_budget => Some("this month's budget for the agent is used up".into()),
        None => None,
    };
    let mut out = match reason {
        Some(r) => json!({ "available": false, "reason": r }),
        None => json!({ "available": true }),
    };
    // an open question is the draft's, whichever device asks
    if let Some(s) = state.load_session(&draft.id).filter(|s| s.account == me.0.id)
        && let Some(a) = s.ask
    {
        out["ask"] = json!({ "session": s.session, "id": a.id, "questions": a.questions });
    }
    Ok(Json(out))
}

async fn turn(State(state): State<AppState>, me: SignedIn, Path(id): Path<String>, Json(req): Json<TurnRequest>) -> ApiResult<(StatusCode, Json<Value>)> {
    let (draft, _) = state.own_draft(&me, &id)?;
    let kind = state.agents.reference.kind(&draft.kind).ok_or_else(|| ApiError::Conflict(format!("the agent doesn't work on a draft of kind {}", draft.kind)))?;
    if req.view != draft.id {
        return Err(ApiError::BadRequest("view: not this draft".into()));
    }
    if req.message.trim().is_empty() && req.answer.is_none() {
        return Err(ApiError::BadRequest("message is empty".into()));
    }
    if let Some(a) = &req.answer {
        let open = state.load_session(&draft.id).filter(|s| s.account == me.0.id && req.session.as_deref() == Some(&s.session)).and_then(|s| s.ask);
        if open.is_none_or(|o| o.id != a.id) {
            return Err(ApiError::Conflict("that question isn't open any more".into()));
        }
    }
    if let Some(p) = req.files.keys().find(|p| !kind.is_draft_file(p)) {
        return Err(ApiError::BadRequest(format!("files: {p} isn't part of a draft of kind {}", draft.kind)));
    }
    if let Some(p) = req.binary.keys().find(|p| !p.starts_with("files/") || p.split('/').count() != 2) {
        return Err(ApiError::BadRequest(format!("binary: {p} isn't one of the draft's files/")));
    }
    if let Some(r) = state.agents.unavailable(Some(&draft.kind)) {
        return Err(ApiError::Conflict(r));
    }
    if state.db.tokens_since(&me.0.id, &month_start())? >= me.0.token_budget {
        return Err(ApiError::TooMany("this month's budget for the agent is used up".into()));
    }
    state.agents.prune();
    let job = {
        let mut jobs = state.agents.jobs.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if jobs.values().any(|j| j.account == me.0.id && !j.done.load(Ordering::SeqCst)) {
            return Err(ApiError::Conflict("a turn is already running: wait for it, or stop it".into()));
        }
        let job = Arc::new(Job {
            id: random_hex(16),
            account: me.0.id.clone(),
            draft: draft.id.clone(),
            kind: draft.kind.clone(),
            waiting: Mutex::default(),
            events: Mutex::default(),
            done: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
            changed: Notify::new(),
            cancel: Notify::new(),
            finished: Mutex::new(None),
        });
        jobs.insert(job.id.clone(), job.clone());
        job
    };
    state.db.add_turn(&job.id, &me.0.id, &draft.id, &now_iso())?;
    let id = job.id.clone();
    tokio::spawn(run_turn(state.clone(), job, req));
    Ok((StatusCode::ACCEPTED, Json(json!({ "job": id }))))
}

/// The user's message, with what changed since the agent last saw the draft and what went wrong meanwhile.
fn opening(req: &TurnRequest, last: Option<&BTreeMap<String, String>>, extra: &BTreeMap<String, String>) -> String {
    let mut text = req.message.clone();
    if let Some(last) = last {
        let changed: Vec<&String> = last.keys().chain(req.files.keys()).filter(|p| last.get(*p) != req.files.get(*p)).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
        if !changed.is_empty() {
            text.push_str(&format!("\n\n(Changed since your last turn, outside this conversation: {}. Read them again before relying on what you remember.)", changed.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")));
        }
    } else {
        text.push_str(&format!("\n\n(The draft's files now: {}.)", req.files.keys().cloned().collect::<Vec<_>>().join(", ")));
        if !extra.is_empty() {
            text.push_str(&format!("\n\n(To read besides: {}.)", extra.keys().cloned().collect::<Vec<_>>().join(", ")));
        }
    }
    if !req.diagnostics.is_empty() {
        text.push_str("\n\n(Since your last turn the preview reported these errors, or saving refused these files. Fix them first.)");
        for d in req.diagnostics.iter().take(20) {
            let stack = d["stack"].as_str().map(|s| s.lines().take(8).collect::<Vec<_>>().join("\n")).unwrap_or_default();
            text.push_str(&format!("\n- {}: {}{}", d["kind"].as_str().unwrap_or("error"), d["message"].as_str().unwrap_or_default(), if stack.is_empty() { String::new() } else { format!("\n  {stack}") }));
        }
    }
    text
}

/// What the turn may read besides the draft: its brief as SPEC.md, and a viz's files where they're text.
fn extra_files(req: &TurnRequest) -> BTreeMap<String, String> {
    use base64::Engine as _;
    let mut out = BTreeMap::new();
    if let Some(spec) = req.spec.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        out.insert("SPEC.md".to_owned(), format!("{spec}\n"));
    }
    for (p, b64) in &req.binary {
        let bytes = base64::engine::general_purpose::STANDARD.decode(b64).unwrap_or_default();
        let text = match String::from_utf8(bytes) {
            Ok(t) if t.len() <= MAX_READ_BYTES => t,
            Ok(t) => format!("({} bytes of text: too long to read here; the check imports it as the viz does)", t.len()),
            Err(e) => format!("({} bytes, not text: the check imports it as the viz does)", e.as_bytes().len()),
        };
        out.insert(p.clone(), text);
    }
    out
}

/// How long a tool handed to the page may take, as the Claude bridge waits on one.
const PAGE_TOOL_WAIT: Duration = Duration::from_secs(600);

/// The kind's check: a view's in the worker; a viz's rendered where `GESTALTS_VIZ_RENDER` says, with its screenshots.
async fn check(state: &AppState, job: &Job, ws: &Workspace<'_>, req: &TurnRequest, input: &Value) -> ToolOut {
    match ws.kind.kind {
        "view" => match state.worker.check(&ws.files, ws.gestalts).await {
            Ok((ok, output)) => (json!(output), !ok),
            Err(e) => (json!(format!("the check couldn't run: {e}")), true),
        },
        _ => match state.agents.viz_render {
            VizRender::Worker => match state.worker.check_viz(&ws.files, &req.binary).await {
                Ok((ok, content)) => (api_content(&content), !ok),
                Err(e) => (json!(format!("the check couldn't run: {e}")), true),
            },
            VizRender::Page => page_tool(job, "check", input, &ws.files).await,
        },
    }
}

/// A tool handed to the workshop page the turn came from, which answers it as it does the Claude bridge's: the page
/// sees a `tool_call` event and posts `tool_result`.
async fn page_tool(job: &Job, name: &str, input: &Value, files: &BTreeMap<String, String>) -> ToolOut {
    let id = random_hex(8);
    let (tx, rx) = tokio::sync::oneshot::channel();
    job.waiting.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(id.clone(), tx);
    let cancelled = job.cancel.notified();
    job.emit(json!({ "type": "tool_call", "id": id, "name": name, "input": input, "files": files }));
    if job.cancelled.load(Ordering::SeqCst) {
        return (json!("stopped"), true);
    }
    let out = tokio::select! {
        r = tokio::time::timeout(PAGE_TOOL_WAIT, rx) => match r {
            Ok(Ok(out)) => out,
            _ => (json!(format!("{name} runs in the workshop page, which didn't answer: the page has to stay open while the agent works on this")), true),
        },
        () = cancelled => (json!("stopped"), true),
    };
    job.waiting.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(&id);
    out
}

async fn run_turn(state: AppState, job: Arc<Job>, req: TurnRequest) {
    let agents = &state.agents;
    let stored = state.load_session(&job.draft).filter(|s| s.account == job.account && req.session.as_deref() == Some(&s.session));
    let (session_id, mut messages, last, open) = match stored {
        Some(s) => (s.session, s.messages, Some(s.files), s.ask),
        None => (random_hex(16), Vec::new(), None, None),
    };
    let before = messages.len();
    let mut first = Vec::new();
    // the question it waits on is answered first: with what was picked, or with what was written instead
    if let Some(a) = &open {
        first.extend(a.results.iter().cloned());
        let text = match &req.answer {
            Some(answer) if answer.id == a.id => answer_text(answer),
            _ => "They didn't pick an option, and wrote the message below instead.".into(),
        };
        job.emit(json!({ "type": "tool", "name": "ask", "summary": "answered" }));
        first.push(json!({ "type": "tool_result", "tool_use_id": a.id, "content": text }));
    }
    let Some(kind) = agents.reference.kind(&job.kind) else {
        job.emit(json!({ "type": "error", "message": format!("the agent doesn't work on a draft of kind {}", job.kind) }));
        job.emit(json!({ "type": "done" }));
        job.finish();
        return;
    };
    let extra = extra_files(&req);
    let opening = opening(&req, last.as_ref(), &extra);
    if !opening.trim().is_empty() {
        first.push(json!({ "type": "text", "text": opening.trim() }));
    }
    messages.push(json!({ "role": "user", "content": first }));
    let mut asked: Option<Ask> = None;
    let mut ws = Workspace { files: req.files.clone(), extra, gestalts: &req.gestalts, kind };
    let system = agents.systems.get(kind.kind).and_then(|s| s.as_ref().ok()).cloned().unwrap_or_default();
    let tools = Value::Array(kind.tools(&SERVER_AGENT));

    let outcome: Result<(), String> = async {
        for _ in 0..MAX_STEPS {
            if job.cancelled.load(Ordering::SeqCst) {
                return Err("stopped".into());
            }
            let mut notes = vec![];
            let asked_at = std::time::Instant::now();
            let resp = tokio::select! {
                r = agents.call_model(&system, &tools, &messages, &mut notes) => r,
                () = job.cancel.notified() => return Err("stopped".into()),
            };
            for n in notes { job.emit(n); }
            let resp = resp?;
            let u = &resp["usage"];
            let n = |k: &str| u[k].as_i64().unwrap_or(0);
            let _ = state.db.add_usage(&job.id, n("input_tokens"), n("output_tokens"), n("cache_read_input_tokens"), n("cache_creation_input_tokens"));
            // for the run's record: what this request used, and the answer as it came
            job.emit(json!({
                "type": "usage", "model": resp["model"], "input": n("input_tokens"), "output": n("output_tokens"),
                "cacheRead": n("cache_read_input_tokens"), "cacheWrite": n("cache_creation_input_tokens"),
                "ms": asked_at.elapsed().as_millis() as u64, "billing": "api",
            }));
            job.emit(json!({ "type": "trace", "source": "claude-api", "data": resp }));
            let stop = resp["stop_reason"].as_str().unwrap_or_default().to_owned();
            if stop == "refusal" {
                return Err("The agent declined this request. Try putting it differently.".into());
            }
            let content = echoable(resp["content"].as_array().map(Vec::as_slice).unwrap_or_default());
            for b in &content {
                if b["type"] == "text" && b["text"].as_str().is_some_and(|t| !t.trim().is_empty()) {
                    job.emit(json!({ "type": "text", "text": b["text"] }));
                }
            }
            if !content.is_empty() {
                messages.push(json!({ "role": "assistant", "content": content }));
            }
            match stop.as_str() {
                "tool_use" => {
                    let mut results = Vec::new();
                    let mut question: Option<(String, Value)> = None;
                    for b in content.iter().filter(|b| b["type"] == "tool_use") {
                        let name = b["name"].as_str().unwrap_or_default();
                        if name == "ask" {
                            let id = b["id"].as_str().unwrap_or_default().to_owned();
                            match (&question, questions(&b["input"])) {
                                (None, Ok(q)) => question = Some((id, q)),
                                (Some(_), _) => results.push(json!({ "type": "tool_result", "tool_use_id": id, "content": "ask: one card per turn; this one wasn't shown", "is_error": true })),
                                (None, Err(e)) => results.push(json!({ "type": "tool_result", "tool_use_id": id, "content": e, "is_error": true })),
                            }
                            continue;
                        }
                        job.emit(json!({ "type": "tool", "name": name, "summary": summary(name, &b["input"]) }));
                        let ran_at = std::time::Instant::now();
                        let (content, is_error) = if name == "check" {
                            check(&state, &job, &ws, &req, &b["input"]).await
                        } else {
                            match ws.run(name, &b["input"]) { Ok(t) => (json!(t), false), Err(t) => (json!(t), true) }
                        };
                        job.emit(json!({ "type": "tool_result", "name": name, "ok": !is_error, "ms": ran_at.elapsed().as_millis() as u64, "content": page_content(&content) }));
                        results.push(json!({ "type": "tool_result", "tool_use_id": b["id"], "content": content, "is_error": is_error }));
                    }
                    if let Some((id, questions)) = question {
                        // the turn ends here, with the call open, until the person answers
                        job.emit(json!({ "type": "ask", "id": id, "questions": questions }));
                        asked = Some(Ask { id, questions, results });
                        return Ok(());
                    }
                    messages.push(json!({ "role": "user", "content": results }));
                }
                // the server paused a long turn: send it back as it is to go on
                "pause_turn" => {}
                "max_tokens" => return Err("The agent's answer got too long and was cut off. Ask for a smaller step.".into()),
                _ => return Ok(()),
            }
        }
        Err(format!("The turn took more than {MAX_STEPS} steps and was stopped. Ask for a smaller step."))
    }
    .await;

    // the files are the work: they come back whether or not the turn ended well
    let changed: BTreeMap<String, Value> = ws.files.iter().filter(|(p, t)| req.files.get(*p) != Some(*t)).map(|(p, t)| (p.clone(), json!(t)))
        .chain(req.files.keys().filter(|p| !ws.files.contains_key(*p)).map(|p| (p.clone(), Value::Null)))
        .collect();
    if !changed.is_empty() {
        job.emit(json!({ "type": "files", "files": changed }));
    }
    let ask = match outcome {
        Ok(()) => asked,
        Err(e) => {
            // the conversation goes on from before this turn, waiting on what it waited on: what's left of it may not
            // be a valid one
            messages.truncate(before);
            job.emit(json!({ "type": "error", "message": e }));
            open
        }
    };
    let waiting = ask.is_some();
    let session = Session { session: session_id.clone(), account: job.account.clone(), draft: job.draft.clone(), messages, files: ws.files, ask, touched: crate::now_ms() };
    if let Err(e) = state.save_session(&session) {
        eprintln!("agent: keeping the conversation of {}: {e}", job.draft);
    }
    job.emit(json!({ "type": "done", "session": session_id, "waiting": waiting }));
    job.finish();
}

#[derive(Deserialize)]
struct Complete {
    system: String,
    prompt: String,
}

/// One answer for a feature built on the agent (`AgentBackend.complete`): what it's for is the page's, not this.
async fn complete(State(state): State<AppState>, me: SignedIn, Path(id): Path<String>, Json(req): Json<Complete>) -> ApiResult<Json<Value>> {
    let (draft, _) = state.own_draft(&me, &id)?;
    if req.prompt.trim().is_empty() || req.prompt.chars().count() > 8_000 || req.system.chars().count() > 20_000 {
        return Err(ApiError::BadRequest("a prompt of up to 8000 characters, instructions of up to 20000".into()));
    }
    if let Some(r) = state.agents.unavailable(None) {
        return Err(ApiError::Conflict(r));
    }
    if state.db.tokens_since(&me.0.id, &month_start())? >= me.0.token_budget {
        return Err(ApiError::TooMany("this month's budget for the agent is used up".into()));
    }
    let turn = random_hex(16);
    state.db.add_turn(&turn, &me.0.id, &draft.id, &now_iso())?;
    let resp = state.agents.call_once(&req.system, req.prompt.trim()).await.map_err(ApiError::Conflict)?;
    let u = &resp["usage"];
    let n = |k: &str| u[k].as_i64().unwrap_or(0);
    let _ = state.db.add_usage(&turn, n("input_tokens"), n("output_tokens"), n("cache_read_input_tokens"), n("cache_creation_input_tokens"));
    if resp["stop_reason"] == "refusal" {
        return Err(ApiError::Conflict("The agent declined this request. Try putting it differently.".into()));
    }
    let text: String = resp["content"].as_array().into_iter().flatten().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect();
    Ok(Json(json!({ "text": text })))
}

#[derive(Deserialize)]
struct EventsQuery {
    job: String,
    #[serde(default)]
    after: usize,
}

fn own_job(state: &AppState, me: &SignedIn, job: &str) -> ApiResult<Arc<Job>> {
    state.agents.jobs.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(job).filter(|j| j.account == me.0.id).cloned().ok_or(ApiError::NotFound)
}

async fn events(State(state): State<AppState>, me: SignedIn, Path(_id): Path<String>, Query(q): Query<EventsQuery>) -> ApiResult<Json<Value>> {
    let job = own_job(&state, &me, &q.job)?;
    let deadline = Instant::now() + EVENT_POLL;
    loop {
        let changed = job.changed.notified();
        {
            let events = job.events.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            let done = job.done.load(Ordering::SeqCst);
            if events.len() > q.after || done {
                let page: Vec<Value> = events.iter().skip(q.after).cloned().collect();
                return Ok(Json(json!({ "events": page, "next": events.len(), "done": done })));
            }
        }
        if tokio::time::timeout(deadline.saturating_duration_since(Instant::now()), changed).await.is_err() {
            return Ok(Json(json!({ "events": [], "next": q.after, "done": false })));
        }
    }
}

#[derive(Deserialize)]
struct Cancel {
    job: String,
}

/// The page's answer to a tool the turn handed it (`page_tool`), as MCP content.
#[derive(Deserialize)]
struct PageResult {
    job: String,
    id: String,
    #[serde(default)]
    content: Vec<Value>,
    #[serde(default, rename = "isError")]
    is_error: bool,
}

async fn tool_result(State(state): State<AppState>, me: SignedIn, Path(_id): Path<String>, Json(req): Json<PageResult>) -> ApiResult<Json<Value>> {
    let job = own_job(&state, &me, &req.job)?;
    let tx = job.waiting.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(&req.id).ok_or(ApiError::NotFound)?;
    let _ = tx.send((api_content(&req.content), req.is_error));
    Ok(Json(json!({})))
}

async fn cancel(State(state): State<AppState>, me: SignedIn, Path(_id): Path<String>, Json(req): Json<Cancel>) -> ApiResult<Json<Value>> {
    let job = own_job(&state, &me, &req.job)?;
    job.cancelled.store(true, Ordering::SeqCst);
    job.cancel.notify_waiters();
    Ok(Json(json!({})))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/drafts/{id}/agent/status", get(status))
        .route("/drafts/{id}/agent/turn", post(turn))
        .route("/drafts/{id}/agent/complete", post(complete))
        .route("/drafts/{id}/agent/events", get(events))
        .route("/drafts/{id}/agent/cancel", post(cancel))
        .route("/drafts/{id}/agent/tool_result", post(tool_result))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_comes_before_a_fallback_is_left_out_but_the_fallback_stays() {
        let content = vec![json!({"type": "thinking", "thinking": ""}), json!({"type": "text", "text": "a"}), json!({"type": "tool_use", "id": "x"}), json!({"type": "fallback"}), json!({"type": "thinking"}), json!({"type": "tool_use", "id": "y"})];
        let kept: Vec<String> = echoable(&content).iter().map(|b| b["type"].as_str().unwrap().to_owned()).collect();
        assert_eq!(kept, ["text", "fallback", "thinking", "tool_use"]);
        assert_eq!(echoable(&content[..3]).len(), 3);
    }
}
