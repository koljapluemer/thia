//! Publishing a draft as a lesson: data, not a build. A view goes out as itself; a visualization as the vizint view
//! started on it (`build_viz`); a lesson of several views as each of those under one link (`sequence.rs`). Each version is a folder of static files on the lesson domain
//! (`packages/workshop/src/lesson.ts` has the format), named by what's in it, and a publication points at its current
//! one. A draft has one publication, so its link stays the same across versions; unpublishing switches the link off.
//!
//! Before anything is written:
//! - the check passes, the same the agents run (`@gestalts/check`, through the worker): it compiles and typechecks,
//!   reads and writes gestalts the player has or the draft defines, imports npm pinned in view.json, loads nothing
//!   from other servers; and each package bundles
//! - every member is valid, here
//! - the player for the runtime of the page publishing it is deployed here: what the draft's preview runs, and what
//!   the lesson's link serves it with from then on
//! - a gestalt published before keeps its structure (a change is a new version); a lesson whose gestalts changed since
//!   its last version is published with a warning, since students' data stays on their devices

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use gestalts_core::gestalt::GESTALT;
use gestalts_core::{Gestalts, Yml, YmlState, blobs_of};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::auth::SignedIn;
use crate::npm::{Ensure, ensure, package_of};
use crate::validate::{draft_gestalts, is_view};
use crate::{ApiError, ApiResult, AppState, now_iso, random_token};

#[derive(Serialize)]
pub struct Published {
    pub id: String,
    pub url: String,
    pub manifest: String,
    pub updated: String,
    pub revoked: Option<String>,
    /// what its author should know, though it went out
    pub warnings: Vec<String>,
}

fn hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn strings(v: &serde_yaml_ng::Value) -> Vec<String> {
    v.as_sequence().into_iter().flatten().filter_map(|s| s.as_str().map(str::to_owned)).collect()
}

/// A bundle's file name on the lesson domain: by specifier, version and content, shared by every lesson.
fn npm_name(spec: &str, version: &str, hash: &str) -> String {
    let safe: String = spec.chars().map(|c| if c.is_ascii_alphanumeric() || "._@-".contains(c) { c } else { '+' }).collect();
    format!("{safe}@{version}-{}.js", &hash[..12])
}

fn io(e: std::io::Error) -> ApiError {
    ApiError::Internal(e.to_string())
}

/// What the lesson folder holds before it's written.
pub(crate) struct Version {
    /// by path in the version's folder
    pub(crate) files: BTreeMap<String, Vec<u8>>,
    /// by path in the version's folder (`blobs/<name>`), to where it is in the draft
    pub(crate) blobs: BTreeMap<String, PathBuf>,
    pub(crate) npm: BTreeMap<String, (PathBuf, String)>,
    pub(crate) definitions: BTreeMap<String, String>,
}

/// What a view folder (a draft's, or a submission's snapshot) needs to go out: checked, compiled, its npm bundled.
pub struct Check<'a> {
    pub dir: &'a std::path::Path,
    /// the view yml's id
    pub view: &'a str,
    /// what its own gestalts are named in
    pub package: &'a str,
    /// what it's judged beside: a lesson's gestalts, or the submitter's
    pub gestalts: &'a Gestalts,
    /// as a lesson, for the frame runtime of the page publishing it (`FrameRuntime.version`), whose player must be
    /// here; none for a submission, which the public site's build runs
    pub lesson: Option<&'a str>,
}

/// What's said when the page publishing has no player here (an old page, or the site updated but its
/// player not installed yet): nothing they can fix but by reloading, or by telling who runs the site.
const UPDATED: &str = "This site was just updated and can't publish yet. Reload the page and try again; if it keeps happening, tell your admin.";

/// The lesson a view folder makes, or why it can't go out. A submission is checked the same way.
pub(crate) async fn build(state: &AppState, c: &Check<'_>) -> ApiResult<Version> {
    let dir = c.dir.to_owned();
    let s = gestalts_fs::FsStorage::new(&dir);
    let view_text = s.read_yml_sync(c.view)?.ok_or_else(|| ApiError::BadRequest("the draft has no view yet".into()))?;
    let view = Yml::parse(c.view.to_owned(), view_text);
    if !matches!(c.gestalts.classify(&view), YmlState::Valid(ref g) if is_view(g)) {
        return Err(ApiError::BadRequest("the draft's view isn't valid".into()));
    }
    let m = view.map().ok_or_else(|| ApiError::BadRequest("the draft's view isn't valid".into()))?;
    let field = |k: &str| m.get(k).cloned().unwrap_or(serde_yaml_ng::Value::Null);
    let (title, source) = (view.str_field("title").unwrap_or_default().to_owned(), view.str_field("source").unwrap_or_default().to_owned());
    let (reads, writes, members) = (strings(&field("reads")), strings(&field("writes")), strings(&field("members")));
    let runtime = c.lesson.unwrap_or_default().to_owned();
    let npm: BTreeMap<String, String> = field("npm").as_mapping().into_iter().flatten().filter_map(|(k, v)| Some((k.as_str()?.to_owned(), v.as_str()?.to_owned()))).collect();
    let mut problems = Vec::new();

    if c.lesson.is_some() && crate::lessons::player_page(state, &runtime).is_none() {
        return Err(ApiError::Conflict(UPDATED.into()));
    }

    // the members, as the lesson ships them
    let mut texts = BTreeMap::new();
    for id in &members {
        match s.read_yml_sync(id)? {
            Some(t) => { texts.insert(id.clone(), t); }
            None => problems.push(format!("{id}: a member that isn't there")),
        }
    }
    let gestalts = draft_gestalts(c.gestalts, c.package, texts.iter().filter(|(_, t)| t.contains(GESTALT)).map(|(i, t)| (i.clone(), t.clone())));
    let mut definitions = BTreeMap::new();
    let mut blobs = BTreeMap::new();
    for (id, text) in &texts {
        let y = Yml::parse(id.clone(), text.clone());
        let st = gestalts.classify(&y);
        match &st {
            YmlState::Valid(g) if g == GESTALT => {
                if let Ok(d) = gestalts.definition(&y) {
                    definitions.insert(d.id(), d.structure_hash());
                }
            }
            YmlState::Valid(_) => {}
            _ => problems.push(format!("{id}: not valid")),
        }
        for b in blobs_of(&y, &st, &gestalts).into_iter().filter(|b| gestalts_core::yml::valid_key(b)) {
            let p = dir.join("blobs").join(&b);
            if p.is_file() { blobs.insert(b, p); } else { problems.push(format!("{id}: its file {b} isn't there")); }
        }
    }
    // the check, as the agents run it, on the view and its members; the gestalts the app has besides the draft's own
    let mut all = texts.clone();
    all.insert(c.view.to_owned(), view.raw.clone());
    let known: Vec<String> = c.gestalts.defs().iter().map(|d| d.id()).collect();
    problems.extend(state.worker.check_draft(&all, c.view, &known).await.map_err(ApiError::Internal)?);
    if !problems.is_empty() {
        return Err(ApiError::Invalid(problems));
    }
    // the view, compiled as the frame loads it (the check compiled it the same)
    let compiled = state.worker.call("compile", json!({ "source": source })).await.map_err(ApiError::Internal)?;
    if compiled["ok"] != true {
        return Err(ApiError::Internal("the view compiled in the check, but not after it".into()));
    }
    let imports: Vec<String> = compiled["npm"].as_array().into_iter().flatten().filter_map(|s| s.as_str().map(str::to_owned)).collect();
    let bundled = ensure(state, &Ensure { npm: npm.clone(), imports }).await.map_err(|e| ApiError::Invalid(vec![e]))?;
    let mut npm_files = BTreeMap::new();
    for (spec, b) in bundled {
        let version = npm.get(package_of(&spec)).cloned().unwrap_or_default();
        npm_files.insert(spec.clone(), (b.file, npm_name(&spec, &version, &b.hash)));
    }

    let js = compiled["js"].as_str().unwrap_or_default().as_bytes().to_vec();
    let ymls: Vec<Value> = texts.iter().map(|(id, text)| json!({ "id": id, "text": text })).collect();
    let index = json!({ "ymls": texts.keys().collect::<Vec<_>>(), "blobs": blobs.keys().collect::<Vec<_>>() });
    let mut files = BTreeMap::new();
    let view_name = format!("view.{}.js", &hex(&js)[..12]);
    files.insert(view_name.clone(), js);
    files.insert("ymls.json".to_owned(), serde_json::to_vec(&ymls).expect("json"));
    files.insert("index.json".to_owned(), serde_json::to_vec(&index).expect("json"));
    let manifest = json!({
        "format": "lesson@1",
        "title": title,
        "runtime": runtime,
        "reads": reads,
        "writes": writes,
        "view": view_name,
        "npm": npm_files.iter().map(|(spec, (_, name))| (spec.clone(), json!(format!("/npm/{name}")))).collect::<serde_json::Map<_, _>>(),
        "published": now_iso(),
    });
    files.insert("manifest.json".to_owned(), serde_json::to_vec_pretty(&manifest).expect("json"));
    let blobs = blobs.into_iter().map(|(b, p)| (format!("blobs/{b}"), p)).collect();
    Ok(Version { files, blobs, npm: npm_files, definitions })
}

/// The view a viz is played in, in a lesson as on the public site.
const VIZ_VIEW: &str = "plugins/vizint/view.tsx";

/// The lesson a viz's draft makes: the vizint view started on it (`params`), and the viz with its page, still and files
/// as the deck. It has to have been built: its page is what the check in the page (or the worker) passed. With
/// `GESTALTS_VIZ_RENDER=worker` it's checked and rendered again here, since this server can.
pub(crate) async fn build_viz(state: &AppState, dir: &std::path::Path, id: &str, runtime: &str) -> ApiResult<Version> {
    use base64::Engine as _;
    if crate::lessons::player_page(state, runtime).is_none() {
        return Err(ApiError::Conflict(UPDATED.into()));
    }
    let s = gestalts_fs::FsStorage::new(dir);
    let text = s.read_yml_sync(id)?.ok_or_else(|| ApiError::BadRequest("the draft has no visualization yet".into()))?;
    let viz = Yml::parse(id.to_owned(), text.clone());
    let st = state.gestalts.classify(&viz);
    if !matches!(st, YmlState::Valid(ref g) if g == "viz@1") {
        return Err(ApiError::BadRequest("the draft's visualization isn't valid".into()));
    }
    if viz.str_field("built").is_none_or(str::is_empty) {
        return Err(ApiError::Invalid(vec!["it hasn't been built yet: build it, and publish once its check passed".into()]));
    }
    let mut blobs = BTreeMap::new();
    let mut problems = Vec::new();
    for b in blobs_of(&viz, &st, &state.gestalts).into_iter().filter(|b| gestalts_core::yml::valid_key(b)) {
        let p = dir.join("blobs").join(&b);
        if p.is_file() { blobs.insert(b, p); } else { problems.push(format!("its file {b} isn't there")); }
    }
    if !problems.is_empty() {
        return Err(ApiError::Invalid(problems));
    }
    if state.agents.viz_render == crate::agent::VizRender::Worker {
        let m = viz.map().ok_or_else(|| ApiError::BadRequest("the draft's visualization isn't valid".into()))?;
        let packages: serde_json::Map<String, Value> = m.get("packages").map(strings).unwrap_or_default().iter().filter_map(|p| p.rsplit_once('@')).map(|(n, v)| (n.to_owned(), json!(v))).collect();
        let files = BTreeMap::from([
            ("viz.ts".to_owned(), viz.str_field("source").unwrap_or_default().to_owned()),
            ("package.json".to_owned(), json!({ "dependencies": packages }).to_string()),
        ]);
        let mut binary = BTreeMap::new();
        for f in m.get("files").and_then(|v| v.as_sequence()).into_iter().flatten() {
            let (Some(file), Some(label)) = (f.get("file").and_then(|x| x.as_str()), f.get("label").and_then(|x| x.as_str())) else { continue };
            let bytes = std::fs::read(dir.join("blobs").join(file)).map_err(io)?;
            binary.insert(format!("files/{label}"), base64::engine::general_purpose::STANDARD.encode(bytes));
        }
        let (ok, content) = state.worker.check_viz(&files, &binary).await.map_err(ApiError::Internal)?;
        if !ok {
            let report = content.first().and_then(|c| c["text"].as_str()).unwrap_or_default();
            return Err(ApiError::Invalid(report.lines().filter(|l| l.starts_with('✗') || l.starts_with("    ")).map(|l| l.trim().trim_start_matches("✗ ").to_owned()).filter(|l| !l.starts_with("not yet")).collect()));
        }
    }
    let source = std::fs::read_to_string(state.worker.repo().join(VIZ_VIEW)).map_err(|e| ApiError::Internal(format!("{VIZ_VIEW}: {e}")))?;
    let compiled = state.worker.call("compile", json!({ "source": source })).await.map_err(ApiError::Internal)?;
    if compiled["ok"] != true || compiled["npm"].as_array().is_some_and(|n| !n.is_empty()) {
        return Err(ApiError::Internal(format!("{VIZ_VIEW} doesn't compile to a view without npm packages")));
    }
    let js = compiled["js"].as_str().unwrap_or_default().as_bytes().to_vec();
    let view_name = format!("view.{}.js", &hex(&js)[..12]);
    let mut files = BTreeMap::new();
    files.insert(view_name.clone(), js);
    files.insert("ymls.json".to_owned(), serde_json::to_vec(&json!([{ "id": id, "text": text }])).expect("json"));
    files.insert("index.json".to_owned(), serde_json::to_vec(&json!({ "ymls": [id], "blobs": blobs.keys().collect::<Vec<_>>() })).expect("json"));
    let manifest = json!({
        "format": "lesson@1",
        "title": viz.str_field("title").unwrap_or_default(),
        "runtime": runtime,
        "reads": ["viz@1"],
        "writes": [],
        "view": view_name,
        "npm": {},
        "params": { "viz": id },
        "published": now_iso(),
    });
    files.insert("manifest.json".to_owned(), serde_json::to_vec_pretty(&manifest).expect("json"));
    let blobs = blobs.into_iter().map(|(b, p)| (format!("blobs/{b}"), p)).collect();
    Ok(Version { files, blobs, npm: BTreeMap::new(), definitions: BTreeMap::new() })
}

/// The version's name: a hash of everything in it but when it was published.
fn version_name(v: &Version) -> ApiResult<String> {
    let mut h = Sha256::new();
    for (name, bytes) in &v.files {
        h.update(name.as_bytes());
        if name == "manifest.json" || name.ends_with("/manifest.json") {
            let mut m: Value = serde_json::from_slice(bytes).map_err(|e| ApiError::Internal(e.to_string()))?;
            m.as_object_mut().map(|o| o.remove("published"));
            h.update(m.to_string().as_bytes());
        } else {
            h.update(bytes);
        }
    }
    for (name, path) in &v.blobs {
        h.update(name.as_bytes());
        h.update(std::fs::read(path).map_err(io)?);
    }
    Ok(h.finalize().iter().take(8).map(|b| format!("{b:02x}")).collect())
}

fn write(state: &AppState, lesson: &str, name: &str, v: &Version) -> ApiResult<()> {
    let dir = state.data.join("lessons").join(lesson).join(name);
    if dir.join("manifest.json").is_file() {
        // the same content again: already there, and it never changes
        return Ok(());
    }
    let tmp = state.data.join("lessons").join(lesson).join(format!(".{name}.tmp"));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(tmp.join("blobs")).map_err(io)?;
    for (file, bytes) in &v.files {
        let to = tmp.join(file);
        std::fs::create_dir_all(to.parent().expect("in the folder")).map_err(io)?;
        std::fs::write(to, bytes).map_err(io)?;
    }
    for (path, from) in &v.blobs {
        let to = tmp.join(path);
        std::fs::create_dir_all(to.parent().expect("in the folder")).map_err(io)?;
        std::fs::copy(from, to).map_err(io)?;
    }
    let npm = state.data.join("npm");
    std::fs::create_dir_all(&npm).map_err(io)?;
    for (from, name) in v.npm.values() {
        if !npm.join(name).is_file() {
            std::fs::copy(from, npm.join(format!(".{name}.tmp"))).map_err(io)?;
            std::fs::rename(npm.join(format!(".{name}.tmp")), npm.join(name)).map_err(io)?;
        }
    }
    std::fs::rename(&tmp, &dir).map_err(io)
}

impl AppState {
    fn lesson_url(&self, id: &str) -> String {
        format!("{}/l/{id}", self.lesson_origin.trim_end_matches('/'))
    }

    fn published(&self, p: crate::db::Publication, warnings: Vec<String>) -> Published {
        Published { url: self.lesson_url(&p.id), id: p.id, manifest: p.manifest, updated: p.updated, revoked: p.revoked, warnings }
    }
}

#[derive(serde::Deserialize, Default)]
struct PublishRequest {
    /// the frame runtime of the page publishing it
    #[serde(default)]
    runtime: Option<String>,
}

async fn publish(State(state): State<AppState>, me: SignedIn, Path(id): Path<String>, body: Option<Json<PublishRequest>>) -> ApiResult<Json<Published>> {
    let (draft, _) = state.own_draft(&me, &id)?;
    let runtime = body.map(|Json(b)| b).unwrap_or_default().runtime.ok_or_else(|| ApiError::Conflict(UPDATED.into()))?;
    let _guard = state.writes.lock().await;
    let version = match draft.kind.as_str() {
        "view" => build(&state, &Check { dir: &state.draft_dir(&draft.id), view: &draft.id, package: &draft.package, gestalts: &state.gestalts, lesson: Some(&runtime) }).await?,
        "viz" => build_viz(&state, &state.draft_dir(&draft.id), &draft.id, &runtime).await?,
        "sequence" => crate::sequence::build(&state, &me.0, &draft, &runtime).await?,
        k => return Err(ApiError::Internal(format!("{}: a draft of kind {k}", draft.id))),
    };
    let previous = state.db.publication_of(&draft.id)?;
    let mut warnings = Vec::new();
    if let Some(p) = &previous {
        let before: BTreeMap<String, String> = serde_json::from_str(&p.definitions).unwrap_or_default();
        let changed: Vec<String> = version.definitions.iter().filter(|(g, h)| before.get(*g).is_some_and(|b| b != *h)).map(|(g, _)| {
            let (name, n) = g.rsplit_once('@').unwrap_or((g, "1"));
            format!("{g} was published before with other fields: name the changed one {name}@{}", n.parse::<u32>().unwrap_or(1) + 1)
        }).collect();
        if !changed.is_empty() {
            return Err(ApiError::Invalid(changed));
        }
        let (old, new): (BTreeSet<&String>, BTreeSet<&String>) = (before.keys().collect(), version.definitions.keys().collect());
        if old != new {
            warnings.push("This version keeps its data in other gestalts than the last one: what students did with the last version stays on their devices, but this one doesn't show it.".into());
        }
    }
    let lesson = previous.as_ref().map_or_else(|| random_token(16), |p| p.id.clone());
    let name = version_name(&version)?;
    let definitions = serde_json::to_string(&version.definitions).expect("json");
    {
        let st = state.clone();
        let (l, n) = (lesson.clone(), name.clone());
        tokio::task::spawn_blocking(move || write(&st, &l, &n, &version)).await.map_err(|e| ApiError::Internal(e.to_string()))??;
    }
    let manifest = format!("/lessons/{lesson}/{name}/manifest.json");
    let now = now_iso();
    match previous {
        Some(_) => state.db.update_publication(&lesson, &manifest, &definitions, &now)?,
        None => state.db.add_publication(&lesson, &draft, &manifest, &definitions, &now)?,
    }
    let p = state.db.publication(&lesson)?.ok_or_else(|| ApiError::Internal("the publication just written isn't there".into()))?;
    Ok(Json(state.published(p, warnings)))
}

async fn get_publication(State(state): State<AppState>, me: SignedIn, Path(id): Path<String>) -> ApiResult<Json<Option<Published>>> {
    let (draft, _) = state.own_draft(&me, &id)?;
    Ok(Json(state.db.publication_of(&draft.id)?.map(|p| state.published(p, vec![]))))
}

async fn unpublish(State(state): State<AppState>, me: SignedIn, Path(id): Path<String>) -> ApiResult<StatusCode> {
    let (draft, _) = state.own_draft(&me, &id)?;
    let p = state.db.publication_of(&draft.id)?.ok_or(ApiError::NotFound)?;
    state.db.revoke_publication(&p.id, &now_iso())?;
    Ok(StatusCode::NO_CONTENT)
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/drafts/{id}/publish", post(publish))
        .route("/drafts/{id}/publication", axum::routing::get(get_publication).delete(unpublish))
}
