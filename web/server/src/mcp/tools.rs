//! The tools a host calls: the drafting tools every agent has (`crate::drafting`), each naming its draft, and a few
//! of a host's own (finding and making drafts, opening one for a request, the brief, finishing). Each call on a draft
//! is part of the run of the request the session is on: opened by `open_draft`, ended by `finish`, the next request,
//! or idleness (`super::RUN_IDLE`).

use std::collections::BTreeMap;
use std::time::Instant;

use serde_json::{Value, json};

use super::{Open, Session};
use crate::db::{Account, Draft};
use crate::drafting::workbench::summary;
use crate::drafting::{MCP, Workspace};
use crate::runs::server_run::ServerRun;
use crate::validate::Kind;
use crate::{ApiError, AppState, now_iso};

/// The kinds a host can work on here, for now.
const KINDS: &[&str] = &["view"];

pub fn text(t: impl Into<String>) -> Value {
    json!({ "content": [{ "type": "text", "text": t.into() }], "isError": false })
}

pub fn error(t: impl Into<String>) -> Value {
    json!({ "content": [{ "type": "text", "text": t.into() }], "isError": true })
}

fn draft_param() -> Value {
    json!({ "type": "string", "description": "the draft's id, as list_drafts or new_draft gives it" })
}

/// Hints for the host's permission prompts: what only reads, what deletes.
fn annotations(name: &str) -> Value {
    match name {
        "list_drafts" | "open_draft" | "list_files" | "read_file" | "search" | "check" => json!({ "readOnlyHint": true, "openWorldHint": false }),
        "delete_file" => json!({ "readOnlyHint": false, "destructiveHint": true, "openWorldHint": false }),
        _ => json!({ "readOnlyHint": false, "destructiveHint": false, "openWorldHint": false }),
    }
}

/// Every tool, as `tools/list` gives them.
pub fn list(state: &AppState) -> Vec<Value> {
    let own = [
        json!({ "name": "list_drafts", "title": "List drafts", "description": "Lists the person's drafts in thia: id, title, kind. Views can be worked on here.",
          "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false } }),
        json!({ "name": "new_draft", "title": "New draft", "description": "Makes a new, empty view draft and gives its id; then call open_draft with it.",
          "inputSchema": { "type": "object", "properties": {
              "title": { "type": "string", "description": "a short title, in the person's language" },
              "lang": { "type": "string", "description": "the language the view's text is written in, as BCP 47 (de, en, vi): usually the person's" } },
            "required": ["title", "lang"], "additionalProperties": false } }),
        json!({ "name": "open_draft", "title": "Open a draft", "description": "Call at the start of each request about a draft: gives the contract every view keeps, the draft's files and brief, and what its preview reports.",
          "inputSchema": { "type": "object", "properties": {
              "draft": draft_param(),
              "request": { "type": "string", "description": "what the person asked for, in their words" },
              "have_contract": { "type": "boolean", "description": "true when this conversation already has the contract from an earlier open_draft: it's left out then" } },
            "required": ["draft", "request"], "additionalProperties": false } }),
        json!({ "name": "set_brief", "title": "Set the brief", "description": "Replaces the draft's brief (SPEC.md): what the view should be, in the person's words. Keep it up to date when they say what they want.",
          "inputSchema": { "type": "object", "properties": { "draft": draft_param(), "brief": { "type": "string" } }, "required": ["draft", "brief"], "additionalProperties": false } }),
        json!({ "name": "finish", "title": "Finish the request", "description": "Call when you're done with the person's request: a line on what you did.",
          "inputSchema": { "type": "object", "properties": { "draft": draft_param(), "note": { "type": "string" } }, "required": ["draft", "note"], "additionalProperties": false } }),
    ];
    let Some(kind) = state.agents.reference.kind("view") else { return own.to_vec() };
    let drafting = kind.tools(&MCP).into_iter().map(|mut t| {
        let mut schema = t["input_schema"].take();
        schema["properties"]["draft"] = draft_param();
        let mut required = vec![json!("draft")];
        required.extend(schema["required"].as_array().cloned().unwrap_or_default());
        schema["required"] = Value::Array(required);
        json!({ "name": t["name"], "description": t["description"], "inputSchema": schema })
    });
    own.into_iter().chain(drafting).map(|mut t| {
        let name = t["name"].as_str().unwrap_or_default().to_owned();
        t["annotations"] = annotations(&name);
        t
    }).collect()
}

/// The run the session is on ends, saying why: `finish`, the next request (`next`), another draft, idleness, the
/// session's end.
pub async fn end_run(state: &AppState, s: &mut Session, ended: &str) {
    if let Some(mut open) = s.run.take()
        && let Err(e) = open.run.add(state, json!({ "type": "end", "outcome": "completed", "waiting": false, "ended": ended })).await {
        eprintln!("mcp: ending run {}: {e}", open.run.id);
    }
}

/// The ids of the gestalts a view of the account's may use besides its own, as the check takes them.
fn known_gestalts(state: &AppState, account: &Account) -> Vec<String> {
    state.gestalts_for(account).defs().iter().map(|d| d.id()).collect()
}

/// The draft as the agent sees it, and its ymls as they are.
struct Loaded {
    ymls: BTreeMap<String, String>,
    files: BTreeMap<String, String>,
    spec: String,
}

async fn load(state: &AppState, d: &Draft) -> Result<Loaded, String> {
    let ymls = state.draft_ymls(gestalts_fs::FsStorage::new(state.draft_dir(&d.id))).await.map_err(|e| format!("{e:?}"))?;
    let (files, spec) = state.worker.files_of(&ymls, &d.id).await?;
    Ok(Loaded { ymls, files, spec })
}

/// Writes what a tool changed, as the workshop saves a turn: all of it, or none and why.
async fn commit(state: &AppState, account: &Account, d: &Draft, loaded: &Loaded, changed: &BTreeMap<String, Option<String>>) -> Result<(), Vec<String>> {
    let applied = state.worker.apply_files(&loaded.ymls, &d.id, changed).await.map_err(|e| vec![e])?;
    if !applied.problems.is_empty() {
        return Err(applied.problems);
    }
    let now = now_iso();
    let mut incoming: BTreeMap<String, String> = applied.remove.iter().map(|id| (id.clone(), gestalts_core::merge::tombstone(id, &now))).collect();
    incoming.extend(applied.put);
    match state.write_ymls(account, d, gestalts_fs::FsStorage::new(state.draft_dir(&d.id)), incoming).await {
        Ok(()) => Ok(()),
        Err(ApiError::Invalid(problems)) => Err(problems),
        Err(e) => Err(vec![format!("{e:?}")]),
    }
}

/// What the preview in the workshop says, for `open_draft` and `check`.
fn preview_report(state: &AppState, draft: &str) -> String {
    let Some((errors, at)) = state.mcp.reported(draft) else {
        return "No workshop tab has this draft open, so errors the preview would show while the view runs aren't known here. Ask the person to open it in thia's workshop to see it and to report them.".into();
    };
    if state.mcp.saved_at(draft).is_some_and(|saved| saved > at) {
        return "The workshop's preview hasn't reported since the last change yet: it updates within a few seconds. Check again to see what it shows.".into();
    }
    if errors.is_empty() {
        return "The workshop's preview runs the view without errors.".into();
    }
    let mut out = String::from("The workshop's preview reports these errors. Fix them first:");
    for e in &errors {
        out.push_str(&format!("\n- {}: {}", e["kind"].as_str().unwrap_or("error"), e["message"].as_str().unwrap_or_default()));
        if let Some(stack) = e["stack"].as_str().filter(|s| !s.is_empty()) { out.push_str(&format!("\n  {}", stack.replace('\n', "\n  "))); }
    }
    out
}

/// A tool call of the session's account, as its result.
pub async fn call(state: &AppState, account: &Account, s: &mut Session, sid: &str, name: &str, args: &Value) -> Value {
    match name {
        "list_drafts" => list_drafts(state, account),
        "new_draft" => new_draft(state, account, s, args).await,
        _ => on_draft(state, account, s, sid, name, args).await,
    }
}

fn list_drafts(state: &AppState, account: &Account) -> Value {
    match state.db.drafts(&account.id) {
        Ok(ds) if ds.is_empty() => text("No drafts yet: make one with new_draft."),
        Ok(ds) => text(ds.iter().map(|d| {
            let here = if KINDS.contains(&d.kind.as_str()) { String::new() } else { " — in the workshop only".into() };
            format!("- {}: “{}” ({}, made {}){here}", d.id, d.title, d.kind, &d.created[..d.created.len().min(10)])
        }).collect::<Vec<_>>().join("\n")),
        Err(e) => error(format!("The drafts couldn't be listed: {e}")),
    }
}

/// A language tag as BCP 47 writes one, roughly; else English.
fn lang_of(v: &Value) -> String {
    v.as_str().map(str::trim).filter(|l| !l.is_empty() && l.len() <= 35 && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')).unwrap_or("en").to_owned()
}

async fn new_draft(state: &AppState, account: &Account, s: &mut Session, args: &Value) -> Value {
    let title = args["title"].as_str().unwrap_or_default();
    let d = match state.create_draft(account, title, Kind::View, None) {
        Ok(d) => d,
        Err(e) => return error(format!("No draft made: {}", api_message(e))),
    };
    let made = async {
        let (id, text) = state.worker.new_view(&d.id, title.trim(), &d.package, &lang_of(&args["lang"])).await.map_err(ApiError::Internal)?;
        state.write_ymls(account, &d, gestalts_fs::FsStorage::new(state.draft_dir(&d.id)), BTreeMap::from([(id, text)])).await
    }.await;
    if let Err(e) = made {
        return error(format!("The draft {} was made, but its view couldn't be written: {}", d.id, api_message(e)));
    }
    s.created.insert(d.id.clone());
    text(format!("Made the draft {} (“{}”). Call open_draft with it and the person's request.", d.id, d.title))
}

fn api_message(e: ApiError) -> String {
    match e {
        ApiError::BadRequest(m) | ApiError::TooLarge(m) | ApiError::TooMany(m) | ApiError::Conflict(m) => m,
        ApiError::Invalid(p) => p.join("; "),
        ApiError::NotFound => "not found".into(),
        other => format!("{other:?}"),
    }
}

/// Makes sure the session is on a run of this draft: `open_draft` starts one for its request; any other call goes on
/// with the one it's on, or starts one without a request (the host didn't open the draft first).
async fn run_for(state: &AppState, account: &Account, s: &mut Session, sid: &str, d: &Draft, loaded: &Loaded, request: Option<&str>) -> Result<(), String> {
    let same = s.run.as_ref().is_some_and(|o| o.draft == d.id);
    if same && request.is_none() {
        return Ok(());
    }
    end_run(state, s, if same { "next" } else { "other-draft" }).await;
    let kind = state.agents.reference.kind(&d.kind).ok_or("not a kind of draft for this")?;
    let mut inputs = json!({ "files": loaded.files, "system": kind.system(&MCP).unwrap_or_default() });
    if !loaded.spec.trim().is_empty() { inputs["spec"] = json!(loaded.spec); }
    let client = &s.client;
    let diagnostics = state.mcp.reported(&d.id).map(|(e, _)| e).unwrap_or_default();
    let start = json!({
        "purpose": "turn", "draft": d.id, "kind": d.kind,
        "backend": { "id": MCP.id, "label": client["name"] },
        "message": request, "session": sid, "implicit": request.is_none(), "newDraft": s.created.contains(&d.id),
        "diagnostics": diagnostics, "gestalts": known_gestalts(state, account), "inputs": inputs,
        "client": client, "provenance": { "provider": { "name": client["name"], "version": client["version"] } },
    });
    let run = ServerRun::start(state, &account.id, start).await?;
    s.run = Some(Open { run, draft: d.id.clone(), last: Instant::now() });
    Ok(())
}

async fn record(state: &AppState, s: &mut Session, e: Value) {
    if let Some(open) = s.run.as_mut() {
        open.last = Instant::now();
        if let Err(err) = open.run.add(state, e).await { eprintln!("mcp: recording run {}: {err}", open.run.id); }
    }
}

async fn on_draft(state: &AppState, account: &Account, s: &mut Session, sid: &str, name: &str, args: &Value) -> Value {
    let id = args["draft"].as_str().unwrap_or_default();
    let d = match state.draft_of(account, id) {
        Ok((d, _)) => d,
        Err(_) => return error(format!("No draft “{id}” of the person's: list_drafts names them.")),
    };
    if !KINDS.contains(&d.kind.as_str()) {
        return error(format!("“{}” is a {} draft: only views can be worked on from here for now. The person can work on it in thia's workshop.", d.title, d.kind));
    }
    let Some(kind) = state.agents.reference.kind(&d.kind) else { return error("not a kind of draft for this") };
    let loaded = match load(state, &d).await {
        Ok(l) => l,
        Err(e) => return error(format!("The draft couldn't be read: {e}")),
    };
    let request = (name == "open_draft").then(|| args["request"].as_str().unwrap_or_default().trim()).filter(|r| !r.is_empty());
    if let Err(e) = run_for(state, account, s, sid, &d, &loaded, request).await {
        eprintln!("mcp: starting a run on {}: {e}", d.id);
    }
    state.mcp.touch(&d.id, false);
    match name {
        "open_draft" => {
            let mut out = String::new();
            if args["have_contract"] != true {
                match kind.system(&MCP) {
                    Ok(system) => out.push_str(&format!("{system}\n\n---\n\n")),
                    Err(e) => return error(format!("The contract couldn't be read: {e}")),
                }
            }
            out.push_str(&format!("The draft {} (“{}”). Its files: {}.", d.id, d.title, loaded.files.keys().cloned().collect::<Vec<_>>().join(", ")));
            out.push_str(&if loaded.spec.trim().is_empty() { "\n\nNo brief yet: set one with set_brief once you know what they want.".to_owned() } else { format!("\n\nIts brief (SPEC.md):\n\n{}", loaded.spec.trim()) });
            out.push_str(&format!("\n\n{}", preview_report(state, &d.id)));
            text(out)
        }
        "finish" => {
            let note = args["note"].as_str().unwrap_or_default().trim().to_owned();
            if !note.is_empty() { record(state, s, json!({ "type": "text", "text": note })).await; }
            end_run(state, s, "finish").await;
            text("Done: the person sees it in thia's workshop, and can rate how it went there.")
        }
        _ => {
            record(state, s, json!({ "type": "tool", "name": name, "summary": summary(name, args) })).await;
            let t0 = Instant::now();
            let result = drafting_tool(state, account, s, &d, kind, &loaded, name, args).await;
            let ok = result["isError"] != true;
            record(state, s, json!({ "type": "tool_result", "name": name, "ok": ok, "ms": t0.elapsed().as_millis() as u64, "content": result["content"] })).await;
            result
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn drafting_tool(state: &AppState, account: &Account, s: &mut Session, d: &Draft, kind: &crate::drafting::KindRef, loaded: &Loaded, name: &str, args: &Value) -> Value {
    match name {
        "check" => {
            let known = known_gestalts(state, account);
            match state.worker.check(&loaded.files, &known).await {
                Ok((ok, output)) => {
                    let body = format!("{}\n{}", output.trim_end(), preview_report(state, &d.id));
                    if ok { text(body) } else { error(body) }
                }
                Err(e) => error(format!("the check couldn't run: {e}")),
            }
        }
        "set_brief" => {
            let brief = args["brief"].as_str().unwrap_or_default();
            if brief.len() > 20_000 { return error("A brief of at most 20000 characters."); }
            let written = async {
                let (id, t) = state.worker.set_spec(&loaded.ymls, &d.id, brief).await.map_err(ApiError::Internal)?;
                state.write_ymls(account, d, gestalts_fs::FsStorage::new(state.draft_dir(&d.id)), BTreeMap::from([(id, t)])).await
            }.await;
            match written {
                Ok(()) => {
                    state.mcp.touch(&d.id, true);
                    record(state, s, json!({ "type": "spec", "spec": brief })).await;
                    text("The brief is saved.")
                }
                Err(e) => error(format!("The brief wasn't saved: {}", api_message(e))),
            }
        }
        _ => {
            let known = known_gestalts(state, account);
            let mut extra = BTreeMap::new();
            if !loaded.spec.trim().is_empty() { extra.insert("SPEC.md".to_owned(), format!("{}\n", loaded.spec.trim())); }
            let mut ws = Workspace { files: loaded.files.clone(), extra, gestalts: &known, kind };
            let said = match ws.run(name, args) {
                Ok(t) => t,
                Err(t) => return error(t),
            };
            let changed = ws.changed_since(&loaded.files);
            if changed.is_empty() {
                return text(said);
            }
            match commit(state, account, d, loaded, &changed).await {
                Ok(()) => {
                    state.mcp.touch(&d.id, true);
                    record(state, s, json!({ "type": "files", "files": changed })).await;
                    text(format!("{said}; saved"))
                }
                Err(problems) => {
                    record(state, s, json!({ "type": "saved", "problems": problems })).await;
                    error(format!("Not saved: nothing of this change was written, because:\n- {}", problems.join("\n- ")))
                }
            }
        }
    }
}
