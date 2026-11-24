use axum::{Json, Router, extract::{DefaultBodyLimit, State}, http::HeaderMap, routing::get};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::{ApiError, ApiResult, AppState, auth::{SignedIn, same_origin}};

#[derive(Deserialize, Serialize)]
struct Snapshot {
    revision: u32,
    envelope: String,
}

fn check_account(headers: &HeaderMap, account: &str) -> ApiResult<()> {
    if headers.get("x-thia-account").and_then(|value| value.to_str().ok()) != Some(account) {
        return Err(ApiError::Forbidden);
    }
    Ok(())
}

async fn read(State(state): State<AppState>, SignedIn(account): SignedIn, headers: HeaderMap) -> ApiResult<Json<Option<Snapshot>>> {
    check_account(&headers, &account.id)?;
    let saved = state.db.with(|db| {
        db.query_row("SELECT revision, envelope FROM personal_sync WHERE account = ?1", [&account.id],
            |row| Ok(Snapshot { revision: row.get(0)?, envelope: row.get(1)? })).optional()
    })?;
    Ok(Json(saved))
}

async fn write(State(state): State<AppState>, SignedIn(account): SignedIn, headers: HeaderMap, Json(input): Json<Snapshot>) -> ApiResult<Json<u32>> {
    same_origin(&headers)?;
    check_account(&headers, &account.id)?;
    let revision = input.revision.checked_add(1).ok_or_else(|| ApiError::BadRequest("Invalid revision.".into()))?;
    let changed = state.db.with(|db| {
        if input.revision == 0 {
            db.execute("INSERT INTO personal_sync VALUES (?1, ?2, ?3) ON CONFLICT(account) DO NOTHING",
                params![account.id, revision, input.envelope])
        } else {
            db.execute("UPDATE personal_sync SET revision = ?2, envelope = ?3 WHERE account = ?1 AND revision = ?4",
                params![account.id, revision, input.envelope, input.revision])
        }
    })?;
    if changed == 0 {
        return Err(ApiError::Conflict("The backup changed on another device.".into()));
    }
    Ok(Json(revision))
}

pub fn routes() -> Router<AppState> {
    Router::new().route("/personal-sync", get(read).put(write))
        .layer(DefaultBodyLimit::max(16 * 1024 * 1024))
}
