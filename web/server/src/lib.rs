//! The teacher app's server: a sync peer for teachers' drafts, an agent runner, and publishing.
//!
//! - **The app** (`app`): accounts behind a session cookie; each draft a folder of ymls, synced by the browser's wasm
//!   repo over the node's `/sync/*` shapes, with every write validated by the core against the draft's own package
//!   and the quotas. The browser is untrusted here.
//! - **The lesson domain** (`lessons`): another registrable domain, so nothing published shares cookies or storage
//!   with a teacher's session. It serves the player and lessons as static files, and one dynamic answer per lesson:
//!   which version is current.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use base64::Engine;
use gestalts_core::Gestalts;
use include_dir::{Dir, include_dir};
use serde::Serialize;

pub mod agent;
pub mod auth;
pub mod db;
pub mod drafts;
pub mod lessons;
pub mod npm;
pub mod promote;
pub mod publish;
pub mod submissions;
pub mod validate;
pub mod worker;

/// The repo's `gestalts/`, for the model packages a draft may use besides the core's.
static GESTALTS: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/../../gestalts");

/// The model packages teachers' views may read, and submissions are checked against: the teacher app's `models:`,
/// always the same, and all of them on the public site.
pub const MODELS: &[&str] = &["geography", "typing", "viz"];

/// Every model package in the repo (`gestalts/<package>/<name>/`): what a maintainer's drafts may use besides the
/// core's. What uses one outside [`MODELS`] can't go out as a lesson.
pub fn repo_models() -> Vec<&'static str> {
    let mut out: Vec<&str> = GESTALTS.dirs().filter(|d| d.dirs().next().is_some()).filter_map(|d| d.path().to_str()).collect();
    out.sort_unstable();
    out
}

/// The definitions of model packages, as YAML texts.
pub fn model_texts(packages: &[&str]) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for p in packages {
        let dir = GESTALTS.get_dir(p).ok_or_else(|| format!("no model package {p}"))?;
        for gestalt in dir.dirs() {
            for f in gestalt.files() {
                let name = f.path().file_name().and_then(|n| n.to_str()).unwrap_or_default();
                if name.starts_with('v') && name.ends_with(".yml") {
                    out.push(f.contents_utf8().ok_or_else(|| format!("{}: not text", f.path().display()))?.to_owned());
                }
            }
        }
    }
    Ok(out)
}

/// How much one teacher may store and use.
#[derive(Debug, Clone)]
pub struct Limits {
    pub drafts_per_account: i64,
    pub ymls_per_draft: usize,
    pub yml_bytes: usize,
    pub blob_bytes: usize,
    pub account_blob_bytes: u64,
    /// the agent's tokens per calendar month, for a new account
    pub token_budget: i64,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            drafts_per_account: 200,
            ymls_per_draft: 2_000,
            yml_bytes: 256 * 1024,
            blob_bytes: 20 * 1024 * 1024,
            account_blob_bytes: 500 * 1024 * 1024,
            token_budget: 5_000_000,
        }
    }
}

impl Limits {
    /// A maintainer's: they make what the public site ships, so more of it.
    pub fn maintainer(&self) -> Limits {
        Limits {
            drafts_per_account: self.drafts_per_account * 5,
            ymls_per_draft: self.ymls_per_draft * 5,
            account_blob_bytes: self.account_blob_bytes * 4,
            ..self.clone()
        }
    }
}

pub struct Inner {
    pub db: db::Db,
    /// `drafts/<id>/` (a folder as the node keeps one), `lessons/`, `npm/`, `runtime/`
    pub data: PathBuf,
    /// the core's definitions and the model packages' ([`MODELS`]): what a draft's own are judged beside, and what a
    /// lesson may use
    pub gestalts: Gestalts,
    /// the core's and every model package in the repo: a maintainer's drafts are judged beside these
    pub repo_gestalts: Gestalts,
    pub limits: Limits,
    /// cookies only over https; off for a local run on http
    pub secure_cookies: bool,
    /// failed sign-ins by email: how many, and since when
    pub failures: Mutex<HashMap<String, (u32, Instant)>>,
    /// writes to drafts, one at a time, so what's checked is what's there when they land
    pub writes: tokio::sync::Mutex<()>,
    pub worker: worker::Worker,
    pub agents: agent::Agents,
    /// where lesson links point: the lesson domain, as students reach it
    pub lesson_origin: String,
    pub misses: lessons::Misses,
    /// the repo checkout accepted submissions are written into; none on a box that only queues them
    pub promote_into: Option<PathBuf>,
}

/// What the server runs besides itself.
pub struct Services {
    pub worker: worker::WorkerConfig,
    pub model: agent::Model,
    pub lesson_origin: String,
    pub promote_into: Option<PathBuf>,
}

#[derive(Clone)]
pub struct AppState(pub Arc<Inner>);

impl std::ops::Deref for AppState {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        &self.0
    }
}

impl AppState {
    pub fn new(db: db::Db, data: PathBuf, limits: Limits, secure_cookies: bool, services: Services) -> Result<Self, String> {
        let models = model_texts(MODELS)?;
        let texts: Vec<&str> = models.iter().map(String::as_str).collect();
        let gestalts = Gestalts::builtin_with(&texts)?;
        let all = model_texts(&repo_models())?;
        let all: Vec<&str> = all.iter().map(String::as_str).collect();
        let repo_gestalts = Gestalts::builtin_with(&all)?;
        let agents = agent::Agents::new(services.model, agent::Reference::new(services.worker.template.clone()));
        let worker = worker::Worker::new(services.worker.clone());
        Ok(AppState(Arc::new(Inner {
            db,
            data,
            gestalts,
            repo_gestalts,
            limits,
            secure_cookies,
            failures: Mutex::default(),
            writes: tokio::sync::Mutex::default(),
            worker,
            agents,
            lesson_origin: services.lesson_origin,
            misses: lessons::Misses::default(),
            promote_into: services.promote_into,
        })))
    }
}

impl AppState {
    /// The gestalts an account's drafts are judged beside: every model package for a maintainer, [`MODELS`] for
    /// anyone else.
    pub fn gestalts_for(&self, account: &db::Account) -> &Gestalts {
        if account.maintainer { &self.repo_gestalts } else { &self.gestalts }
    }

    pub fn limits_for(&self, account: &db::Account) -> Limits {
        if account.maintainer { self.limits.maintainer() } else { self.limits.clone() }
    }
}

/// What a request gets instead of what it asked for. The body is `{error, problems?}`.
#[derive(Debug)]
pub enum ApiError {
    Unauthorized,
    /// signed in, but not allowed
    Forbidden,
    NotFound,
    BadRequest(String),
    /// written ymls that aren't valid, each with why
    Invalid(Vec<String>),
    TooLarge(String),
    TooMany(String),
    Conflict(String),
    Internal(String),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        #[derive(Serialize)]
        struct Body {
            error: String,
            #[serde(skip_serializing_if = "Vec::is_empty")]
            problems: Vec<String>,
        }
        let (status, error, problems) = match self {
            ApiError::Unauthorized => (StatusCode::UNAUTHORIZED, "not signed in".into(), vec![]),
            ApiError::Forbidden => (StatusCode::FORBIDDEN, "not allowed".into(), vec![]),
            ApiError::NotFound => (StatusCode::NOT_FOUND, "not found".into(), vec![]),
            ApiError::BadRequest(m) => (StatusCode::BAD_REQUEST, m, vec![]),
            ApiError::Invalid(p) => (StatusCode::UNPROCESSABLE_ENTITY, "not valid".into(), p),
            ApiError::TooLarge(m) => (StatusCode::PAYLOAD_TOO_LARGE, m, vec![]),
            ApiError::TooMany(m) => (StatusCode::TOO_MANY_REQUESTS, m, vec![]),
            ApiError::Conflict(m) => (StatusCode::CONFLICT, m, vec![]),
            ApiError::Internal(m) => {
                eprintln!("internal error: {m}");
                (StatusCode::INTERNAL_SERVER_ERROR, "something went wrong on the server".into(), vec![])
            }
        };
        (status, Json(Body { error, problems })).into_response()
    }
}

impl From<db::Error> for ApiError {
    fn from(e: db::Error) -> Self {
        ApiError::Internal(format!("database: {e}"))
    }
}

impl From<gestalts_core::StorageError> for ApiError {
    fn from(e: gestalts_core::StorageError) -> Self {
        match e {
            gestalts_core::StorageError::Rejected(m) => ApiError::BadRequest(m),
            other => ApiError::Internal(other.to_string()),
        }
    }
}

pub type ApiResult<T> = Result<T, ApiError>;

/// `n` random bytes as base64url.
pub fn random_token(n: usize) -> String {
    let mut bytes = vec![0u8; n];
    getrandom::fill(&mut bytes).expect("the OS has randomness");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// `n` random bytes as hex.
pub fn random_hex(n: usize) -> String {
    let mut bytes = vec![0u8; n];
    getrandom::fill(&mut bytes).expect("the OS has randomness");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

pub fn now_iso() -> String {
    gestalts_core::iso_datetime(now_ms())
}

/// The app's routes, under `/api`.
pub fn app(state: AppState) -> axum::Router {
    axum::Router::new().nest("/api", auth::routes().merge(drafts::routes()).merge(agent::routes()).merge(npm::routes()).merge(publish::routes()).merge(submissions::routes())).with_state(state)
}

/// The lesson domain's routes.
pub fn lessons(state: AppState) -> axum::Router {
    lessons::routes().with_state(state)
}
