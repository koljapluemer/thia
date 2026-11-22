//! A lesson of several views (`sequence@1`): a draft holding only its sequence, whose steps are the account's view
//! drafts. Checked as a whole here, since the steps are other drafts' folders: that every step's view is there, that
//! the rules' concepts are, and (warnings) whether an earlier step practises what a rule asks about, without which the
//! rule never applies on a new device. Published as `lesson@2`: each view as a `lesson@1` folder under `views/<n>/`,
//! and a manifest naming the steps by those, all on the runtime of the page publishing it.

use std::collections::{BTreeMap, BTreeSet};

use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Json, Router};
use gestalts_core::Yml;
use gestalts_fs::FsStorage;
use serde::Serialize;
use serde_json::json;

use crate::auth::Teacher;
use crate::db::{Account, Draft};
use crate::publish::{Check, Version, build as build_view};
use crate::{ApiError, ApiResult, AppState, now_iso};

/// A step as written.
#[derive(Debug, Clone, PartialEq)]
pub struct Step {
    pub view: String,
    pub skip_if_known: Option<String>,
    pub detour: Option<(String, String)>,
}

impl Step {
    fn concept(&self) -> Option<&str> {
        self.skip_if_known.as_deref().or(self.detour.as_ref().map(|(c, _)| c.as_str()))
    }
}

/// A view draft, as a sequence sees it.
#[derive(Debug, Clone, Default, Serialize)]
pub struct StepView {
    pub id: String,
    pub title: String,
    /// the concepts it practises: its members that are concepts, and those its members name
    pub practises: Vec<String>,
}

/// What a sequence's check says, and what the workshop's editor needs: the account's views to pick from, the
/// concepts they practise (by id, with names).
#[derive(Debug, Default, Serialize)]
pub struct Report {
    pub problems: Vec<String>,
    pub warnings: Vec<String>,
    pub views: Vec<StepView>,
    pub concepts: BTreeMap<String, String>,
}

fn steps_of(y: &Yml) -> Vec<Step> {
    let s = |v: &serde_yaml_ng::Value, k: &str| v.get(k).and_then(|x| x.as_str()).map(str::trim).filter(|x| !x.is_empty()).map(str::to_owned);
    y.map().and_then(|m| m.get("steps")).and_then(|v| v.as_sequence()).into_iter().flatten().map(|st| Step {
        view: s(st, "view").unwrap_or_default(),
        skip_if_known: s(st, "skip_if_known"),
        detour: st.get("detour").and_then(|d| Some((s(d, "concept")?, s(d, "view")?))),
    }).collect()
}

/// The sequence a draft holds: its title and steps.
fn read(state: &AppState, d: &Draft) -> ApiResult<(String, Vec<Step>)> {
    let text = FsStorage::new(state.draft_dir(&d.id)).read_yml_sync(&d.id)?.ok_or_else(|| ApiError::BadRequest("the lesson has no steps yet".into()))?;
    let y = Yml::parse(d.id.clone(), text);
    Ok((y.str_field("title").unwrap_or_default().to_owned(), steps_of(&y)))
}

/// A view draft's title and the concepts it practises, with their names.
fn view_of(state: &AppState, d: &Draft, names: &mut BTreeMap<String, String>) -> ApiResult<StepView> {
    let store = FsStorage::new(state.draft_dir(&d.id));
    let Some(text) = store.read_yml_sync(&d.id)? else { return Ok(StepView { id: d.id.clone(), title: d.title.clone(), practises: vec![] }) };
    let view = Yml::parse(d.id.clone(), text);
    let members: Vec<String> = view.map().and_then(|m| m.get("members")).and_then(|v| v.as_sequence()).into_iter().flatten().filter_map(|v| v.as_str().map(str::to_owned)).collect();
    let mut practises = BTreeSet::new();
    for id in &members {
        let Some(t) = store.read_yml_sync(id)? else { continue };
        let y = Yml::parse(id.clone(), t);
        let gestalt = y.str_field("gestalt").unwrap_or_default();
        if gestalt.starts_with("concept@") {
            practises.insert(id.clone());
            if let Some(n) = y.str_field("name") {
                names.insert(id.clone(), n.to_owned());
            }
        }
        for c in y.map().and_then(|m| m.get("concepts")).and_then(|v| v.as_mapping()).into_iter().flatten().filter_map(|(k, _)| k.as_str()) {
            practises.insert(c.to_owned());
        }
    }
    Ok(StepView { id: d.id.clone(), title: view.str_field("title").unwrap_or(&d.title).to_owned(), practises: practises.into_iter().collect() })
}

/// The check of the steps as written, against the account's views.
pub fn check(state: &AppState, account: &Account, steps: &[Step]) -> ApiResult<Report> {
    let mut r = Report::default();
    for d in state.db.drafts(&account.id)?.into_iter().filter(|d| d.kind == "view") {
        r.views.push(view_of(state, &d, &mut r.concepts)?);
    }
    let by_id: BTreeMap<&str, &StepView> = r.views.iter().map(|v| (v.id.as_str(), v)).collect();
    if steps.is_empty() {
        r.problems.push("a lesson has at least one step".into());
    }
    // every concept a step's views practise, wherever in the lesson: what a rule may name
    let known: BTreeSet<&str> = steps.iter().flat_map(|s| std::iter::once(s.view.as_str()).chain(s.detour.as_ref().map(|(_, v)| v.as_str())))
        .filter_map(|v| by_id.get(v)).flat_map(|v| v.practises.iter().map(String::as_str)).collect();
    let mut practised: BTreeSet<&str> = BTreeSet::new();
    for (i, st) in steps.iter().enumerate() {
        let n = i + 1;
        if !by_id.contains_key(st.view.as_str()) {
            r.problems.push(format!("step {n}: no view {}", if st.view.is_empty() { "picked" } else { &st.view }));
        }
        if let Some((_, v)) = &st.detour && !by_id.contains_key(v.as_str()) {
            r.problems.push(format!("step {n}: its detour has no view {v}"));
        }
        if let Some(c) = st.concept() {
            if !known.contains(c) {
                r.problems.push(format!("step {n}: no step's view practises the concept {c} its rule names"));
            } else if !practised.contains(c) {
                let name = r.concepts.get(c).map_or(c, String::as_str);
                r.warnings.push(if practised.is_empty() {
                    format!("step {n}: its rule asks about {name} before any step practised it, so on a new device it never applies: start with a short step that does")
                } else {
                    format!("step {n}: no earlier step practises {name}, so its rule may never apply")
                });
            }
        }
        if let Some(v) = by_id.get(st.view.as_str()) {
            practised.extend(v.practises.iter().map(String::as_str));
        }
    }
    Ok(r)
}

/// The lesson a sequence draft makes, or why it can't go out: every view as a lesson, under `views/<n>/`, all on
/// `runtime`, which one player page plays them with.
pub(crate) async fn build(state: &AppState, account: &Account, d: &Draft, runtime: &str) -> ApiResult<Version> {
    let (title, steps) = read(state, d)?;
    let report = check(state, account, &steps)?;
    if !report.problems.is_empty() {
        return Err(ApiError::Invalid(report.problems));
    }
    let mut views: Vec<String> = Vec::new();
    let index = |v: &str, views: &mut Vec<String>| views.iter().position(|x| x == v).unwrap_or_else(|| { views.push(v.to_owned()); views.len() - 1 });
    let mut out_steps = Vec::new();
    for st in &steps {
        let mut s = json!({ "view": index(&st.view, &mut views) });
        if let Some(c) = &st.skip_if_known {
            s["skipIfKnown"] = json!(c);
        } else if let Some((c, v)) = &st.detour {
            s["detour"] = json!({ "concept": c, "view": index(v, &mut views) });
        }
        out_steps.push(s);
    }
    let mut out = Version { files: BTreeMap::new(), blobs: BTreeMap::new(), npm: BTreeMap::new(), definitions: BTreeMap::new() };
    for (i, v) in views.iter().enumerate() {
        let vd = state.db.draft(v, &account.id)?.ok_or_else(|| ApiError::Invalid(vec![format!("step view {v} isn't there")]))?;
        let one = build_view(state, &Check { dir: &state.draft_dir(&vd.id), view: &vd.id, package: &vd.package, gestalts: &state.gestalts, lesson: Some(runtime) }).await.map_err(|e| match e {
            ApiError::Invalid(p) => ApiError::Invalid(p.into_iter().map(|p| format!("{}: {p}", vd.title)).collect()),
            ApiError::BadRequest(m) => ApiError::BadRequest(format!("{}: {m}", vd.title)),
            e => e,
        })?;
        let at = format!("views/{i}");
        out.files.extend(one.files.into_iter().map(|(f, b)| (format!("{at}/{f}"), b)));
        out.blobs.extend(one.blobs.into_iter().map(|(f, p)| (format!("{at}/{f}"), p)));
        out.npm.extend(one.npm);
        out.definitions.extend(one.definitions);
    }
    let manifest = json!({
        "format": "lesson@2",
        "title": title,
        "runtime": runtime,
        "views": (0..views.len()).map(|i| format!("views/{i}")).collect::<Vec<_>>(),
        "steps": out_steps,
        "published": now_iso(),
    });
    out.files.insert("manifest.json".to_owned(), serde_json::to_vec_pretty(&manifest).expect("json"));
    Ok(out)
}

/// The sequence's check, and what its editor picks from.
async fn report(State(state): State<AppState>, teacher: Teacher, Path(id): Path<String>) -> ApiResult<Json<Report>> {
    let (d, _) = state.own_draft(&teacher, &id)?;
    if d.kind != "sequence" {
        return Err(ApiError::NotFound);
    }
    let steps = read(&state, &d).map(|(_, s)| s).unwrap_or_default();
    Ok(Json(check(&state, &teacher.0, &steps)?))
}

pub fn routes() -> Router<AppState> {
    Router::new().route("/drafts/{id}/sequence", get(report))
}
