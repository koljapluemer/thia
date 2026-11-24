use std::time::{Duration, Instant};

use axum::extract::{FromRequestParts, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::{Engine, engine::general_purpose::STANDARD};
use gestalts_account::*;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::Path, sync::Mutex};

use crate::db::Account;
use crate::{ApiError, ApiResult, AppState, now_iso, now_ms, random_token};

pub const COOKIE: &str = "thia_server";
const SESSION_DAYS: i64 = 30;
const LOCKOUT: Duration = Duration::from_secs(15 * 60);

pub(crate) fn token_hash(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn session_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .find_map(|c| c.trim().strip_prefix(COOKIE)?.strip_prefix('='))
}

/// The signed-in account, or 401.
pub struct SignedIn(pub Account);

impl FromRequestParts<AppState> for SignedIn {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        let token = session_token(&parts.headers).ok_or(ApiError::Unauthorized)?;
        state
            .db
            .session(&token_hash(token), &now_iso())?
            .map(SignedIn)
            .ok_or(ApiError::Unauthorized)
    }
}

fn cookie(state: &AppState, value: &str, max_age: Option<i64>) -> HeaderValue {
    let secure = if state.secure_cookies { "; Secure" } else { "" };
    let expiry = max_age.map_or_else(String::new, |seconds| format!("; Max-Age={seconds}"));
    HeaderValue::from_str(&format!(
        "{COOKIE}={value}; Path=/; HttpOnly; SameSite=Lax{expiry}{secure}"
    ))
    .expect("a cookie of base64url is a header value")
}

#[derive(Serialize)]
pub struct Me {
    pub id: String,
    pub email: String,
    pub school: Option<String>,
    pub maintainer: bool,
    pub generation: u32,
}

pub(crate) fn same_origin(headers: &HeaderMap) -> Result<(), ApiError> {
    if matches!(
        headers
            .get("sec-fetch-site")
            .and_then(|value| value.to_str().ok()),
        Some("cross-site" | "same-site")
    ) {
        return Err(ApiError::Forbidden);
    }
    Ok(())
}

fn limit_ip(state: &AppState, headers: &HeaderMap, action: &str, limit: u32) -> ApiResult<()> {
    // Caddy overwrites this header. Direct development requests share a bucket.
    let ip = headers
        .get("x-thia-client-ip")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<std::net::IpAddr>().ok());
    let key = format!(
        "{action}:{}",
        ip.map(|ip| ip.to_string()).unwrap_or_default()
    );
    limit_attempts(state, &key, limit)
}

fn limit_attempts(state: &AppState, key: &str, maximum: u32) -> ApiResult<()> {
    let mut attempts = state
        .failures
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    attempts.retain(|_, (_, since)| since.elapsed() < LOCKOUT);
    let entry = attempts
        .entry(key.to_owned())
        .or_insert((0, Instant::now()));
    if entry.0 >= maximum {
        return Err(ApiError::TooMany(
            "Too many attempts. Try again in 15 minutes.".into(),
        ));
    }
    entry.0 += 1;
    Ok(())
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    same_origin(&headers)?;
    if let Some(t) = session_token(&headers) {
        state.db.drop_session(&token_hash(t))?;
    }
    let mut res = axum::http::StatusCode::NO_CONTENT.into_response();
    res.headers_mut()
        .insert(header::SET_COOKIE, cookie(&state, "", Some(0)));
    Ok(res)
}

async fn me(State(state): State<AppState>, SignedIn(a): SignedIn) -> ApiResult<Json<Me>> {
    let current = generation(&state, &a.id)?;
    Ok(Json(me_for(a, current)))
}

pub struct OpaqueAuth {
    setup: ServerSetup<Profile>,
    pending: Mutex<HashMap<String, (Instant, Exchange)>>,
}

enum Exchange {
    Signup {
        id: String,
        email: String,
    },
    Login {
        id: Option<String>,
        generation: u32,
        login: ServerLogin<Profile>,
    },
    Change {
        id: String,
        generation: u32,
        session: String,
        login: ServerLogin<Profile>,
    },
}

impl OpaqueAuth {
    pub fn open(db: &crate::db::Db, data: &Path) -> Result<Self, String> {
        let path = data.join("opaque-setup-v1");
        let setup = match std::fs::read(&path) {
            Ok(bytes) => {
                ServerSetup::deserialize(&bytes).map_err(|_| "Invalid OPAQUE setup".to_owned())?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let enrolled = db
                    .with(|db| {
                        db.query_row(
                            "SELECT EXISTS(SELECT 1 FROM accounts WHERE opaque_record IS NOT NULL)",
                            [],
                            |row| row.get::<_, bool>(0),
                        )
                    })
                    .map_err(|e| e.to_string())?;
                if enrolled {
                    return Err("Restore opaque-setup-v1 before starting this database.".into());
                }
                let setup = ServerSetup::new(&mut OsRng);
                let mut options = std::fs::OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                use std::io::Write;
                let mut file = options.open(&path).map_err(|e| e.to_string())?;
                file.write_all(&setup.serialize())
                    .and_then(|_| file.sync_all())
                    .map_err(|e| e.to_string())?;
                setup
            }
            Err(error) => return Err(format!("{}: {error}", path.display())),
        };
        Ok(Self {
            setup,
            pending: Mutex::default(),
        })
    }

    fn put(&self, exchange: Exchange) -> ApiResult<String> {
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        pending.retain(|_, (created, _)| created.elapsed() < Duration::from_secs(120));
        if pending.len() >= 1024 {
            return Err(ApiError::TooMany("Try again shortly.".into()));
        }
        let challenge = random_token(32);
        pending.insert(challenge.clone(), (Instant::now(), exchange));
        Ok(challenge)
    }

    fn take(&self, challenge: &str) -> ApiResult<Exchange> {
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(challenge)
            .filter(|(created, _)| created.elapsed() < Duration::from_secs(120))
            .map(|(_, exchange)| exchange)
            .ok_or(ApiError::Unauthorized)
    }
}

#[derive(Deserialize)]
struct Start {
    email: String,
    message: String,
    #[serde(default)]
    code: String,
}

#[derive(Deserialize)]
struct Finish {
    challenge: String,
    message: String,
    #[serde(default)]
    wrapped: String,
    #[serde(default)]
    remember: bool,
}

fn decode(message: &str) -> ApiResult<Vec<u8>> {
    STANDARD.decode(message).map_err(|_| ApiError::Unauthorized)
}

fn wrapped(value: &str) -> ApiResult<&str> {
    if decode(value)?.len() != 60 {
        return Err(ApiError::BadRequest("Invalid wrapped key.".into()));
    }
    Ok(value)
}

fn normalize(email: &str) -> ApiResult<String> {
    let email = email.trim().to_lowercase();
    if email.len() > 254
        || email.chars().any(char::is_whitespace)
        || !email.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty() && domain.contains('.') && !domain.contains('@')
        })
    {
        return Err(ApiError::BadRequest("Enter a valid email address.".into()));
    }
    Ok(email)
}

fn registration(state: &AppState, email: &str, message: &str) -> ApiResult<String> {
    let request =
        RegistrationRequest::deserialize(&decode(message)?).map_err(|_| ApiError::Unauthorized)?;
    let result = ServerRegistration::start(&state.auth.setup, request, email.as_bytes())
        .map_err(|_| ApiError::Unauthorized)?;
    Ok(STANDARD.encode(result.message.serialize()))
}

fn record(message: &str) -> ApiResult<Vec<u8>> {
    let upload = RegistrationUpload::<Profile>::deserialize(&decode(message)?)
        .map_err(|_| ApiError::Unauthorized)?;
    Ok(ServerRegistration::finish(upload).serialize().to_vec())
}

type Credentials = (String, Vec<u8>, u32, String);

fn credentials(state: &AppState, email: &str) -> ApiResult<Option<Credentials>> {
    Ok(state.db.with(|db| db.query_row(
        "SELECT id, opaque_record, credential_generation, wrapped_key FROM accounts WHERE email = ?1 AND disabled IS NULL AND opaque_record IS NOT NULL",
        [email], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).optional())?)
}

fn generation(state: &AppState, id: &str) -> ApiResult<u32> {
    Ok(state.db.with(|db| {
        db.query_row(
            "SELECT credential_generation FROM accounts WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
    })?)
}

fn me_for(account: Account, generation: u32) -> Me {
    Me {
        id: account.id,
        email: account.email,
        school: account.school,
        maintainer: account.maintainer,
        generation,
    }
}

async fn signup_start(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<Start>,
) -> ApiResult<Json<serde_json::Value>> {
    same_origin(&headers)?;
    limit_ip(&state, &headers, "signup", 20)?;
    let code = state.beta_code.as_ref().ok_or(ApiError::Forbidden)?;
    if token_hash(&req.code) != token_hash(code) {
        return Err(ApiError::Forbidden);
    }
    let email = normalize(&req.email)?;
    let message = registration(&state, &email, &req.message)?;
    let id = crate::random_hex(16);
    let challenge = state.auth.put(Exchange::Signup {
        id: id.clone(),
        email,
    })?;
    Ok(Json(
        serde_json::json!({ "challenge": challenge, "id": id, "message": message }),
    ))
}

async fn signup_finish(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<Finish>,
) -> ApiResult<axum::http::StatusCode> {
    same_origin(&headers)?;
    let Exchange::Signup { id, email } = state.auth.take(&req.challenge)? else {
        return Err(ApiError::Unauthorized);
    };
    let record = record(&req.message)?;
    let wrapped = wrapped(&req.wrapped)?;
    let changed = state.db.with(|db| db.execute(
        "INSERT INTO accounts (id, email, opaque_record, wrapped_key, token_budget, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(email) DO NOTHING",
        params![id,email,record,wrapped,state.limits.token_budget,now_iso()],
    ))?;
    if changed == 0 {
        return Err(ApiError::Conflict(
            "Unable to create this account. Try signing in.".into(),
        ));
    }
    Ok(axum::http::StatusCode::NO_CONTENT)
}

fn begin_login(
    state: &AppState,
    email: &str,
    message: &str,
    found: Option<&Credentials>,
) -> ApiResult<(ServerLogin<Profile>, String)> {
    let record = found
        .map(|(_, bytes, _, _)| ServerRegistration::deserialize(bytes))
        .transpose()
        .map_err(|_| ApiError::Internal("Invalid stored credential".into()))?;
    let request =
        CredentialRequest::deserialize(&decode(message)?).map_err(|_| ApiError::Unauthorized)?;
    let result = ServerLogin::start(
        &mut OsRng,
        &state.auth.setup,
        record,
        request,
        email.as_bytes(),
        ServerLoginParameters::default(),
    )
    .map_err(|_| ApiError::Unauthorized)?;
    Ok((result.state, STANDARD.encode(result.message.serialize())))
}

fn verify(login: ServerLogin<Profile>, message: &str) -> ApiResult<()> {
    let message = CredentialFinalization::deserialize(&decode(message)?)
        .map_err(|_| ApiError::Unauthorized)?;
    login
        .finish(message, ServerLoginParameters::default())
        .map_err(|_| ApiError::Unauthorized)?;
    Ok(())
}

async fn login_start(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<Start>,
) -> ApiResult<Json<serde_json::Value>> {
    same_origin(&headers)?;
    limit_ip(&state, &headers, "login", 60)?;
    let email = normalize(&req.email)?;
    limit_attempts(&state, &format!("account:{email}"), 5)?;
    let found = credentials(&state, &email)?;
    let (login, message) = begin_login(&state, &email, &req.message, found.as_ref())?;
    let (id, generation) = found.map_or((None, 0), |(id, _, generation, _)| (Some(id), generation));
    let challenge = state.auth.put(Exchange::Login {
        id,
        generation,
        login,
    })?;
    Ok(Json(
        serde_json::json!({ "challenge": challenge, "message": message }),
    ))
}

fn session_data() -> (String, String) {
    (
        random_token(32),
        gestalts_core::iso_datetime(now_ms() + SESSION_DAYS * 86_400_000),
    )
}

fn session_response(
    state: &AppState,
    token: &str,
    remember: bool,
    body: serde_json::Value,
) -> Response {
    let mut response = Json(body).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        cookie(state, token, remember.then_some(SESSION_DAYS * 86_400)),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn login_finish(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<Finish>,
) -> ApiResult<Response> {
    same_origin(&headers)?;
    let Exchange::Login {
        id,
        generation,
        login,
    } = state.auth.take(&req.challenge)?
    else {
        return Err(ApiError::Unauthorized);
    };
    verify(login, &req.message)?;
    let id = id.ok_or(ApiError::Unauthorized)?;
    let (token, expires) = session_data();
    let wrapped = state.db.with(|db| {
        let tx = db.unchecked_transaction()?;
        let wrapped: Option<String> = tx.query_row(
            "SELECT wrapped_key FROM accounts WHERE id=?1 AND credential_generation=?2 AND disabled IS NULL",
            params![id,generation], |row| row.get(0),
        ).optional()?;
        if wrapped.is_some() {
            tx.execute("INSERT INTO sessions (token_hash, account, expires) VALUES (?1,?2,?3)", params![token_hash(&token),id,expires])?;
        }
        tx.commit()?;
        Ok(wrapped)
    })?.ok_or(ApiError::Unauthorized)?;
    let account = state
        .db
        .session(&token_hash(&token), &now_iso())?
        .ok_or(ApiError::Unauthorized)?;
    state
        .failures
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(&format!("account:{}", account.email));
    Ok(session_response(
        &state,
        &token,
        req.remember,
        serde_json::json!({ "account": me_for(account, generation), "wrapped": wrapped }),
    ))
}

#[derive(Deserialize)]
struct ChangeStart {
    message: String,
    registration: String,
}

async fn change_start(
    State(state): State<AppState>,
    SignedIn(account): SignedIn,
    headers: HeaderMap,
    Json(req): Json<ChangeStart>,
) -> ApiResult<Json<serde_json::Value>> {
    same_origin(&headers)?;
    limit_ip(&state, &headers, "password-change", 20)?;
    let found = credentials(&state, &account.email)?.ok_or(ApiError::Unauthorized)?;
    let (login, message) = begin_login(&state, &account.email, &req.message, Some(&found))?;
    let registration = registration(&state, &account.email, &req.registration)?;
    let (_, _, generation, wrapped) = found;
    let challenge = state.auth.put(Exchange::Change {
        id: account.id,
        generation,
        session: token_hash(session_token(&headers).ok_or(ApiError::Unauthorized)?),
        login,
    })?;
    Ok(Json(
        serde_json::json!({ "challenge": challenge, "message": message, "registration": registration, "generation": generation, "wrapped": wrapped }),
    ))
}

#[derive(Deserialize)]
struct ChangeFinish {
    challenge: String,
    message: String,
    registration: String,
    wrapped: String,
    remember: bool,
}

async fn change_finish(
    State(state): State<AppState>,
    SignedIn(account): SignedIn,
    headers: HeaderMap,
    Json(req): Json<ChangeFinish>,
) -> ApiResult<Response> {
    same_origin(&headers)?;
    let Exchange::Change {
        id,
        generation,
        session,
        login,
    } = state.auth.take(&req.challenge)?
    else {
        return Err(ApiError::Unauthorized);
    };
    if id != account.id
        || session != token_hash(session_token(&headers).ok_or(ApiError::Unauthorized)?)
    {
        return Err(ApiError::Unauthorized);
    }
    verify(login, &req.message)?;
    let record = record(&req.registration)?;
    let wrapped = wrapped(&req.wrapped)?;
    let next = generation.checked_add(1).ok_or(ApiError::Unauthorized)?;
    let (token, expires) = session_data();
    let changed = state.db.with(|db| {
        let tx = db.unchecked_transaction()?;
        let changed = tx.execute(
            "UPDATE accounts SET opaque_record=?1, wrapped_key=?2, credential_generation=?3 WHERE id=?4 AND credential_generation=?5 AND disabled IS NULL AND EXISTS (SELECT 1 FROM sessions WHERE token_hash=?6 AND account=?4 AND expires>?7)",
            params![record,wrapped,next,id,generation,session,now_iso()],
        )?;
        if changed != 0 {
            tx.execute("DELETE FROM sessions WHERE account=?1", [&id])?;
            tx.execute("DELETE FROM oauth_tokens WHERE account=?1", [&id])?;
            tx.execute("DELETE FROM oauth_codes WHERE account=?1", [&id])?;
            tx.execute("INSERT INTO sessions (token_hash,account,expires) VALUES (?1,?2,?3)", params![token_hash(&token),id,expires])?;
        }
        tx.commit()?;
        Ok(changed)
    })?;
    if changed == 0 {
        return Err(ApiError::Unauthorized);
    }
    Ok(session_response(
        &state,
        &token,
        req.remember,
        serde_json::json!(me_for(account, next)),
    ))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/signup/start", post(signup_start))
        .route("/signup/finish", post(signup_finish))
        .route("/login/start", post(login_start))
        .route("/login/finish", post(login_finish))
        .route("/password/change/start", post(change_start))
        .route("/password/change/finish", post(change_finish))
        .route("/logout", post(logout))
        .route("/me", get(me))
        .layer(axum::extract::DefaultBodyLimit::max(4096))
}
