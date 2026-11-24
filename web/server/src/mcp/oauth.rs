//! Signing a chat host in for an account (OAuth 2.1, as MCP asks of a remote server): the host registers itself
//! (dynamic client registration), sends the person to the workshop to allow it (`/workshop/connect`, signed in with
//! the account's cookie), and trades the code it gets for tokens, with PKCE. Thia is the authorization server and the
//! resource both; the tokens only ever reach `/mcp`, and only for drafts.
//!
//! - `GET /.well-known/oauth-protected-resource[/mcp]`, `GET /.well-known/oauth-authorization-server`: metadata
//! - `POST /oauth/register` (JSON) → the client's id (and secret, when it asks for one)
//! - `GET /oauth/authorize?…` → to `/workshop/connect?…`, where the person allows or not
//! - `POST /oauth/token` (form): `authorization_code` with `code_verifier`, or `refresh_token` (rotated)
//! - signed in, under `/api/oauth/`: `GET client`, `POST approve`, `POST deny`, `GET connections`,
//!   `DELETE connections/{client}`

use std::collections::HashMap;
use std::time::{Duration, Instant};

use axum::extract::{FromRequestParts, Path, Query, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{delete, get, post};
use axum::{Form, Json, Router};
use base64::Engine as _;
use rusqlite::{OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::auth::{SignedIn, token_hash};
use crate::db::Account;
use crate::{ApiError, ApiResult, AppState, now_iso, now_ms, random_hex, random_token};

const CODE_LIFE: Duration = Duration::from_secs(10 * 60);
const ACCESS_LIFE: Duration = Duration::from_secs(3600);
const REFRESH_LIFE: Duration = Duration::from_secs(30 * 86_400);
/// registrations from anyone, at most this many an hour: they're unauthenticated
const REGISTRATIONS_PER_HOUR: u32 = 200;
pub const SCOPE: &str = "drafts";

/// The origin this server is reached at, as the proxy in front says (`X-Forwarded-Host`, `X-Forwarded-Proto`), or the
/// request's host: what the metadata names, so the same build answers on any domain.
pub fn origin(headers: &HeaderMap) -> String {
    let h = |k: &str| headers.get(k).and_then(|v| v.to_str().ok()).map(|v| v.split(',').next().unwrap_or(v).trim().to_owned());
    let host = h("x-forwarded-host").or_else(|| h(header::HOST.as_str())).unwrap_or_else(|| "localhost".into());
    let local = host.starts_with("localhost") || host.starts_with("127.0.0.1") || host.starts_with("[::1]");
    let proto = h("x-forwarded-proto").unwrap_or_else(|| if local { "http".into() } else { "https".into() });
    format!("{proto}://{host}")
}

/// The MCP endpoint's address: the resource the tokens are for.
pub fn resource(headers: &HeaderMap) -> String {
    format!("{}/mcp", origin(headers))
}

fn later(d: Duration) -> String {
    gestalts_core::iso_datetime(now_ms() + d.as_millis() as i64)
}

/// `s` as a query value.
fn enc(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { out.push(b as char) } else { out.push_str(&format!("%{b:02X}")) }
    }
    out
}

/// `uri` with `params` added to its query.
fn with_query(uri: &str, params: &[(&str, &str)]) -> String {
    let q: Vec<String> = params.iter().map(|(k, v)| format!("{k}={}", enc(v))).collect();
    format!("{uri}{}{}", if uri.contains('?') { '&' } else { '?' }, q.join("&"))
}

/// Where a host may have codes sent: https anywhere, or http on this computer (a local client), and no fragment.
fn valid_redirect(uri: &str) -> bool {
    if uri.len() > 2000 || uri.contains('#') || uri.chars().any(char::is_whitespace) { return false; }
    if let Some(rest) = uri.strip_prefix("https://") { return rest.split(['/', '?']).next().is_some_and(|h| !h.is_empty()); }
    ["http://localhost", "http://127.0.0.1", "http://[::1]"].iter().any(|p| uri.strip_prefix(p).is_some_and(|r| r.is_empty() || r.starts_with([':', '/', '?'])))
}

fn sha256_hex(s: &str) -> String {
    token_hash(s)
}

/// The metadata of `/mcp` as a protected resource (RFC 9728): which server signs in for it.
async fn protected_resource(headers: HeaderMap) -> Json<Value> {
    Json(json!({
        "resource": resource(&headers),
        "authorization_servers": [origin(&headers)],
        "bearer_methods_supported": ["header"],
        "scopes_supported": [SCOPE],
        "resource_name": "thia",
    }))
}

/// The authorization server's metadata (RFC 8414).
async fn authorization_server(headers: HeaderMap) -> Json<Value> {
    let o = origin(&headers);
    Json(json!({
        "issuer": o,
        "authorization_endpoint": format!("{o}/oauth/authorize"),
        "token_endpoint": format!("{o}/oauth/token"),
        "registration_endpoint": format!("{o}/oauth/register"),
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none", "client_secret_post", "client_secret_basic"],
        "scopes_supported": [SCOPE],
    }))
}

/// An OAuth error, as its endpoints answer one.
fn oauth_error(status: StatusCode, error: &str, description: &str) -> Response {
    (status, [(header::CACHE_CONTROL, "no-store")], Json(json!({ "error": error, "error_description": description }))).into_response()
}

#[derive(Deserialize)]
struct Registration {
    #[serde(default)]
    redirect_uris: Vec<String>,
    #[serde(default)]
    client_name: Option<String>,
    #[serde(default)]
    token_endpoint_auth_method: Option<String>,
}

/// Recent registrations, to keep anyone from filling the table.
#[derive(Default)]
pub struct Registrations(std::sync::Mutex<Option<(Instant, u32)>>);

impl Registrations {
    fn allow(&self) -> bool {
        let mut g = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let (since, n) = g.get_or_insert((Instant::now(), 0));
        if since.elapsed() > Duration::from_secs(3600) { *since = Instant::now(); *n = 0; }
        *n += 1;
        *n <= REGISTRATIONS_PER_HOUR
    }
}

async fn register(State(state): State<AppState>, Json(r): Json<Registration>) -> Response {
    if !state.mcp.registrations.allow() {
        return oauth_error(StatusCode::TOO_MANY_REQUESTS, "temporarily_unavailable", "too many registrations: try again later");
    }
    if r.redirect_uris.is_empty() || r.redirect_uris.len() > 10 || !r.redirect_uris.iter().all(|u| valid_redirect(u)) {
        return oauth_error(StatusCode::BAD_REQUEST, "invalid_redirect_uri", "one to ten redirect URIs: https, or http on localhost");
    }
    let method = r.token_endpoint_auth_method.unwrap_or_else(|| "client_secret_basic".into());
    if !["none", "client_secret_post", "client_secret_basic"].contains(&method.as_str()) {
        return oauth_error(StatusCode::BAD_REQUEST, "invalid_client_metadata", "token_endpoint_auth_method: none, client_secret_post or client_secret_basic");
    }
    let name: String = r.client_name.as_deref().map(str::trim).filter(|n| !n.is_empty()).unwrap_or("A chat app").chars().take(100).collect();
    let id = random_hex(16);
    let secret = (method != "none").then(|| random_token(32));
    let now = now_iso();
    let saved = state.db.with(|c| {
        // clients that never got a token go after a day
        c.execute("DELETE FROM oauth_clients WHERE created < ?1 AND id NOT IN (SELECT client FROM oauth_tokens) AND id NOT IN (SELECT client FROM oauth_codes)",
            [gestalts_core::iso_datetime(now_ms() - 86_400_000)])?;
        c.execute("INSERT INTO oauth_clients (id, secret_hash, name, redirect_uris, created) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, secret.as_deref().map(sha256_hex), name, serde_json::to_string(&r.redirect_uris).unwrap_or_default(), now])
    });
    if let Err(e) = saved {
        return ApiError::from(e).into_response();
    }
    let mut out = json!({
        "client_id": id, "client_id_issued_at": now_ms() / 1000, "client_name": name, "redirect_uris": r.redirect_uris,
        "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"], "token_endpoint_auth_method": method, "scope": SCOPE,
    });
    if let Some(s) = secret {
        out["client_secret"] = json!(s);
        out["client_secret_expires_at"] = json!(0);
    }
    (StatusCode::CREATED, [(header::CACHE_CONTROL, "no-store")], Json(out)).into_response()
}

struct Client {
    name: String,
    secret_hash: Option<String>,
    redirect_uris: Vec<String>,
}

fn client(state: &AppState, id: &str) -> ApiResult<Option<Client>> {
    Ok(state.db.with(|c| {
        c.query_row("SELECT name, secret_hash, redirect_uris FROM oauth_clients WHERE id = ?1", [id], |r| {
            Ok(Client { name: r.get(0)?, secret_hash: r.get(1)?, redirect_uris: serde_json::from_str(&r.get::<_, String>(2)?).unwrap_or_default() })
        }).optional()
    })?)
}

/// What an authorization request carries; the same fields go to the consent page and back.
#[derive(Deserialize, Default)]
#[serde(default)]
pub struct AuthRequest {
    response_type: String,
    client_id: String,
    redirect_uri: String,
    code_challenge: String,
    code_challenge_method: String,
    state: Option<String>,
    scope: Option<String>,
    resource: Option<String>,
}

/// The client and redirect a request names, if they go together: where an error may be sent.
fn checked_client(state: &AppState, req: &AuthRequest) -> Result<Client, String> {
    let c = client(state, &req.client_id).map_err(|_| "the server couldn't look the app up".to_owned())?.ok_or("this app isn't registered here: connect it again")?;
    if !c.redirect_uris.contains(&req.redirect_uri) {
        return Err("the app asked to send the answer somewhere it didn't register".into());
    }
    Ok(c)
}

/// What's wrong with an authorization request that names a valid client and redirect, as an OAuth error code.
fn request_problem(req: &AuthRequest) -> Option<&'static str> {
    if req.response_type != "code" { return Some("unsupported_response_type"); }
    if req.code_challenge_method != "S256" || req.code_challenge.len() < 43 || req.code_challenge.len() > 128 { return Some("invalid_request"); }
    if req.scope.as_deref().is_some_and(|s| !s.split(' ').all(|x| x.is_empty() || x == SCOPE)) { return Some("invalid_scope"); }
    None
}

fn error_redirect(req: &AuthRequest, error: &str) -> String {
    let mut p = vec![("error", error)];
    if let Some(s) = &req.state { p.push(("state", s)); }
    with_query(&req.redirect_uri, &p)
}

/// The person's browser arrives here from the host: to the workshop's page that asks them, or back with an error.
async fn authorize(State(state): State<AppState>, headers: HeaderMap, Query(req): Query<AuthRequest>, axum::extract::RawQuery(raw): axum::extract::RawQuery) -> Response {
    if let Err(e) = checked_client(&state, &req) {
        return (StatusCode::BAD_REQUEST, [(header::CONTENT_TYPE, "text/plain; charset=utf-8")], format!("Can't connect: {e}.")).into_response();
    }
    if let Some(r) = &req.resource && *r != resource(&headers) {
        return Redirect::to(&error_redirect(&req, "invalid_target")).into_response();
    }
    if let Some(problem) = request_problem(&req) {
        return Redirect::to(&error_redirect(&req, problem)).into_response();
    }
    Redirect::to(&format!("/workshop/connect?{}", raw.unwrap_or_default())).into_response()
}

#[derive(Deserialize)]
struct ClientQuery {
    client_id: String,
    redirect_uri: String,
}

/// For the consent page: the app's name, if the request is one to ask about.
async fn client_info(State(state): State<AppState>, _me: SignedIn, Query(q): Query<ClientQuery>) -> ApiResult<Json<Value>> {
    let req = AuthRequest { client_id: q.client_id, redirect_uri: q.redirect_uri, ..AuthRequest::default() };
    let c = checked_client(&state, &req).map_err(ApiError::BadRequest)?;
    Ok(Json(json!({ "name": c.name, "redirect": req.redirect_uri })))
}

/// The person allowed the app: a code for it, sent back where it registered.
async fn approve(State(state): State<AppState>, me: SignedIn, Json(req): Json<AuthRequest>) -> ApiResult<Json<Value>> {
    checked_client(&state, &req).map_err(ApiError::BadRequest)?;
    if let Some(problem) = request_problem(&req) {
        return Ok(Json(json!({ "redirect": error_redirect(&req, problem) })));
    }
    let code = random_token(32);
    state.db.with(|c| c.execute(
        "INSERT INTO oauth_codes (code_hash, client, account, redirect_uri, challenge, expires) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![sha256_hex(&code), req.client_id, me.0.id, req.redirect_uri, req.code_challenge, later(CODE_LIFE)],
    ))?;
    let mut p = vec![("code", code.as_str())];
    if let Some(s) = &req.state { p.push(("state", s)); }
    Ok(Json(json!({ "redirect": with_query(&req.redirect_uri, &p) })))
}

/// The person didn't allow it: back to the app with that.
async fn deny(State(state): State<AppState>, _me: SignedIn, Json(req): Json<AuthRequest>) -> ApiResult<Json<Value>> {
    checked_client(&state, &req).map_err(ApiError::BadRequest)?;
    Ok(Json(json!({ "redirect": error_redirect(&req, "access_denied") })))
}

/// A new pair of tokens for the account and client; `since` is when the account first allowed it.
fn issue(state: &AppState, client: &str, account: &str, since: &str) -> ApiResult<Response> {
    let (access, refresh) = (random_token(32), random_token(32));
    state.db.with(|c| {
        // expired tokens go as new ones come
        c.execute("DELETE FROM oauth_tokens WHERE expires < ?1", [now_iso()])?;
        c.execute("DELETE FROM oauth_codes WHERE expires < ?1", [now_iso()])?;
        c.execute("INSERT INTO oauth_tokens (token_hash, kind, client, account, since, expires) VALUES (?1, 'access', ?2, ?3, ?4, ?5)",
            params![sha256_hex(&access), client, account, since, later(ACCESS_LIFE)])?;
        c.execute("INSERT INTO oauth_tokens (token_hash, kind, client, account, since, expires) VALUES (?1, 'refresh', ?2, ?3, ?4, ?5)",
            params![sha256_hex(&refresh), client, account, since, later(REFRESH_LIFE)])
    })?;
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(json!({
        "access_token": access, "token_type": "Bearer", "expires_in": ACCESS_LIFE.as_secs(), "refresh_token": refresh, "scope": SCOPE,
    }))).into_response())
}

/// The client a token request is from, if it proves it: a public client by its id alone (PKCE proves the rest), a
/// confidential one by its secret, in the form or as basic auth.
fn authenticated_client(state: &AppState, headers: &HeaderMap, form: &HashMap<String, String>) -> Result<String, Box<Response>> {
    let invalid = || Box::new(oauth_error(StatusCode::UNAUTHORIZED, "invalid_client", "the app isn't known here, or its secret is wrong"));
    let basic = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Basic "))
        .and_then(|b| base64::engine::general_purpose::STANDARD.decode(b.trim()).ok()).and_then(|b| String::from_utf8(b).ok())
        .and_then(|s| s.split_once(':').map(|(a, b)| (a.to_owned(), b.to_owned())));
    let (id, secret) = match basic {
        Some((id, secret)) => (id, Some(secret)),
        None => (form.get("client_id").cloned().unwrap_or_default(), form.get("client_secret").cloned()),
    };
    let c = client(state, &id).ok().flatten().ok_or_else(invalid)?;
    match (&c.secret_hash, secret) {
        (None, _) => Ok(id),
        (Some(h), Some(s)) if *h == sha256_hex(&s) => Ok(id),
        _ => Err(invalid()),
    }
}

async fn token(State(state): State<AppState>, headers: HeaderMap, Form(form): Form<HashMap<String, String>>) -> Response {
    let client = match authenticated_client(&state, &headers, &form) {
        Ok(c) => c,
        Err(r) => return *r,
    };
    let f = |k: &str| form.get(k).map(String::as_str).unwrap_or_default();
    let bad_grant = |d: &str| oauth_error(StatusCode::BAD_REQUEST, "invalid_grant", d);
    if let Some(r) = form.get("resource") && *r != resource(&headers) {
        return oauth_error(StatusCode::BAD_REQUEST, "invalid_target", "tokens here are for this server's /mcp only");
    }
    let found = match f("grant_type") {
        "authorization_code" => {
            let row = state.db.with(|c| {
                let row = c.query_row("SELECT client, account, redirect_uri, challenge, expires FROM oauth_codes WHERE code_hash = ?1", [sha256_hex(f("code"))],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, String>(4)?))).optional()?;
                // a code is used once, whatever comes of it
                c.execute("DELETE FROM oauth_codes WHERE code_hash = ?1", [sha256_hex(f("code"))])?;
                Ok(row)
            });
            let Ok(Some((c, account, redirect, challenge, expires))) = row else { return bad_grant("the code isn't valid: it's unknown or used") };
            if c != client || redirect != f("redirect_uri") || expires < now_iso() {
                return bad_grant("the code is for another app or address, or it expired");
            }
            let verified = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(f("code_verifier").as_bytes()));
            if f("code_verifier").len() < 43 || verified != challenge {
                return bad_grant("code_verifier doesn't match the challenge");
            }
            (account, now_iso())
        }
        "refresh_token" => {
            let row = state.db.with(|c| {
                let h = sha256_hex(f("refresh_token"));
                let row = c.query_row("SELECT client, account, since, expires FROM oauth_tokens WHERE token_hash = ?1 AND kind = 'refresh'", [&h],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?))).optional()?;
                // rotated: the old one goes as the new one comes
                c.execute("DELETE FROM oauth_tokens WHERE token_hash = ?1", [&h])?;
                Ok(row)
            });
            let Ok(Some((c, account, since, expires))) = row else { return bad_grant("the refresh token isn't valid: connect the app again") };
            if c != client || expires < now_iso() {
                return bad_grant("the refresh token is for another app, or it expired");
            }
            (account, since)
        }
        _ => return oauth_error(StatusCode::BAD_REQUEST, "unsupported_grant_type", "authorization_code or refresh_token"),
    };
    // a disabled account gets nothing
    let alive = state.db.with(|c| c.query_row("SELECT 1 FROM accounts WHERE id = ?1 AND disabled IS NULL", [&found.0], |_| Ok(())).optional());
    if !matches!(alive, Ok(Some(()))) {
        return bad_grant("the account can't sign in");
    }
    issue(&state, &client, &found.0, &found.1).unwrap_or_else(IntoResponse::into_response)
}

/// The account a bearer token acts for, on `/mcp`; else 401 saying where to sign in.
pub struct Bearer(pub Account);

impl FromRequestParts<AppState> for Bearer {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Response> {
        let token = parts.headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).map(str::trim);
        let found = match token {
            Some(t) => state.db.with(|c| c.query_row(
                "SELECT a.id, a.school, a.email, a.token_budget, a.admin, a.maintainer FROM oauth_tokens t JOIN accounts a ON a.id = t.account
                 WHERE t.token_hash = ?1 AND t.kind = 'access' AND t.expires > ?2 AND a.disabled IS NULL",
                params![sha256_hex(t), now_iso()],
                |r| Ok(Account { id: r.get(0)?, school: r.get(1)?, email: r.get(2)?, token_budget: r.get(3)?, admin: r.get(4)?, maintainer: r.get(5)? }),
            ).optional()).ok().flatten(),
            None => None,
        };
        found.map(Bearer).ok_or_else(|| {
            let metadata = format!("{}/.well-known/oauth-protected-resource", origin(&parts.headers));
            let error = if token.is_some() { ", error=\"invalid_token\"" } else { "" };
            let challenge = format!("Bearer resource_metadata=\"{metadata}\", scope=\"{SCOPE}\"{error}");
            let mut res = (StatusCode::UNAUTHORIZED, Json(json!({ "error": "not signed in" }))).into_response();
            if let Ok(v) = HeaderValue::from_str(&challenge) { res.headers_mut().insert(header::WWW_AUTHENTICATE, v); }
            res
        })
    }
}

/// The apps the account allowed, for Settings: each with when.
async fn connections(State(state): State<AppState>, me: SignedIn) -> ApiResult<Json<Value>> {
    let rows = state.db.with(|c| {
        let mut st = c.prepare("SELECT t.client, c.name, MIN(t.since) FROM oauth_tokens t JOIN oauth_clients c ON c.id = t.client
            WHERE t.account = ?1 AND t.kind = 'refresh' AND t.expires > ?2 GROUP BY t.client ORDER BY 3")?;
        st.query_map(params![me.0.id, now_iso()], |r| Ok(json!({ "client": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?, "since": r.get::<_, String>(2)? })))?.collect::<Result<Vec<_>, _>>()
    })?;
    Ok(Json(json!(rows)))
}

/// Disconnects an app: its tokens for this account go, at once.
async fn disconnect(State(state): State<AppState>, me: SignedIn, Path(client): Path<String>) -> ApiResult<StatusCode> {
    state.db.with(|c| c.execute("DELETE FROM oauth_tokens WHERE account = ?1 AND client = ?2", params![me.0.id, client]))?;
    Ok(StatusCode::NO_CONTENT)
}

/// What a host reaches without a session: the metadata and the OAuth endpoints, at the root.
pub fn public_routes() -> Router<AppState> {
    Router::new()
        .route("/.well-known/oauth-protected-resource", get(protected_resource))
        .route("/.well-known/oauth-protected-resource/mcp", get(protected_resource))
        .route("/.well-known/oauth-authorization-server", get(authorization_server))
        .route("/oauth/register", post(register))
        .route("/oauth/authorize", get(authorize))
        .route("/oauth/token", post(token))
}

/// What the workshop asks, signed in, under `/api`.
pub fn api_routes() -> Router<AppState> {
    Router::new()
        .route("/oauth/client", get(client_info))
        .route("/oauth/approve", post(approve))
        .route("/oauth/deny", post(deny))
        .route("/oauth/connections", get(connections))
        .route("/oauth/connections/{client}", delete(disconnect))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn where_codes_may_go() {
        for ok in ["https://claude.ai/api/mcp/auth_callback", "http://localhost:6274/oauth/callback", "http://127.0.0.1/cb", "http://localhost"] {
            assert!(valid_redirect(ok), "{ok}");
        }
        for bad in ["http://claude.ai/cb", "https://", "https://x/cb#frag", "http://localhost.evil.example/cb", "javascript:alert(1)", "https://x/a b"] {
            assert!(!valid_redirect(bad), "{bad}");
        }
    }

    #[test]
    fn query_values_are_encoded() {
        assert_eq!(with_query("https://x/cb", &[("code", "a+b/c"), ("state", "s t")]), "https://x/cb?code=a%2Bb%2Fc&state=s%20t");
        assert_eq!(with_query("https://x/cb?k=1", &[("error", "access_denied")]), "https://x/cb?k=1&error=access_denied");
    }
}
