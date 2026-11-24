//! A server on a temporary folder, with two accounts and a maintainer at one school, called as the browser calls it.
#![allow(dead_code)]

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use thia_server::worker::WorkerConfig;
use thia_server::{AppState, Limits, Services, db::Db};
use gestalts_account::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

pub struct Server {
    pub state: AppState,
    _dir: tempfile::TempDir,
}

/// The repo's own worker and agent template; a model at `model` (none: the agent is off).
pub fn services(cache: &std::path::Path) -> Services {
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap();
    Services {
        worker: WorkerConfig { node: "node".into(), script: repo.join("web/server/worker/worker.ts"), template: repo.join("packages/workshop/agent-template"), npm_cache: cache.to_owned() },
        lesson_origin: "https://lessons.example".into(),
    }
}

impl Server {
    pub fn new(limits: Limits) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::memory().unwrap();
        db.add_school("s1", "A school", "2026-11-20T00:00:00Z").unwrap();
        let services = services(&dir.path().join("npm-cache"));
        let state = AppState::new(db, dir.path().to_owned(), limits, true, services).unwrap();
        let setup = ServerSetup::<Profile>::deserialize(&std::fs::read(dir.path().join("opaque-setup-v1")).unwrap()).unwrap();
        for (id, school, email) in [
            ("a1", Some("s1"), "ada@school.example"),
            ("a2", Some("s1"), "bea@school.example"),
            ("a3", Some("s1"), "cal@school.example"),
            ("a4", None, "independent@example.com"),
        ] {
            let start = ClientRegistration::start(&mut OsRng, b"right").unwrap();
            let response = ServerRegistration::start(&setup, start.message, email.as_bytes()).unwrap();
            let finish = start.state.finish(&mut OsRng, b"right", response.message,
                ClientRegistrationFinishParameters::new(Default::default(), Some(&hardening()))).unwrap();
            let record = ServerRegistration::finish(finish.message).serialize();
            state.db.add_account(id, school, email, &record, 1_000_000, "2026-11-20T00:00:00Z").unwrap();
        }
        state.db.with(|db| db.execute("UPDATE accounts SET wrapped_key=?1", [STANDARD.encode([0; 60])])).unwrap();
        state.db.set_admin("bea@school.example", true).unwrap();
        state.db.set_maintainer("cal@school.example", true).unwrap();
        Server { state, _dir: dir }
    }

    pub async fn call(&self, method: &str, path: &str, cookie: Option<&str>, body: Option<Value>) -> (StatusCode, Value, Option<String>) {
        let mut req = Request::builder().method(method).uri(path);
        if let Some(c) = cookie {
            req = req.header(header::COOKIE, c);
        }
        let req = match body {
            Some(b) => req.header(header::CONTENT_TYPE, "application/json").body(Body::from(b.to_string())).unwrap(),
            None => req.body(Body::empty()).unwrap(),
        };
        let res = thia_server::app(self.state.clone()).oneshot(req).await.unwrap();
        let status = res.status();
        let set_cookie = res.headers().get(header::SET_COOKIE).map(|v| v.to_str().unwrap().split(';').next().unwrap().to_owned());
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null), set_cookie)
    }

    /// Any request: its headers, and a body with its content type; answered with status, headers and JSON (or null).
    pub async fn raw(&self, method: &str, path: &str, headers: &[(&str, &str)], body: Option<(&str, String)>) -> (StatusCode, axum::http::HeaderMap, Value) {
        let mut req = Request::builder().method(method).uri(path);
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        let req = match body {
            Some((ty, b)) => req.header(header::CONTENT_TYPE, ty).body(Body::from(b)).unwrap(),
            None => req.body(Body::empty()).unwrap(),
        };
        let res = thia_server::app(self.state.clone()).oneshot(req).await.unwrap();
        let (status, headers) = (res.status(), res.headers().clone());
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (status, headers, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    /// A request with a body of bytes, answered with bytes: blobs, exports.
    pub async fn bytes(&self, method: &str, path: &str, cookie: &str, body: Vec<u8>) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
        let req = Request::builder().method(method).uri(path).header(header::COOKIE, cookie).body(Body::from(body)).unwrap();
        let res = thia_server::app(self.state.clone()).oneshot(req).await.unwrap();
        let (status, headers) = (res.status(), res.headers().clone());
        (status, headers, res.into_body().collect().await.unwrap().to_bytes().to_vec())
    }

    /// A GET on the lesson domain: status, headers, body.
    pub async fn lessons(&self, path: &str) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
        let req = Request::builder().uri(path).body(Body::empty()).unwrap();
        let res = thia_server::lessons(self.state.clone()).oneshot(req).await.unwrap();
        let (status, headers) = (res.status(), res.headers().clone());
        (status, headers, res.into_body().collect().await.unwrap().to_bytes().to_vec())
    }

    pub async fn login_exchange(&self, email: &str, password: &[u8]) -> (StatusCode, Option<Value>) {
        let start = ClientLogin::<Profile>::start(&mut OsRng, password).unwrap();
        let (status, body, _) = self.call("POST", "/api/login/start", None, Some(json!({
            "email": email, "message": STANDARD.encode(start.message.serialize()),
        }))).await;
        if status != StatusCode::OK { return (status, None); }
        let response = STANDARD.decode(body["message"].as_str().unwrap()).unwrap();
        let finish = start.state.finish(&mut OsRng, password, CredentialResponse::deserialize(&response).unwrap(),
            ClientLoginFinishParameters::new(None, Default::default(), Some(&hardening())));
        let payload = finish.ok().map(|finish| json!({
            "challenge": body["challenge"], "message": STANDARD.encode(finish.message.serialize()),
        }));
        (status, payload)
    }

    pub async fn login(&self, email: &str) -> String {
        let (_, payload) = self.login_exchange(email, b"right").await;
        assert!(payload.is_some());
        let (status, _, cookie) = self.call("POST", "/api/login/finish", None, payload).await;
        assert_eq!(status, StatusCode::OK);
        cookie.unwrap()
    }
}
