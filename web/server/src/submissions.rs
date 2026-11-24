//! Workshop results offered for the public site, and their review. A submission is a snapshot, never synced: the
//! ymls and blobs it holds as they were when it was sent (`submissions/<id>/`, a folder as a deck is kept, with its
//! `index.json`), and a row saying who sent it, from which draft, and what became of it.
//!
//! - **Sending**: a draft is copied from the server's own folder (`POST /drafts/<id>/submit`), as
//!   `workshop:<draft id>`, by its signed-in owner, who affirms they may share it. Older submissions came from the
//!   workshops that kept drafts in the browser (`make:`, `make-viz:`) or the old lesson area (`teach:`).
//! - **What it is** follows from what it holds: one `view@4` (or an older one) and its members (`view`), or one `viz@1` (`viz`). A view
//!   is checked as publishing checks it: it compiles, and its npm packages are pinned and bundle.
//! - **Review**: the local CMS reads the snapshot and records the decision directly against server data.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path as FsPath, PathBuf};

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use gestalts_core::gestalt::DEFINITION_PREFIX;
use gestalts_core::{Yml, YmlState, blobs_of};
use gestalts_fs::FsStorage;
use serde::Deserialize;
use serde_json::json;

use crate::auth::SignedIn;
use crate::db::Submission;
use crate::publish::{Check, build};
use crate::db::Account;
use crate::validate::{Batch, Kind, check, draft_gestalts};
use crate::{ApiError, ApiResult, AppState, now_iso, random_hex};

/// What a submitted view is: a draft's, written as `view@4` since drafts record their language, or a `view@3` or
/// `view@2` from before.
pub const VIEWS: &[&str] = &["view@2", "view@3", "view@4"];
pub use crate::validate::VIZ;

/// What was sent, before it's checked.
pub struct Sent {
    pub source: String,
    pub about: String,
    pub credit: Option<String>,
    pub ymls: BTreeMap<String, String>,
    pub blobs: BTreeMap<String, Vec<u8>>,
}

#[derive(Deserialize)]
struct Offer {
    about: String,
    #[serde(default)]
    credit: Option<String>,
    /// the sender may share it, and agrees to its being published
    rights: bool,
}

impl AppState {
    pub fn submission_dir(&self, id: &str) -> PathBuf {
        self.data.join("submissions").join(id)
    }
}

fn io(e: impl std::fmt::Display) -> ApiError {
    ApiError::Internal(e.to_string())
}

fn line(s: &str, what: &str, max: usize) -> ApiResult<()> {
    if s.chars().count() > max || s.contains('\n') {
        return Err(ApiError::BadRequest(format!("{what}: one line, up to {max} characters")));
    }
    Ok(())
}

fn valid_source(s: &str) -> bool {
    s.split_once(':').is_some_and(|(w, id)| w == "workshop" && !id.is_empty() && id.len() <= 100 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b)))
}

/// The ymls in `ymls` that say they're of `gestalt`.
fn of_gestalt(ymls: &BTreeMap<String, String>, gestalts: &[&str]) -> Vec<Yml> {
    ymls.iter()
        .map(|(id, t)| Yml::parse(id.clone(), t.clone()))
        .filter(|y| y.map().and_then(|m| m.get("gestalt")).and_then(|g| g.as_str()).is_some_and(|g| gestalts.contains(&g)))
        .collect()
}

/// What a snapshot keeps: its kind, title, and the ymls and blobs that go with it (nothing a draft wrote while being
/// tried out).
struct Snapshot {
    kind: &'static str,
    title: String,
    /// the view's id and package, for a view
    view: Option<(String, String)>,
    ymls: BTreeMap<String, String>,
    blobs: BTreeMap<String, Vec<u8>>,
}

fn snapshot(state: &AppState, account: &Account, sent: &Sent) -> ApiResult<Snapshot> {
    let base = state.gestalts_for(account);
    let limits = state.limits_for(account);
    let views = of_gestalt(&sent.ymls, VIEWS);
    let vizzes = of_gestalt(&sent.ymls, &[VIZ]);
    let (kind, keep, gestalts, view) = match (views.as_slice(), vizzes.as_slice()) {
        ([v], []) => {
            let package = v.str_field("package").unwrap_or_default().to_owned();
            let members: Vec<String> = v.map().and_then(|m| m.get("members")).and_then(|m| m.as_sequence()).into_iter().flatten().filter_map(|s| s.as_str().map(str::to_owned)).collect();
            let mut keep: BTreeMap<String, String> = BTreeMap::new();
            keep.insert(v.id.clone(), v.raw.clone());
            let mut problems = Vec::new();
            for m in &members {
                match sent.ymls.get(m) {
                    Some(t) => { keep.insert(m.clone(), t.clone()); }
                    None => problems.push(format!("{m}: a member that isn't there")),
                }
            }
            let ids: BTreeSet<String> = BTreeSet::new();
            problems.extend(check(base, &limits, &Batch { kind: Kind::View, draft: &v.id, package: &package, incoming: &keep, existing: &ids, definitions: &BTreeMap::new() }));
            if !problems.is_empty() {
                return Err(ApiError::Invalid(problems));
            }
            let defs = keep.iter().filter(|(id, _)| id.starts_with(DEFINITION_PREFIX)).map(|(i, t)| (i.clone(), t.clone()));
            let gestalts = draft_gestalts(base, &package, defs);
            ("view", keep, gestalts, Some((v.id.clone(), package)))
        }
        ([], [v]) => {
            let keep = BTreeMap::from([(v.id.clone(), v.raw.clone())]);
            ("viz", keep, base.clone(), None)
        }
        ([], []) => return Err(ApiError::BadRequest("nothing to submit: a view (view@4) or a visualization (viz@1)".into())),
        _ => return Err(ApiError::BadRequest("a submission is one view or one visualization".into())),
    };
    let mut blobs = BTreeMap::new();
    let mut problems = Vec::new();
    let mut title = String::new();
    for (id, text) in &keep {
        if !gestalts_core::yml::valid_key(id) {
            problems.push(format!("{id}: not an id"));
            continue;
        }
        let y = Yml::parse(id.clone(), text.clone());
        let st = gestalts.classify(&y);
        match &st {
            YmlState::Valid(g) if VIEWS.contains(&g.as_str()) || g == VIZ => title = y.str_field("title").unwrap_or_default().trim().to_owned(),
            YmlState::Valid(_) => {}
            _ => problems.push(format!("{id}: not valid")),
        }
        for b in blobs_of(&y, &st, &gestalts) {
            match sent.blobs.get(&b) {
                Some(bytes) if gestalts_core::yml::valid_key(&b) => {
                    if bytes.len() > limits.blob_bytes {
                        problems.push(format!("{id}: its file {b} is larger than {} MB", limits.blob_bytes / 1024 / 1024));
                    }
                    blobs.insert(b, bytes.clone());
                }
                _ => problems.push(format!("{id}: its file {b} isn't there")),
            }
        }
    }
    if title.is_empty() {
        problems.push("it has no title".into());
    }
    if !problems.is_empty() {
        return Err(ApiError::Invalid(problems));
    }
    Ok(Snapshot { kind, title, view, ymls: keep, blobs })
}

fn write_snapshot(dir: &FsPath, s: &Snapshot) -> ApiResult<()> {
    let store = FsStorage::new(dir);
    for (id, text) in &s.ymls {
        store.write_yml_sync(id, text)?;
    }
    for (name, bytes) in &s.blobs {
        store.write_blob_sync(name, bytes)?;
    }
    // read as a deck: the review's preview mounts it
    let index = json!({ "ymls": s.ymls.keys().collect::<Vec<_>>(), "blobs": s.blobs.keys().collect::<Vec<_>>() });
    std::fs::write(dir.join("index.json"), index.to_string()).map_err(io)
}

/// Checks what was sent, keeps its snapshot and queues it.
pub async fn create(state: &AppState, account: &Account, sent: Sent) -> ApiResult<Submission> {
    if !valid_source(&sent.source) {
        return Err(ApiError::BadRequest("source: <workshop>:<draft id>".into()));
    }
    let about = sent.about.trim().to_owned();
    if about.is_empty() || about.chars().count() > 2000 {
        return Err(ApiError::BadRequest("say what it is, in up to 2000 characters".into()));
    }
    let credit = sent.credit.as_deref().map(str::trim).filter(|c| !c.is_empty()).map(str::to_owned);
    if let Some(c) = &credit {
        line(c, "credit", 200)?;
    }
    let source = sent.source.clone();
    let st = state.clone();
    let a = account.clone();
    let snap = tokio::task::spawn_blocking(move || snapshot(&st, &a, &sent)).await.map_err(io)??;
    let id = format!("{}-{}", crate::drafts::slug(&snap.title), random_hex(4));
    let dir = state.submission_dir(&id);
    let snap = {
        let d = dir.clone();
        tokio::task::spawn_blocking(move || write_snapshot(&d, &snap).map(|()| snap)).await.map_err(io)??
    };
    if let Some((view, package)) = &snap.view {
        // as publishing checks it: it compiles, and its npm is pinned and bundles
        if let Err(e) = build(state, &Check { dir: &dir, view, package, gestalts: state.gestalts_for(account), lesson: None }).await {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(e);
        }
    }
    let s = Submission {
        id: id.clone(),
        kind: snap.kind.into(),
        account: account.id.clone(),
        email: String::new(),
        source,
        title: snap.title,
        about,
        credit,
        created: now_iso(),
        status: "pending".into(),
        decided: None,
        note: None,
        promoted: None,
    };
    state.db.add_submission(&s)?;
    state.db.submission(&id)?.ok_or_else(|| ApiError::Internal("the submission just written isn't there".into()))
}

fn rights(o: &Offer) -> ApiResult<()> {
    if o.rights { Ok(()) } else { Err(ApiError::BadRequest("only what you may share, and agree to publish, can be submitted".into())) }
}

/// An account's draft, from the server's own copy.
async fn submit_draft(State(state): State<AppState>, me: SignedIn, Path(id): Path<String>, Json(o): Json<Offer>) -> ApiResult<(StatusCode, Json<Submission>)> {
    rights(&o)?;
    let (draft, store) = state.own_draft(&me, &id)?;
    if draft.kind != "view" {
        return Err(ApiError::BadRequest("only view drafts can be submitted".into()));
    }
    let (ymls, blobs) = tokio::task::spawn_blocking(move || -> ApiResult<_> {
        let mut ymls = BTreeMap::new();
        for y in store.list_ymls_sync()? {
            if let Some(t) = store.read_yml_sync(&y)? {
                ymls.insert(y, t);
            }
        }
        let mut blobs = BTreeMap::new();
        for b in store.list_blobs_sync()? {
            if let Some(bytes) = store.read_blob_sync(&b)? {
                blobs.insert(b, bytes);
            }
        }
        Ok((ymls, blobs))
    })
    .await
    .map_err(io)??;
    let sent = Sent { source: format!("workshop:{}", draft.id), about: o.about, credit: o.credit, ymls, blobs };
    Ok((StatusCode::CREATED, Json(create(&state, &me.0, sent).await?)))
}

#[derive(Deserialize)]
struct Of {
    source: String,
}

/// The signed-in account's own submissions of one draft, and what became of them.
async fn mine(State(state): State<AppState>, me: SignedIn, Query(q): Query<Of>) -> ApiResult<Json<Vec<Submission>>> {
    Ok(Json(state.db.submissions_of(&me.0.id, &q.source)?))
}

// review

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/drafts/{id}/submit", post(submit_draft))
        .route("/submissions", get(mine))
}
