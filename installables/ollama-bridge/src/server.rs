//! The bridge on 127.0.0.1, as claude-bridge's (`installables/claude-bridge/src/server.rs`): a site asks to be allowed
//! (`POST /pair`, the person confirms in a dialog), then runs turns over a WebSocket (`/runs`), answering the page tools
//! the model calls in them.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, watch};
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::NAME;
use crate::config::{Paths, Tokens};
use crate::ollama::{Ollama, Status};
use crate::run::{self, FromPage, Session, ToPage, Turn};

/// conversations kept in memory, the oldest forgotten first
const SESSIONS: usize = 64;

/// Whether the person lets `origin` run models here (a dialog; blocking).
pub trait Asker: Send + Sync {
    fn allow(&self, origin: &str) -> bool;
}

pub struct Bridge {
    pub paths: Paths,
    /// development: localhost sites are allowed without asking
    pub dev: bool,
    pub tokens: Mutex<Tokens>,
    asker: Arc<dyn Asker>,
    ollama: Ollama,
    status: Mutex<Option<(Instant, Status)>>,
    sessions: Mutex<(HashMap<String, Session>, VecDeque<String>)>,
    /// (site, workspace) with a turn running
    busy: Mutex<HashSet<(String, String)>>,
    asking: tokio::sync::Mutex<()>,
}

impl Bridge {
    pub fn new(paths: Paths, dev: bool, asker: Arc<dyn Asker>, ollama: Ollama) -> Arc<Bridge> {
        Arc::new(Bridge {
            tokens: Mutex::new(Tokens::load(&paths)), paths, dev, asker, ollama, status: Mutex::new(None),
            sessions: Mutex::default(), busy: Mutex::default(), asking: tokio::sync::Mutex::new(()),
        })
    }

    /// What Ollama has, at most 15 s ago.
    pub async fn status(&self) -> Status {
        if let Some((at, s)) = self.status.lock().expect("status lock").clone() && at.elapsed() < Duration::from_secs(15) { return s; }
        let s = self.ollama.status().await;
        *self.status.lock().expect("status lock") = Some((Instant::now(), s.clone()));
        s
    }

    fn authorized(&self, origin: Option<&str>, token: Option<&str>) -> bool {
        let Some(origin) = origin else { return false };
        (self.dev && is_local(origin)) || token.is_some_and(|t| self.tokens.lock().expect("tokens lock").allows(origin, t))
    }

    fn take_session(&self, id: Option<&str>, owner: &(String, String)) -> Option<Session> {
        let mut s = self.sessions.lock().expect("sessions lock");
        let id = id?;
        if s.0.get(id).is_some_and(|x| &x.owner == owner) {
            s.1.retain(|k| k != id);
            return s.0.remove(id);
        }
        None
    }

    fn keep_session(&self, id: String, session: Session) {
        let mut s = self.sessions.lock().expect("sessions lock");
        s.1.push_back(id.clone());
        s.0.insert(id, session);
        while s.1.len() > SESSIONS {
            if let Some(old) = s.1.pop_front() { s.0.remove(&old); }
        }
    }
}

/// `http://localhost:<port>` and the like: a page on this computer (development).
fn is_local(origin: &str) -> bool {
    let rest = origin.strip_prefix("http://").unwrap_or("");
    let host = rest.rsplit_once(':').map_or(rest, |(h, p)| if p.chars().all(|c| c.is_ascii_digit()) { h } else { rest });
    matches!(host, "localhost" | "127.0.0.1" | "[::1]")
}

/// An origin as browsers send it: scheme and host, no path.
fn is_origin(o: &str) -> bool {
    let host = o.strip_prefix("https://").or_else(|| o.strip_prefix("http://"));
    host.is_some_and(|h| !h.is_empty() && !h.contains('/')) && o.len() < 300 && o.chars().all(|c| c.is_ascii_graphic())
}

fn origin(headers: &HeaderMap) -> Option<&str> {
    headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()).filter(|o| is_origin(o))
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer "))
}

pub fn app(bridge: Arc<Bridge>) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::mirror_request())
        .allow_methods([axum::http::Method::GET, axum::http::Method::POST])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
        .allow_private_network(true);
    let public = Router::new().route("/status", get(status)).route("/pair", post(pair)).layer(cors);
    Router::new().merge(public).route("/runs", get(runs)).with_state(bridge)
}

/// Serves until `stop` resolves.
pub async fn serve(bridge: Arc<Bridge>, listener: tokio::net::TcpListener, stop: impl std::future::Future<Output = ()> + Send + 'static) -> Result<(), String> {
    axum::serve(listener, app(bridge)).with_graceful_shutdown(stop).await.map_err(|e| e.to_string())
}

async fn status(State(b): State<Arc<Bridge>>, headers: HeaderMap) -> Json<Value> {
    let paired = b.authorized(origin(&headers), bearer(&headers));
    Json(json!({ "app": NAME, "version": env!("CARGO_PKG_VERSION"), "ollama": b.status().await, "paired": paired }))
}

/// A site asks to run models here: the person decides, once per site.
async fn pair(State(b): State<Arc<Bridge>>, headers: HeaderMap) -> Response {
    let Some(origin) = origin(&headers).map(str::to_owned) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "a site asks from a web page (no Origin)" }))).into_response();
    };
    // one dialog at a time
    let _asking = b.asking.lock().await;
    if let Some(t) = b.tokens.lock().expect("tokens lock").0.get(&origin) { return Json(json!({ "token": t })).into_response(); }
    let allowed = (b.dev && is_local(&origin)) || {
        let (asker, o) = (b.asker.clone(), origin.clone());
        tokio::task::spawn_blocking(move || asker.allow(&o)).await.unwrap_or(false)
    };
    if !allowed { return (StatusCode::FORBIDDEN, Json(json!({ "error": "not allowed on this computer" }))).into_response(); }
    let token = uuid::Uuid::new_v4().simple().to_string() + &uuid::Uuid::new_v4().simple().to_string();
    let mut tokens = b.tokens.lock().expect("tokens lock");
    tokens.0.insert(origin, token.clone());
    if let Err(e) = tokens.save(&b.paths) {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": format!("cannot remember the site: {e}") }))).into_response();
    }
    Json(json!({ "token": token })).into_response()
}

#[derive(Deserialize)]
struct RunQuery {
    token: Option<String>,
}

async fn runs(State(b): State<Arc<Bridge>>, headers: HeaderMap, Query(q): Query<RunQuery>, ws: WebSocketUpgrade) -> Response {
    let origin = origin(&headers).map(str::to_owned);
    if !b.authorized(origin.as_deref(), q.token.as_deref()) {
        return (StatusCode::FORBIDDEN, "this site isn't allowed to run models here: pair it first").into_response();
    }
    let origin = origin.expect("authorized has one");
    ws.max_message_size(64 << 20).max_frame_size(64 << 20).on_upgrade(move |socket| session(socket, b, origin))
}

async fn send(sink: &mut futures_util::stream::SplitSink<WebSocket, Message>, ev: &ToPage) -> bool {
    sink.send(Message::Text(serde_json::to_string(ev).unwrap_or_default().into())).await.is_ok()
}

/// One turn over one socket: `start`, then tool results until the model is done. Closing the socket stops it.
async fn session(socket: WebSocket, b: Arc<Bridge>, origin: String) {
    let (mut sink, mut stream) = socket.split();
    let fail = |message: String| ToPage::Error { message };
    let start = match stream.next().await {
        Some(Ok(Message::Text(t))) => match serde_json::from_str::<FromPage>(&t) {
            Ok(FromPage::Start(s)) => s,
            Ok(_) => { let _ = send(&mut sink, &fail("the first message must be `start`".into())).await; return; }
            Err(e) => { let _ = send(&mut sink, &fail(format!("not a request: {e}"))).await; return; }
        },
        _ => return,
    };
    let keep = match run::validate(&start) {
        Ok(k) => k,
        Err(e) => { let _ = send(&mut sink, &fail(e)).await; let _ = send(&mut sink, &ToPage::Done { session: start.session }).await; return; }
    };
    let site = hex(&Sha256::digest(origin.as_bytes())[..8]);
    let owner = (site, start.workspace.clone());
    if !b.busy.lock().expect("busy lock").insert(owner.clone()) {
        let _ = send(&mut sink, &fail("a turn is already running for this draft".into())).await;
        let _ = send(&mut sink, &ToPage::Done { session: start.session }).await;
        return;
    }
    let _busy = Busy(&b.busy, owner.clone());

    let (out, mut out_rx) = mpsc::unbounded_channel();
    let (cancel_tx, cancel_rx) = watch::channel(false);
    let turn = Arc::new(Turn { out, pending: Mutex::default(), cancel: cancel_rx });
    let earlier = b.take_session(start.session.as_deref(), &owner);
    let task = {
        let (b, turn) = (b.clone(), turn.clone());
        tokio::spawn(async move {
            let (id, kept) = run::run(&b.ollama, *start, keep, earlier, owner, &turn).await;
            b.keep_session(id.clone(), kept);
            turn.emit_done(id);
        })
    };
    let mut open = true;
    loop {
        tokio::select! {
            ev = out_rx.recv() => match ev {
                Some(ev) => {
                    let done = matches!(ev, ToPage::Done { .. });
                    if !send(&mut sink, &ev).await { let _ = cancel_tx.send(true); }
                    if done { break; }
                }
                None => break,
            },
            msg = stream.next(), if open => match msg {
                Some(Ok(Message::Text(t))) => match serde_json::from_str::<FromPage>(&t) {
                    Ok(FromPage::ToolResult { id, content, is_error }) => turn.answer(&id, content, is_error),
                    Ok(FromPage::Cancel) => { let _ = cancel_tx.send(true); }
                    _ => {}
                },
                Some(Ok(_)) => {}
                // the page went away: stop, then finish quietly
                _ => { open = false; let _ = cancel_tx.send(true); }
            },
        }
    }
    let _ = task.await;
    let _ = sink.close().await;
}

impl Turn {
    fn emit_done(&self, session: String) { let _ = self.out.send(ToPage::Done { session: Some(session) }); }
}

struct Busy<'a>(&'a Mutex<HashSet<(String, String)>>, (String, String));
impl Drop for Busy<'_> {
    fn drop(&mut self) { self.0.lock().expect("busy lock").remove(&self.1); }
}

fn hex(bytes: &[u8]) -> String { bytes.iter().map(|b| format!("{b:02x}")).collect() }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins() {
        assert!(is_local("http://localhost:5173") && is_local("http://127.0.0.1:1") && is_local("http://[::1]:80") && is_local("http://localhost"));
        assert!(!is_local("https://localhost.example.com") && !is_local("http://localhost.evil:1") && !is_local("https://app.example"));
        assert!(is_origin("https://app.example") && is_origin("http://localhost:5173"));
        assert!(!is_origin("null") && !is_origin("https://a.b/path") && !is_origin("file://"));
    }
}
