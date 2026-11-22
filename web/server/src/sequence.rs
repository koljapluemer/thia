//! A lesson of several views (`sequence@1`): a draft holding only its sequence, whose steps are the account's view
//! drafts. Checked as a whole here, since the steps are other drafts' folders: that every step's view is there, that
//! the rules' concepts are, and (warnings) whether an earlier step practises what a rule asks about, without which the
//! rule never applies on a new device. Published as `lesson@2`: each view as a `lesson@1` folder under `views/<n>/`,
//! and a manifest naming the steps by those, all on the runtime of the page publishing it.

use std::collections::{BTreeMap, BTreeSet};

use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use gestalts_core::Yml;
use gestalts_fs::FsStorage;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::auth::Teacher;
use crate::db::{Account, Draft};
use crate::publish::{Check, Version, build as build_view};
use crate::{ApiError, ApiResult, AppState, now_iso, random_hex};

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

/// How the agent splits a lesson into views: one call, low effort, the same model as the rest.
const PLAN: &str = include_str!("../../../packages/workshop/agent-template/plan-lesson.md");

#[derive(Deserialize)]
struct PlanRequest {
    request: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct Concept {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct Extra {
    pub concept: String,
    pub title: String,
    pub brief: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "snake_case")]
pub enum Rule {
    SkipIfKnown(String),
    Detour(Extra),
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct Planned {
    pub title: String,
    pub does: String,
    pub brief: String,
    #[serde(default)]
    pub practises: Vec<Concept>,
    #[serde(default)]
    pub rule: Option<Rule>,
}

/// What the agent proposes: one view (and why), or a lesson's steps.
#[derive(Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum Plan {
    One { one_view: String },
    Steps { title: String, steps: Vec<Planned> },
}

fn concept_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') && !id.starts_with('-')
}

/// What a view practises, said to the agent that builds it so the lesson's rules can see it: appended to every brief
/// here, whatever the plan said.
fn concepts_line(cs: &[Concept]) -> String {
    if cs.is_empty() {
        return String::new();
    }
    let list = cs.iter().map(|c| format!("`{}` ({})", c.id, c.name)).collect::<Vec<_>>().join(", ");
    format!("\n\nIt is a step of a lesson of several views, and practises {list}. Put each in data/ as `data/<id>.yml` with `gestalt: concept@2` and its `name`, name it in the `concepts` of the items that practise it, and log each answer with `logPractice`: the lesson skips or adds steps by what the student knows of them. When the student is through, call `done()` from `useHost()`.")
}

/// The plan as the agent wrote it, checked: ids that can be ymls, at most one rule each, a rule's concept practised
/// by an earlier step. Each brief gets what ties its view to the rules.
fn checked(text: &str) -> Result<Plan, String> {
    let json = text.trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim();
    let mut plan: Plan = serde_json::from_str(json).map_err(|e| format!("the plan isn't one: {e}"))?;
    if let Plan::Steps { steps, .. } = &mut plan {
        if steps.is_empty() || steps.len() > 6 {
            return Err("the plan has no steps, or too many".into());
        }
        let mut practised: BTreeSet<String> = BTreeSet::new();
        for (i, st) in steps.iter_mut().enumerate() {
            if let Some(c) = st.practises.iter().find(|c| !concept_id(&c.id)) {
                return Err(format!("step {}: {} isn't a concept id", i + 1, c.id));
            }
            let concept = match &st.rule {
                Some(Rule::SkipIfKnown(c)) => Some(c.clone()),
                Some(Rule::Detour(d)) => Some(d.concept.clone()),
                None => None,
            };
            // a rule nothing before it can feed never applies: dropped, rather than kept to mislead
            if concept.as_ref().is_some_and(|c| !practised.contains(c)) {
                st.rule = None;
            }
            practised.extend(st.practises.iter().map(|c| c.id.clone()));
            let line = concepts_line(&st.practises);
            st.brief.push_str(&line);
            if let Some(Rule::Detour(d)) = &mut st.rule {
                let c = st.practises.iter().find(|c| c.id == d.concept).cloned().unwrap_or(Concept { id: d.concept.clone(), name: d.concept.clone() });
                d.brief.push_str(&concepts_line(&[c]));
            }
        }
    }
    Ok(plan)
}

/// The agent proposes how the lesson splits into views; nothing is made until the teacher takes it.
async fn plan(State(state): State<AppState>, teacher: Teacher, Path(id): Path<String>, Json(req): Json<PlanRequest>) -> ApiResult<Json<Plan>> {
    let (d, _) = state.own_draft(&teacher, &id)?;
    if d.kind != "sequence" {
        return Err(ApiError::NotFound);
    }
    if req.request.trim().is_empty() || req.request.chars().count() > 4000 {
        return Err(ApiError::BadRequest("say what the lesson should do, in up to 4000 characters".into()));
    }
    if let Some(r) = state.agents.unavailable() {
        return Err(ApiError::Conflict(r));
    }
    if state.db.tokens_since(&teacher.0.id, &crate::agent::month_start())? >= teacher.0.token_budget {
        return Err(ApiError::TooMany("this month's budget for the agent is used up".into()));
    }
    let turn = random_hex(16);
    state.db.add_turn(&turn, &teacher.0.id, &d.id, &now_iso())?;
    let resp = state.agents.call_once(PLAN, req.request.trim()).await.map_err(ApiError::Conflict)?;
    let u = &resp["usage"];
    let n = |k: &str| u[k].as_i64().unwrap_or(0);
    let _ = state.db.add_usage(&turn, n("input_tokens"), n("output_tokens"), n("cache_read_input_tokens"), n("cache_creation_input_tokens"));
    let text: String = resp["content"].as_array().into_iter().flatten().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect();
    checked(&text).map(Json).map_err(|e| ApiError::Conflict(format!("The agent's plan didn't come out right ({e}). Try again, or put the request differently.")))
}

pub fn routes() -> Router<AppState> {
    Router::new().route("/drafts/{id}/sequence", get(report)).route("/drafts/{id}/sequence/plan", post(plan))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plan_is_checked_and_tied_to_its_rules() {
        assert!(matches!(checked(r#"{"one_view": "a quiz"}"#), Ok(Plan::One { .. })));
        let text = r#"```json
        {"title": "Plus", "steps": [
          {"title": "Check", "does": "4 sums", "brief": "Four sums.", "practises": [{"id": "zehner", "name": "Zehnerübergang"}], "rule": {"skip_if_known": "zehner"}},
          {"title": "Main", "does": "sums", "brief": "Sums.", "practises": [{"id": "zehner", "name": "Zehnerübergang"}], "rule": {"detour": {"concept": "zehner", "title": "Easy", "brief": "Easier."}}}
        ]}```"#;
        let Ok(Plan::Steps { steps, .. }) = checked(text) else { panic!("a plan") };
        assert!(steps[0].rule.is_none(), "a rule on the first step never applies: dropped");
        assert!(matches!(&steps[1].rule, Some(Rule::Detour(d)) if d.brief.contains("`zehner` (Zehnerübergang)")));
        assert!(steps[0].brief.starts_with("Four sums.") && steps[0].brief.contains("gestalt: concept@2") && steps[0].brief.contains("done()"));
        assert!(checked(r#"{"title": "x", "steps": [{"title": "a", "does": "b", "brief": "c", "practises": [{"id": "Bad Id", "name": "x"}]}]}"#).is_err());
        assert!(checked("not json").is_err());
    }
}
