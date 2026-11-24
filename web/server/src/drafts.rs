//! An account's drafts, of a view, a visualization or (later) a lesson of several views: each a folder of ymls and blobs (`drafts/<id>/`), which the browser's wasm repo syncs with over
//! the same routes a node serves (`health`, `sync/*`, `blobs/*`), under `/api/drafts/<id>/`. Every write is checked
//! ([`crate::validate`]) before it lands; a draft is only ever its owner's.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use gestalts_core::gestalt::DEFINITION_PREFIX;
use gestalts_core::{Hashes, Yml, YmlState};
use gestalts_fs::FsStorage;
use serde::{Deserialize, Serialize};

use crate::auth::SignedIn;
use crate::db::{Account, Draft};
use crate::validate::{Batch, Kind, check};
use crate::{ApiError, ApiResult, AppState, now_iso, random_hex};

/// What the node's sync speaks; the browser's sync checks it.
const API_VERSION: u32 = 3;
const MAX_SYNC_BODY: usize = 32 * 1024 * 1024;

pub fn valid_draft_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') && !id.starts_with('-')
}

impl AppState {
    pub fn draft_dir(&self, id: &str) -> PathBuf {
        self.data.join("drafts").join(id)
    }

    /// The signed-in account's draft and its folder, or 404 for anyone else's.
    pub fn own_draft(&self, me: &SignedIn, id: &str) -> ApiResult<(Draft, FsStorage)> {
        self.draft_of(&me.0, id)
    }

    /// The account's draft and its folder, or 404 for anyone else's.
    pub fn draft_of(&self, account: &Account, id: &str) -> ApiResult<(Draft, FsStorage)> {
        if !valid_draft_id(id) {
            return Err(ApiError::NotFound);
        }
        let d = self.db.draft(id, &account.id)?.ok_or(ApiError::NotFound)?;
        let s = FsStorage::new(self.draft_dir(id));
        Ok((d, s))
    }

    /// A new, empty draft of the account's: its id (its view's or viz's), and the package its own gestalts are named
    /// in. Its view or viz yml is written after, by whoever made it.
    pub fn create_draft(&self, account: &Account, title: &str, kind: Kind, moved: Option<(String, String)>) -> ApiResult<Draft> {
        let title = title.trim();
        if title.is_empty() || title.chars().count() > 200 || title.contains('\n') {
            return Err(ApiError::BadRequest("a title is one line, up to 200 characters".into()));
        }
        let limits = self.limits_for(account);
        if self.db.count_drafts(&account.id)? >= limits.drafts_per_account {
            return Err(ApiError::TooMany(format!("at most {} drafts: delete one first", limits.drafts_per_account)));
        }
        let (id, package) = match moved {
            Some((id, package)) if valid_draft_id(&id) && valid_package(&package) => (id, package),
            Some(_) => return Err(ApiError::BadRequest("moved: a draft's id and its package (d-<12 hex digits>)".into())),
            None => (format!("{}-{}", slug(title), random_hex(4)), format!("d-{}", random_hex(6))),
        };
        if self.db.draft_taken(&id, &package)? {
            return Err(ApiError::Conflict("a draft with this id or package is here already".into()));
        }
        let draft = Draft {
            id,
            owner: account.id.clone(),
            school: account.school.clone(),
            package,
            kind: kind.as_str().into(),
            title: title.into(),
            created: now_iso(),
        };
        std::fs::create_dir_all(self.draft_dir(&draft.id)).map_err(|e| ApiError::Internal(e.to_string()))?;
        self.db.add_draft(&draft)?;
        Ok(draft)
    }

    /// The draft's ymls as they are, by id, without tombstones.
    pub async fn draft_ymls(&self, s: FsStorage) -> ApiResult<BTreeMap<String, String>> {
        blocking(move || {
            let mut out = BTreeMap::new();
            for id in s.list_ymls_sync()? {
                if let Some(text) = s.read_yml_sync(&id)? && !gestalts_core::merge::is_tombstone_text(&text) {
                    out.insert(id, text);
                }
            }
            Ok(out)
        })
        .await
    }

    /// Writes ymls to the account's draft once all of them are fine, or none (`Invalid`, with each problem): the one
    /// way into a draft's folder, for the browser's sync and the server's own writes alike.
    pub async fn write_ymls(&self, account: &Account, d: &Draft, s: FsStorage, incoming: BTreeMap<String, String>) -> ApiResult<()> {
        let kind = kind_of(d)?;
        // one write at a time, so what's checked is what's there when it lands
        let _guard = self.writes.lock().await;
        let st = self.clone();
        let (account, d2) = (account.clone(), d.clone());
        let title = blocking(move || {
            let d = d2;
            let gestalts = st.gestalts_for(&account);
            let existing: BTreeSet<String> = s.list_ymls_sync()?.into_iter().collect();
            let mut definitions = BTreeMap::new();
            for e in existing.iter().filter(|e| e.starts_with(DEFINITION_PREFIX) && !incoming.contains_key(*e)) {
                if let Some(t) = s.read_yml_sync(e)? {
                    definitions.insert(e.clone(), t);
                }
            }
            let problems = check(gestalts, &st.limits_for(&account), &Batch { kind, draft: &d.id, package: &d.package, incoming: &incoming, existing: &existing, definitions: &definitions });
            if !problems.is_empty() {
                return Err(ApiError::Invalid(problems));
            }
            for (id, text) in &incoming {
                s.write_yml_sync(id, text)?;
            }
            // what the list shows
            let main = incoming.get(&d.id).map(|t| Yml::parse(d.id.clone(), t.clone()));
            Ok(main.filter(|y| matches!(gestalts.classify(y), YmlState::Valid(g) if kind.is_main(&g))).and_then(|y| y.str_field("title").map(str::to_owned)))
        })
        .await?;
        if let Some(t) = title {
            self.db.set_draft_title(&d.id, &t)?;
        }
        Ok(())
    }
}

/// Runs blocking file work off the async threads.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> ApiResult<T> + Send + 'static) -> ApiResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| ApiError::Internal(e.to_string()))?
}

pub fn slug(title: &str) -> String {
    let mut out = String::new();
    for c in title.to_lowercase().chars() {
        let c = match c { 'ä' => 'a', 'ö' => 'o', 'ü' => 'u', 'ß' => 's', c => c };
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let s: String = out.trim_matches('-').chars().take(40).collect();
    let s = s.trim_end_matches('-');
    if s.is_empty() { "view".into() } else { s.into() }
}

#[derive(Deserialize)]
struct NewDraft {
    title: String,
    /// `view`, `viz` or `sequence`
    #[serde(default = "view")]
    kind: String,
    /// a draft moved here from a browser, which keeps its id, and its package: its gestalts are named in it
    #[serde(default)]
    moved: Option<Moved>,
}

#[derive(Deserialize)]
struct Moved {
    id: String,
    package: String,
}

/// A package as drafts made in a browser name it: `d-` and 12 hex digits.
fn valid_package(p: &str) -> bool {
    p.strip_prefix("d-").is_some_and(|h| h.len() == 12 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

fn view() -> String {
    "view".into()
}

/// What a draft makes, as it was created.
pub fn kind_of(d: &Draft) -> ApiResult<Kind> {
    Kind::parse(&d.kind).ok_or_else(|| ApiError::Internal(format!("{}: a draft of kind {}", d.id, d.kind)))
}

async fn list(State(state): State<AppState>, me: SignedIn) -> ApiResult<Json<Vec<Draft>>> {
    Ok(Json(state.db.drafts(&me.0.id)?))
}

/// A new, empty draft: its id (its view's or viz's), and the package its own gestalts are named in. The browser
/// writes the view or viz yml through sync.
async fn create(State(state): State<AppState>, me: SignedIn, Json(req): Json<NewDraft>) -> ApiResult<(StatusCode, Json<Draft>)> {
    if req.kind != "view" {
        return Err(ApiError::BadRequest("only view drafts can be created".into()));
    }
    let kind = Kind::View;
    let draft = state.create_draft(&me.0, &req.title, kind, req.moved.map(|m| (m.id, m.package)))?;
    Ok((StatusCode::CREATED, Json(draft)))
}

/// Gone for its owner. Its folder goes; a lesson published from it stays until revoked.
async fn delete(State(state): State<AppState>, me: SignedIn, Path(id): Path<String>) -> ApiResult<StatusCode> {
    let (d, _) = state.own_draft(&me, &id)?;
    state.db.delete_draft(&d.id, &now_iso())?;
    let dir = state.draft_dir(&d.id);
    let _ = blocking(move || std::fs::remove_dir_all(dir).map_err(|e| ApiError::Internal(e.to_string()))).await;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
struct Folder {
    id: String,
    path: String,
}

#[derive(Serialize)]
struct Health {
    app: &'static str,
    version: &'static str,
    api: u32,
    folder: Folder,
}

async fn health(State(state): State<AppState>, me: SignedIn, Path(id): Path<String>) -> ApiResult<Json<Health>> {
    let (d, _) = state.own_draft(&me, &id)?;
    Ok(Json(Health { app: "thia-server", version: env!("CARGO_PKG_VERSION"), api: API_VERSION, folder: Folder { path: format!("draft “{}”", d.title), id: d.id } }))
}

async fn hashes(State(state): State<AppState>, me: SignedIn, Path(id): Path<String>) -> ApiResult<Json<Hashes>> {
    let (_, s) = state.own_draft(&me, &id)?;
    Ok(Json(blocking(move || Ok(s.yml_hashes_sync()?)).await?))
}

#[derive(Deserialize)]
struct Ids {
    ids: Vec<String>,
}

#[derive(Serialize, Deserialize)]
pub struct YmlEntry {
    pub id: String,
    pub text: String,
}

async fn read(State(state): State<AppState>, me: SignedIn, Path(id): Path<String>, Json(req): Json<Ids>) -> ApiResult<Json<Vec<YmlEntry>>> {
    let (_, s) = state.own_draft(&me, &id)?;
    Ok(Json(blocking(move || {
        let mut out = Vec::new();
        for id in req.ids {
            if let Some(text) = s.read_yml_sync(&id)? {
                out.push(YmlEntry { id, text });
            }
        }
        Ok(out)
    })
    .await?))
}

/// Writes ymls once all of them are fine, or none (422 with each problem).
async fn write(State(state): State<AppState>, me: SignedIn, Path(id): Path<String>, Json(ymls): Json<Vec<YmlEntry>>) -> ApiResult<StatusCode> {
    let (d, s) = state.own_draft(&me, &id)?;
    state.write_ymls(&me.0, &d, s, ymls.into_iter().map(|y| (y.id, y.text)).collect()).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_blobs(State(state): State<AppState>, me: SignedIn, Path(id): Path<String>) -> ApiResult<Json<Vec<String>>> {
    let (_, s) = state.own_draft(&me, &id)?;
    Ok(Json(blocking(move || Ok(s.list_blobs_sync()?)).await?))
}

async fn read_blob(State(state): State<AppState>, me: SignedIn, Path((id, name)): Path<(String, String)>) -> ApiResult<Response> {
    let (_, s) = state.own_draft(&me, &id)?;
    let bytes = blocking(move || Ok(s.read_blob_sync(&name)?)).await?;
    Ok(match bytes {
        Some(b) => ([(header::CONTENT_TYPE, "application/octet-stream")], b).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    })
}

/// The bytes of every blob in the account's drafts.
fn blob_usage(state: &AppState, owner: &str) -> ApiResult<u64> {
    let mut total = 0;
    for d in state.db.drafts(owner)? {
        let Ok(entries) = std::fs::read_dir(state.draft_dir(&d.id).join("blobs")) else { continue };
        total += entries.flatten().filter_map(|e| e.metadata().ok()).map(|m| m.len()).sum::<u64>();
    }
    Ok(total)
}

async fn write_blob(State(state): State<AppState>, me: SignedIn, Path((id, name)): Path<(String, String)>, body: Bytes) -> ApiResult<StatusCode> {
    let (_, s) = state.own_draft(&me, &id)?;
    let limits = state.limits_for(&me.0);
    if body.len() > limits.blob_bytes {
        return Err(ApiError::TooLarge(format!("a file may be up to {} MB", limits.blob_bytes / 1024 / 1024)));
    }
    let _guard = state.writes.lock().await;
    let st = state.clone();
    let owner = me.0.id.clone();
    blocking(move || {
        if blob_usage(&st, &owner)? + body.len() as u64 > limits.account_blob_bytes {
            return Err(ApiError::TooLarge(format!("your files take up more than {} MB: delete some first", limits.account_blob_bytes / 1024 / 1024)));
        }
        Ok(s.write_blob_sync(&name, &body)?)
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_blob(State(state): State<AppState>, me: SignedIn, Path((id, name)): Path<(String, String)>) -> ApiResult<StatusCode> {
    let (_, s) = state.own_draft(&me, &id)?;
    blocking(move || Ok(s.delete_blob_sync(&name)?)).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
struct Collected {
    deleted: Vec<String>,
}

/// Blobs no yml uses are kept here: an account's files count against its quota until they delete them.
async fn collect_blobs(State(state): State<AppState>, me: SignedIn, Path(id): Path<String>) -> ApiResult<Json<Collected>> {
    state.own_draft(&me, &id)?;
    Ok(Json(Collected { deleted: vec![] }))
}

/// Everything in a folder below `dir`, as paths relative to it; nothing hidden (a write's temporary files).
fn files_below(dir: &std::path::Path) -> std::io::Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    let mut todo = vec![PathBuf::new()];
    while let Some(rel) = todo.pop() {
        let Ok(entries) = std::fs::read_dir(dir.join(&rel)) else { continue };
        for e in entries {
            let e = e?;
            if e.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            let p = rel.join(e.file_name());
            if e.file_type()?.is_dir() { todo.push(p) } else { out.push(p) }
        }
    }
    out.sort();
    Ok(out)
}

/// The draft's folder as a zip, as the server keeps it (a folder a gestalts node opens): what folder sync was for.
async fn export(State(state): State<AppState>, me: SignedIn, Path(id): Path<String>) -> ApiResult<Response> {
    let (d, _) = state.own_draft(&me, &id)?;
    let dir = state.draft_dir(&d.id);
    let name = d.id.clone();
    let bytes = blocking(move || {
        let io = |e: std::io::Error| ApiError::Internal(e.to_string());
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for rel in files_below(&dir).map_err(io)? {
            let path = format!("{name}/{}", rel.to_string_lossy().replace('\\', "/"));
            zip.start_file(path, options).map_err(|e| ApiError::Internal(e.to_string()))?;
            std::io::Write::write_all(&mut zip, &std::fs::read(dir.join(&rel)).map_err(io)?).map_err(io)?;
        }
        Ok(zip.finish().map_err(|e| ApiError::Internal(e.to_string()))?.into_inner())
    })
    .await?;
    let disposition = format!("attachment; filename=\"{}.zip\"", d.id);
    Ok(([(header::CONTENT_TYPE, "application/zip".to_owned()), (header::CONTENT_DISPOSITION, disposition)], bytes).into_response())
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/drafts", get(list).post(create))
        .route("/drafts/{id}", axum::routing::delete(delete))
        .route("/drafts/{id}/health", get(health))
        .route("/drafts/{id}/export", get(export))
        .route("/drafts/{id}/sync/hashes", get(hashes))
        .route("/drafts/{id}/sync/read", post(read))
        .route("/drafts/{id}/sync/write", post(write).layer(DefaultBodyLimit::max(MAX_SYNC_BODY)))
        .route("/drafts/{id}/blobs", get(list_blobs))
        .route("/drafts/{id}/blobs/collect", post(collect_blobs))
        .route("/drafts/{id}/blobs/{name}", get(read_blob).put(write_blob).delete(delete_blob).layer(DefaultBodyLimit::max(64 * 1024 * 1024)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_from_titles() {
        assert_eq!(slug("Märchen & Co!"), "marchen-co");
        assert_eq!(slug("!!!"), "view");
        assert!(valid_draft_id("der-die-das-1a2b3c4d"));
        assert!(!valid_draft_id("../x") && !valid_draft_id("-x") && !valid_draft_id("A"));
        assert!(valid_package("d-0123456789ab") && !valid_package("d-xyz") && !valid_package("artikel"));
    }
}
