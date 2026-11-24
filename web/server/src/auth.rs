use std::time::{Duration, Instant};

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};
use axum::extract::{FromRequestParts, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::db::Account;
use crate::{ApiError, ApiResult, AppState, now_iso, now_ms, random_token};

pub const COOKIE: &str = "thia_server";
const SESSION_DAYS: i64 = 30;
/// After this many failed sign-ins for one email, it waits.
const MAX_FAILURES: u32 = 5;
const LOCKOUT: Duration = Duration::from_secs(15 * 60);

pub fn hash_password(password: &str) -> String {
    let mut salt = [0u8; 16];
    getrandom::fill(&mut salt).expect("the OS has randomness");
    let salt = SaltString::encode_b64(&salt).expect("16 bytes make a salt");
    Argon2::new(Algorithm::Argon2id, Version::V0x13, Params::new(19 * 1024, 2, 1, None).expect("valid Argon2 parameters")).hash_password(password.as_bytes(), &salt).expect("argon2 hashes any password").to_string()
}

fn verify_password(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash).is_ok_and(|h| Argon2::default().verify_password(password.as_bytes(), &h).is_ok())
}

pub(crate) fn token_hash(token: &str) -> String {
    Sha256::digest(token.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
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
        state.db.session(&token_hash(token), &now_iso())?.map(SignedIn).ok_or(ApiError::Unauthorized)
    }
}

fn cookie(state: &AppState, value: &str, max_age: i64) -> HeaderValue {
    let secure = if state.secure_cookies { "; Secure" } else { "" };
    HeaderValue::from_str(&format!("{COOKIE}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure}")).expect("a cookie of base64url is a header value")
}

#[derive(Deserialize)]
struct Login {
    email: String,
    password: String,
}

#[derive(Serialize)]
pub struct Me {
    pub id: String,
    pub email: String,
    pub school: Option<String>,
    pub maintainer: bool,
}

#[derive(Deserialize)]
struct Signup {
    email: String,
    password: String,
    code: String,
}

pub(crate) fn same_origin(headers: &HeaderMap) -> Result<(), ApiError> {
    if matches!(headers.get("sec-fetch-site").and_then(|value| value.to_str().ok()), Some("cross-site" | "same-site")) {
        return Err(ApiError::Forbidden);
    }
    Ok(())
}

fn limit_ip(state: &AppState, headers: &HeaderMap, action: &str, limit: u32) -> ApiResult<()> {
    // Caddy overwrites this header. Direct development requests share a bucket.
    let ip = headers.get("x-thia-client-ip").and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<std::net::IpAddr>().ok());
    let key = format!("{action}:{}", ip.map(|ip| ip.to_string()).unwrap_or_default());
    let mut attempts = state.failures.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    attempts.retain(|_, (_, since)| since.elapsed() < LOCKOUT);
    let entry = attempts.entry(key).or_insert((0, Instant::now()));
    if entry.0 >= limit {
        return Err(ApiError::TooMany("Too many attempts. Try again in 15 minutes.".into()));
    }
    entry.0 += 1;
    Ok(())
}

async fn signup(State(state): State<AppState>, headers: HeaderMap, Json(req): Json<Signup>) -> ApiResult<Response> {
    same_origin(&headers)?;
    limit_ip(&state, &headers, "signup", 20)?;
    let code = state.beta_code.as_ref().ok_or(ApiError::Forbidden)?;
    if token_hash(&req.code) != token_hash(code) {
        return Err(ApiError::Forbidden);
    }
    let email = req.email.trim().to_lowercase();
    let valid_email = email.len() <= 254 && !email.chars().any(char::is_whitespace)
        && email.split_once('@').is_some_and(|(local, domain)| !local.is_empty() && domain.contains('.') && !domain.contains('@'));
    if !valid_email || !(15..=256).contains(&req.password.chars().count()) {
        return Err(ApiError::BadRequest("Enter a valid email and a password of 15 to 256 characters.".into()));
    }
    let permit = state.auth_hash_slots.try_acquire().map_err(|_| ApiError::TooMany("Try again shortly.".into()))?;
    let password = tokio::task::spawn_blocking(move || hash_password(&req.password)).await
        .map_err(|error| ApiError::Internal(error.to_string()))?;
    drop(permit);
    let id = crate::random_hex(16);
    let token = random_token(32);
    let expires = gestalts_core::iso_datetime(now_ms() + SESSION_DAYS * 86_400_000);
    let created = state.db.with(|connection| {
        let tx = connection.unchecked_transaction()?;
        let inserted = tx.execute(
            "INSERT INTO accounts (id, email, password, token_budget, created) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(email) DO NOTHING",
            rusqlite::params![id, email, password, state.limits.token_budget, now_iso()],
        )?;
        if inserted == 1 {
            tx.execute("INSERT INTO sessions (token_hash, account, expires) VALUES (?1, ?2, ?3)",
                rusqlite::params![token_hash(&token), id, expires])?;
        }
        tx.commit()?;
        Ok(inserted == 1)
    })?;
    if !created {
        return Err(ApiError::Conflict("Unable to create this account. Try signing in.".into()));
    }
    let mut response = Json(Me { id, email, school: None, maintainer: false }).into_response();
    response.headers_mut().insert(header::SET_COOKIE, cookie(&state, &token, SESSION_DAYS * 86_400));
    Ok(response)
}

async fn login(State(state): State<AppState>, headers: HeaderMap, Json(req): Json<Login>) -> ApiResult<Response> {
    same_origin(&headers)?;
    limit_ip(&state, &headers, "login", 60)?;
    if req.email.len() > 254 || req.password.len() > 1024 { return Err(ApiError::Unauthorized); }
    let email = req.email.trim().to_lowercase();
    {
        let mut failures = state.failures.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        failures.retain(|_, (_, since)| since.elapsed() < LOCKOUT);
        if failures.get(&email).is_some_and(|(n, _)| *n >= MAX_FAILURES) {
            return Err(ApiError::TooMany("too many failed sign-ins: try again in 15 minutes".into()));
        }
    }
    let found = state.db.account_by_email(&email)?;
    // a hash is checked either way, so an unknown email takes as long as a wrong password
    let hash = found.as_ref().and_then(|(_, h)| h.clone());
    let permit = state.auth_hash_slots.try_acquire().map_err(|_| ApiError::TooMany("Try again shortly.".into()))?;
    let ok = tokio::task::spawn_blocking(move || {
        match hash {
            Some(hash) => verify_password(&req.password, &hash),
            None => DUMMY.with(|hash| { verify_password(&req.password, hash); false }),
        }
    }).await.map_err(|error| ApiError::Internal(error.to_string()))?;
    drop(permit);
    let Some((account, _)) = found.filter(|_| ok) else {
        let mut failures = state.failures.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let entry = failures.entry(email).or_insert((0, Instant::now()));
        entry.0 += 1;
        return Err(ApiError::Unauthorized);
    };
    state.failures.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(&email);
    let token = random_token(32);
    let expires = gestalts_core::iso_datetime(now_ms() + SESSION_DAYS * 86_400_000);
    state.db.add_session(&token_hash(&token), &account.id, &expires)?;
    let mut res = Json(Me { id: account.id, email: account.email, school: account.school, maintainer: account.maintainer }).into_response();
    res.headers_mut().insert(header::SET_COOKIE, cookie(&state, &token, SESSION_DAYS * 86_400));
    Ok(res)
}

thread_local! {
    static DUMMY: String = hash_password("not anyone's password");
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    same_origin(&headers)?;
    if let Some(t) = session_token(&headers) {
        state.db.drop_session(&token_hash(t))?;
    }
    let mut res = axum::http::StatusCode::NO_CONTENT.into_response();
    res.headers_mut().insert(header::SET_COOKIE, cookie(&state, "", 0));
    Ok(res)
}

async fn me(SignedIn(a): SignedIn) -> Json<Me> {
    Json(Me { id: a.id, email: a.email, school: a.school, maintainer: a.maintainer })
}

pub fn routes() -> Router<AppState> {
    Router::new().route("/signup", post(signup)).route("/login", post(login)).route("/logout", post(logout)).route("/me", get(me))
}
