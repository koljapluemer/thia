//! Thia as a remote MCP server (`web/server/doc/mcp.md`): a chat host (claude.ai, as a custom connector) works on an
//! account's view drafts with the same tools and contract as the server's own agent (`crate::drafting`), and the
//! person watches the draft in the workshop. The host runs the loop and asks the person in its own conversation; thia
//! saves each write as the workshop would, checks the draft, and records each request as a run
//! (`runs::server_run`), so the host is compared with the other backends like any of them.
//!
//! - `POST /mcp`: JSON-RPC over Streamable HTTP, answered as JSON (no streams): `initialize`, `ping`, `tools/list`,
//!   `tools/call`. A bearer token from [`oauth`]; a session (`Mcp-Session-Id`) from `initialize` on.
//! - `DELETE /mcp`: the transport session ends; its logical request remains open
//! - signed in, under `/api/drafts/{id}/`: `POST diagnostics` (what the workshop's preview reports, for `check`),
//!   `GET mcp` (whether a host works on it now, and its recent runs there)

pub mod oauth;
mod tools;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::{Path, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::auth::SignedIn;
use crate::runs::server_run::ServerRun;
use crate::{ApiResult, AppState, random_hex};
use oauth::Bearer;

/// The protocol versions this speaks, newest first.
const PROTOCOLS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26"];
/// A run with no call for this long has ended.
pub const RUN_IDLE: Duration = Duration::from_secs(15 * 60);
/// A session with no call for this long is gone (the host starts another).
const SESSION_IDLE: Duration = Duration::from_secs(24 * 3600);
/// tool calls per account and minute, at most: the check runs in the worker
const CALLS_PER_MINUTE: u32 = 120;
/// A draft a host called a tool on this recently is being worked on: the workshop syncs it more often.
const ACTIVE: Duration = Duration::from_secs(120);

const INSTRUCTIONS: &str = "thia makes interactive views for learners: small apps a teacher hands to a class. With these \
tools you work on the person's drafts in thia, which they watch in thia's workshop as you change them. At the start of \
each request about a draft, call `open_draft` with what they asked: it gives you the contract every view keeps and the \
draft's files. Make a new draft with `new_draft` when they want something new. Run `check` before you say a change is \
done, and when you're done with the request call `finish` with a line on what you did.";

/// A host's transport session: whose it is, what it said it is, and its last logical request.
pub struct Session {
    pub account: String,
    /// `clientInfo` from `initialize`: `{name, version}`
    pub client: Value,
    last: Instant,
    /// Logical request last opened on this transport session. A host may use a fresh
    /// transport session for every tool call, so the run itself lives in `Mcp::work`.
    pub work: Option<String>,
    /// drafts made in this session, so the run that follows says so
    pub created: HashSet<String>,
}

/// A logical request, independent of the transport session carrying its calls.
pub struct Open {
    pub run: ServerRun,
    pub account: String,
    pub draft: String,
    pub client: Value,
    pub last: Instant,
}

/// What the preview in the workshop last reported for a draft, and when.
pub struct Reported {
    pub errors: Vec<Value>,
    pub at: Instant,
}

#[derive(Default)]
pub struct Mcp {
    sessions: Mutex<HashMap<String, Arc<tokio::sync::Mutex<Session>>>>,
    /// Logical requests, independent of the MCP transport sessions carrying their calls.
    work: Mutex<HashMap<String, Arc<tokio::sync::Mutex<Open>>>>,
    pub registrations: oauth::Registrations,
    /// by draft: what its preview reported
    diagnostics: Mutex<HashMap<String, Reported>>,
    /// by draft: when a host last called a tool on it, and last saved a change to it
    touched: Mutex<HashMap<String, (Instant, Option<Instant>)>>,
    /// by account: calls in the current minute
    calls: Mutex<HashMap<String, (Instant, u32)>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Mcp {
    fn allow_call(&self, account: &str) -> bool {
        let mut calls = lock(&self.calls);
        let (since, n) = calls.entry(account.to_owned()).or_insert((Instant::now(), 0));
        if since.elapsed() > Duration::from_secs(60) { *since = Instant::now(); *n = 0; }
        *n += 1;
        *n <= CALLS_PER_MINUTE
    }

    fn touch(&self, draft: &str, saved: bool) {
        let mut t = lock(&self.touched);
        let e = t.entry(draft.to_owned()).or_insert((Instant::now(), None));
        e.0 = Instant::now();
        if saved { e.1 = Some(Instant::now()); }
    }

    /// When a host last saved a change to the draft.
    pub fn saved_at(&self, draft: &str) -> Option<Instant> {
        lock(&self.touched).get(draft).and_then(|t| t.1)
    }

    /// What the draft's preview last reported, if a workshop tab has it open: the errors, and when.
    pub fn reported(&self, draft: &str) -> Option<(Vec<Value>, Instant)> {
        lock(&self.diagnostics).get(draft).map(|r| (r.errors.clone(), r.at))
    }

    /// Ends the runs no call came for in [`RUN_IDLE`], and forgets sessions idle for longer than [`SESSION_IDLE`].
    pub async fn sweep(&self, state: &AppState) {
        let all: Vec<(String, Arc<tokio::sync::Mutex<Session>>)> = lock(&self.sessions).iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        let mut gone = vec![];
        for (id, s) in all {
            // one in use isn't idle
            let Ok(s) = s.try_lock() else { continue };
            if s.last.elapsed() > SESSION_IDLE { gone.push(id); }
        }
        {
            let mut sessions = lock(&self.sessions);
            for id in gone { sessions.remove(&id); }
        }
        let all: Vec<(String, Arc<tokio::sync::Mutex<Open>>)> = lock(&self.work).iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        let mut ended = vec![];
        for (id, open) in all {
            let Ok(mut open) = open.try_lock() else { continue };
            if open.last.elapsed() > RUN_IDLE {
                tools::end_run(state, &mut open, "idle").await;
                ended.push(id);
            }
        }
        let mut work = lock(&self.work);
        for id in ended { work.remove(&id); }
        lock(&self.diagnostics).retain(|_, r| r.at.elapsed() < SESSION_IDLE);
        lock(&self.touched).retain(|_, t| t.0.elapsed() < SESSION_IDLE);
    }
}

/// A JSON-RPC error answer.
fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn rpc_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn json_response(status: StatusCode, body: &Value, session: Option<&str>) -> Response {
    let mut res = (status, Json(body.clone())).into_response();
    if let Some(s) = session && let Ok(v) = HeaderValue::from_str(s) {
        res.headers_mut().insert("mcp-session-id", v);
    }
    res
}

fn session_of(headers: &HeaderMap) -> Option<String> {
    headers.get("mcp-session-id").and_then(|v| v.to_str().ok()).map(str::to_owned)
}

async fn post_mcp(State(state): State<AppState>, headers: HeaderMap, Bearer(account): Bearer, body: Bytes) -> Response {
    state.mcp.sweep(&state).await;
    let Ok(msg) = serde_json::from_slice::<Value>(&body) else {
        return json_response(StatusCode::BAD_REQUEST, &rpc_error(Value::Null, -32700, "parse error"), None);
    };
    // initialize opens a session; everything else is of one
    if msg["method"] == "initialize" {
        let id = random_hex(16);
        let asked = msg["params"]["protocolVersion"].as_str().unwrap_or_default();
        let protocol = if PROTOCOLS.contains(&asked) { asked } else { PROTOCOLS[0] };
        let client = json!({ "name": msg["params"]["clientInfo"]["name"].as_str().unwrap_or("MCP"), "version": msg["params"]["clientInfo"]["version"] });
        let session = Session { account: account.id.clone(), client, last: Instant::now(), work: None, created: HashSet::new() };
        lock(&state.mcp.sessions).insert(id.clone(), Arc::new(tokio::sync::Mutex::new(session)));
        let result = json!({
            "protocolVersion": protocol,
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": "thia", "title": "thia", "version": env!("CARGO_PKG_VERSION") },
            "instructions": INSTRUCTIONS,
        });
        return json_response(StatusCode::OK, &rpc_result(msg["id"].clone(), result), Some(&id));
    }
    let Some(sid) = session_of(&headers) else {
        return json_response(StatusCode::BAD_REQUEST, &rpc_error(msg["id"].clone(), -32600, "no Mcp-Session-Id: initialize first"), None);
    };
    let found = lock(&state.mcp.sessions).get(&sid).cloned();
    let Some(session) = found else {
        // gone (the server restarted, or it was idle): the host initializes again
        return json_response(StatusCode::NOT_FOUND, &rpc_error(msg["id"].clone(), -32001, "no such session: initialize again"), None);
    };
    let mut session = session.lock().await;
    if session.account != account.id {
        return json_response(StatusCode::NOT_FOUND, &rpc_error(msg["id"].clone(), -32001, "no such session: initialize again"), None);
    }
    session.last = Instant::now();
    let messages = match msg {
        Value::Array(batch) => batch,
        one => vec![one],
    };
    let mut answers = vec![];
    for m in messages {
        // notifications and answers to us get none
        let Some(id) = m.get("id").cloned().filter(|_| m.get("method").is_some()) else { continue };
        let answer = match m["method"].as_str().unwrap_or_default() {
            "ping" => rpc_result(id, json!({})),
            "tools/list" => rpc_result(id, json!({ "tools": tools::list(&state) })),
            "tools/call" => {
                let name = m["params"]["name"].as_str().unwrap_or_default();
                let args = m["params"].get("arguments").cloned().unwrap_or_else(|| json!({}));
                let result = if state.mcp.allow_call(&account.id) {
                    tools::call(&state, &account, &mut session, &sid, name, &args).await
                } else {
                    tools::error("Too many calls in a minute: wait a little, then go on.")
                };
                rpc_result(id, result)
            }
            other => rpc_error(id, -32601, &format!("no method {other}")),
        };
        answers.push(answer);
    }
    match answers.len() {
        0 => StatusCode::ACCEPTED.into_response(),
        1 => json_response(StatusCode::OK, &answers[0], None),
        _ => json_response(StatusCode::OK, &Value::Array(answers), None),
    }
}

/// A transport session ending does not end a logical request: some hosts create and
/// delete one transport session per tool call. `finish` or idleness ends the run.
async fn delete_mcp(State(state): State<AppState>, headers: HeaderMap, Bearer(account): Bearer) -> Response {
    let Some(sid) = session_of(&headers) else { return StatusCode::BAD_REQUEST.into_response() };
    let found = lock(&state.mcp.sessions).get(&sid).cloned();
    let Some(session) = found else { return StatusCode::NOT_FOUND.into_response() };
    let s = session.lock().await;
    if s.account != account.id { return StatusCode::NOT_FOUND.into_response(); }
    drop(s);
    lock(&state.mcp.sessions).remove(&sid);
    StatusCode::NO_CONTENT.into_response()
}

/// No stream from the server: everything is an answer to a POST.
async fn get_mcp() -> Response {
    (StatusCode::METHOD_NOT_ALLOWED, [(header::ALLOW, "POST, DELETE")]).into_response()
}

/// Anyone's browser may call these (an MCP client in a page): they take bearer tokens, never cookies.
async fn cors(req: Request, next: Next) -> Response {
    let preflight = req.method() == Method::OPTIONS;
    let mut res = if preflight { StatusCode::NO_CONTENT.into_response() } else { next.run(req).await };
    let h = res.headers_mut();
    h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    h.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, POST, DELETE, OPTIONS"));
    h.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("authorization, content-type, mcp-session-id, mcp-protocol-version"));
    h.insert(header::ACCESS_CONTROL_EXPOSE_HEADERS, HeaderValue::from_static("mcp-session-id, www-authenticate"));
    res
}

#[derive(Deserialize)]
struct Diagnostics {
    errors: Vec<Value>,
}

/// What the workshop's preview of a draft reports now (none: it runs fine), for a host's `check`.
async fn diagnostics(State(state): State<AppState>, me: SignedIn, Path(id): Path<String>, Json(d): Json<Diagnostics>) -> ApiResult<StatusCode> {
    let (draft, _) = state.own_draft(&me, &id)?;
    let errors: Vec<Value> = d.errors.into_iter().take(20).map(|e| json!({
        "kind": e["kind"].as_str().unwrap_or("runtime"),
        "message": e["message"].as_str().unwrap_or_default().chars().take(2000).collect::<String>(),
        "stack": e["stack"].as_str().map(|s| s.lines().take(8).collect::<Vec<_>>().join("\n")),
    })).collect();
    lock(&state.mcp.diagnostics).insert(draft.id, Reported { errors, at: Instant::now() });
    Ok(StatusCode::NO_CONTENT)
}

/// For the workshop: whether a host works on the draft now, and the host's recent runs on it, to rate.
async fn draft_runs(State(state): State<AppState>, me: SignedIn, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let (draft, _) = state.own_draft(&me, &id)?;
    let active = lock(&state.mcp.touched).get(&draft.id).is_some_and(|t| t.0.elapsed() < ACTIVE);
    let f = crate::runs::Filter { draft: Some(draft.id.clone()), backend: Some(crate::drafting::MCP.id.into()), ..Default::default() };
    let rows = state.db.with(|c| crate::runs::rows(c, &f, 10, false))?;
    let mut runs = vec![];
    for r in rows.into_iter().filter(|r| r.account == me.0.id) {
        let summary = state.db.with(|c| crate::runs::index::load(c, &r.id))?.map(|(s, _)| s).unwrap_or_default();
        runs.push(json!({
            "id": r.id, "started": r.started, "outcome": r.outcome, "checkOk": r.check_ok, "filesChanged": r.files_changed,
            "rating": r.rating, "comment": r.comment, "message": summary.message, "label": summary.backend_label,
            "open": r.outcome.is_none(),
        }));
    }
    Ok(Json(json!({ "active": active, "runs": runs })))
}

/// `/mcp` and what signs a host in, at the root of the app's origin.
pub fn public_routes() -> Router<AppState> {
    Router::new()
        .route("/mcp", post(post_mcp).delete(delete_mcp).get(get_mcp))
        .merge(oauth::public_routes())
        .layer(axum::middleware::from_fn(cors))
}

/// What the workshop asks, signed in, under `/api`.
pub fn api_routes() -> Router<AppState> {
    Router::new()
        .route("/drafts/{id}/diagnostics", post(diagnostics))
        .route("/drafts/{id}/mcp", get(draft_runs))
        .merge(oauth::api_routes())
}
