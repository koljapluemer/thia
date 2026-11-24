//! A turn of the agent against a stand-in for the Messages API, which answers from a script and keeps what it was sent.

mod common;

use std::sync::{Arc, Mutex};

use common::Server;
use axum::Json;
use axum::http::{HeaderMap, StatusCode};
use thia_server::Limits;
use serde_json::{Value, json};

type Seen = Arc<Mutex<Vec<(HeaderMap, Value)>>>;

/// A Messages API that answers each request with the next of `script`.
async fn model(script: Vec<Value>) -> (String, Seen) {
    let seen: Seen = Arc::default();
    let script = Arc::new(Mutex::new(script.into_iter()));
    let s = seen.clone();
    let app = axum::Router::new().route(
        "/v1/messages",
        axum::routing::post(move |headers: HeaderMap, Json(body): Json<Value>| {
            let (seen, script) = (s.clone(), script.clone());
            async move {
                seen.lock().unwrap().push((headers, body));
                match script.lock().unwrap().next() {
                    Some(r) => (StatusCode::OK, Json(r)),
                    None => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": { "message": "script ran out" } }))),
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, seen)
}

fn reply(content: Value, stop: &str) -> Value {
    json!({ "id": "msg", "type": "message", "role": "assistant", "model": "claude-opus-5-5", "content": content, "stop_reason": stop,
            "usage": { "input_tokens": 100, "output_tokens": 50, "cache_read_input_tokens": 1000, "cache_creation_input_tokens": 0 } })
}

// no text of its own: the check refuses text written into a view (it goes in its wording)
const VIEW: &str = "export default function View() {\n  return <div className=\"h-full\" />;\n}\n";

/// What the turn said, without what's only for its record (usage, raw answers, tool results, throttles).
async fn events(s: &Server, cookie: &str, base: &str, job: &str) -> Vec<Value> {
    let record = ["usage", "trace", "tool_result", "throttle"];
    every_event(s, cookie, base, job).await.into_iter().filter(|e| !record.contains(&e["type"].as_str().unwrap_or(""))).collect()
}

async fn every_event(s: &Server, cookie: &str, base: &str, job: &str) -> Vec<Value> {
    let mut all = Vec::new();
    loop {
        let (status, page, _) = s.call("GET", &format!("{base}/agent/events?job={job}&after={}", all.len()), Some(cookie), None).await;
        assert_eq!(status, StatusCode::OK, "{page}");
        all.extend(page["events"].as_array().unwrap().iter().cloned());
        if page["done"] == true {
            return all;
        }
    }
}

#[tokio::test]
async fn a_turn_edits_the_files_checks_them_and_hands_them_back() {
    let (url, seen) = model(vec![
        reply(json!([{ "type": "text", "text": "Ich mache das." }, { "type": "tool_use", "id": "t1", "name": "write_file", "input": { "path": "view.tsx", "content": VIEW } }]), "tool_use"),
        reply(json!([{ "type": "tool_use", "id": "t2", "name": "check", "input": {} }, { "type": "tool_use", "id": "t3", "name": "write_file", "input": { "path": "../escape.ts", "content": "x" } }]), "tool_use"),
        reply(json!([{ "type": "text", "text": "Fertig." }]), "end_turn"),
        reply(json!([{ "type": "text", "text": "Noch da." }]), "end_turn"),
    ]).await;
    let s = Server::with_model(Limits::default(), Some(url));
    let ada = s.login("ada@school.example").await;
    let (_, d, _) = s.call("POST", "/api/drafts", Some(&ada), Some(json!({ "title": "Hallo" }))).await;
    let (id, package) = (d["id"].as_str().unwrap().to_owned(), d["package"].as_str().unwrap().to_owned());
    let base = format!("/api/drafts/{id}");
    assert_eq!(s.call("GET", &format!("{base}/agent/status"), Some(&ada), None).await.1["available"], true);

    let files = json!({ "view.tsx": "export default function View() { return null; }\n", "view.json": format!("{{\"title\":\"Hallo\",\"package\":\"{package}\",\"reads\":[],\"writes\":[],\"npm\":{{}}}}") });
    let turn = json!({ "view": id, "message": "Sag Hallo.", "files": files, "gestalts": ["note@1"], "diagnostics": [{ "kind": "render", "message": "boom", "at": "x" }] });
    let (status, started, _) = s.call("POST", &format!("{base}/agent/turn"), Some(&ada), Some(turn.clone())).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{started}");
    let all = events(&s, &ada, &base, started["job"].as_str().unwrap()).await;
    let kinds: Vec<&str> = all.iter().map(|e| e["type"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["text", "tool", "tool", "tool", "text", "files", "done"], "{all:?}");
    // and for the run's record: each request's usage, each tool's result
    let every = every_event(&s, &ada, &base, started["job"].as_str().unwrap()).await;
    let usage: Vec<&Value> = every.iter().filter(|e| e["type"] == "usage").collect();
    assert_eq!((usage.len(), usage[0]["model"].as_str(), usage[0]["cacheRead"].as_i64(), usage[0]["billing"].as_str()), (3, Some("claude-opus-5-5"), Some(1000), Some("api")));
    let results: Vec<(&str, bool)> = every.iter().filter(|e| e["type"] == "tool_result").map(|e| (e["name"].as_str().unwrap(), e["ok"].as_bool().unwrap())).collect();
    assert_eq!(results, [("write_file", true), ("check", true), ("write_file", false)]);
    assert_eq!(all[5]["files"], json!({ "view.tsx": VIEW }));
    let session = all[6]["session"].as_str().unwrap().to_owned();

    let sent = seen.lock().unwrap().clone();
    assert_eq!(sent.len(), 3);
    let (headers, first) = &sent[0];
    assert_eq!(headers["anthropic-version"], "2026-10-21");
    assert_eq!(headers["x-api-key"], "test-key");
    assert_eq!(first["model"], "claude-opus-5-5");
    assert_eq!(first["output_config"]["effort"], "high");
    assert_eq!(first["fallbacks"], "default");
    assert!(first.get("thinking").is_none());
    assert_eq!(first["system"][0]["cache_control"]["type"], "ephemeral");
    assert!(first["system"][0]["text"].as_str().unwrap().contains("There is no shell"));
    let opening = first["messages"][0]["content"][0]["text"].as_str().unwrap();
    assert!(opening.starts_with("Sag Hallo.") && opening.contains("boom"), "{opening}");
    // the check ran for real, and the escape was refused
    let results = &sent[2].1["messages"][4]["content"];
    assert_eq!(results[0]["is_error"], false, "{results}");
    assert!(results[0]["content"].as_str().unwrap().contains("all good"), "{results}");
    assert_eq!(results[1]["is_error"], true);

    // the next turn goes on in the same conversation, told what changed since (the browser saved the new view.tsx,
    // so nothing did)
    let mut next = turn.clone();
    next["session"] = json!(session);
    next["message"] = json!("Noch etwas.");
    next["diagnostics"] = json!([]);
    next["files"]["view.tsx"] = json!(VIEW);
    next["files"]["view.json"] = json!(files["view.json"]);
    let (status, started, _) = s.call("POST", &format!("{base}/agent/turn"), Some(&ada), Some(next)).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{started}");
    let all = events(&s, &ada, &base, started["job"].as_str().unwrap()).await;
    assert_eq!(all.iter().map(|e| e["type"].as_str().unwrap()).collect::<Vec<_>>(), ["text", "done"]);
    let fourth = seen.lock().unwrap()[3].1.clone();
    let messages = fourth["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 7, "the first turn's six, and this one");
    assert_eq!(messages[6]["content"][0]["text"], "Noch etwas.");

    // what it used counts against the month's budget
    assert!(s.state.db.tokens_since("a1", "2026-01-01T00:00:00.000Z").unwrap() > 0);
}

#[tokio::test]
async fn a_turn_needs_a_budget_left_and_waits_for_the_last_one() {
    let (url, _) = model(vec![]).await;
    let s = Server::with_model(Limits::default(), Some(url));
    let ada = s.login("ada@school.example").await;
    let (_, d, _) = s.call("POST", "/api/drafts", Some(&ada), Some(json!({ "title": "x" }))).await;
    let base = format!("/api/drafts/{}", d["id"].as_str().unwrap());
    // a1's budget is a million tokens: one turn of two million uses it up
    s.state.db.add_turn("t0", "a1", "x", &thia_server::now_iso()).unwrap();
    s.state.db.add_usage("t0", 2_000_000, 0, 0, 0).unwrap();
    let turn = json!({ "view": d["id"], "message": "hi", "files": {}, "gestalts": [] });
    assert_eq!(s.call("POST", &format!("{base}/agent/turn"), Some(&ada), Some(turn)).await.0, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(s.call("GET", &format!("{base}/agent/status"), Some(&ada), None).await.1["available"], false);
}

#[tokio::test]
async fn without_a_key_the_agent_is_off_and_says_so() {
    let s = Server::new(Limits::default());
    let ada = s.login("ada@school.example").await;
    let (_, d, _) = s.call("POST", "/api/drafts", Some(&ada), Some(json!({ "title": "x" }))).await;
    let (_, st, _) = s.call("GET", &format!("/api/drafts/{}/agent/status", d["id"].as_str().unwrap()), Some(&ada), None).await;
    assert_eq!(st["available"], false);
    assert!(st["reason"].as_str().unwrap().contains("API key"));
}

#[tokio::test]
async fn a_question_ends_the_turn_and_its_answer_starts_the_next() {
    let card = json!({ "questions": [{ "question": "Wer übt damit?", "header": "Lernende", "options": [
        { "label": "Klasse 2", "description": "Zahlen bis 20" }, { "label": "Klasse 4", "description": "Zahlen bis 1000" }] }] });
    let (url, seen) = model(vec![
        reply(json!([
            { "type": "text", "text": "Eine Frage zuerst." },
            { "type": "tool_use", "id": "q1", "name": "ask", "input": card },
            { "type": "tool_use", "id": "q2", "name": "ask", "input": card },
            { "type": "tool_use", "id": "t1", "name": "write_file", "input": { "path": "view.tsx", "content": VIEW } },
        ]), "tool_use"),
        reply(json!([{ "type": "text", "text": "Gut, für Klasse 2." }]), "end_turn"),
    ]).await;
    let s = Server::with_model(Limits::default(), Some(url));
    let ada = s.login("ada@school.example").await;
    let (_, d, _) = s.call("POST", "/api/drafts", Some(&ada), Some(json!({ "title": "Rechnen" }))).await;
    let id = d["id"].as_str().unwrap().to_owned();
    let base = format!("/api/drafts/{id}");
    let turn = json!({ "view": id, "message": "Ein Rechenspiel.", "files": { "view.tsx": "x" }, "gestalts": [] });
    let (_, started, _) = s.call("POST", &format!("{base}/agent/turn"), Some(&ada), Some(turn)).await;
    let all = events(&s, &ada, &base, started["job"].as_str().unwrap()).await;
    assert_eq!(all.iter().map(|e| e["type"].as_str().unwrap()).collect::<Vec<_>>(), ["text", "tool", "ask", "files", "done"], "{all:?}");
    assert_eq!((all[2]["id"].as_str(), all[2]["questions"][0]["header"].as_str()), (Some("q1"), Some("Lernende")));
    assert_eq!(all[4]["waiting"], true);
    let session = all[4]["session"].as_str().unwrap().to_owned();

    // the question is the draft's, kept on disk: any device sees it, also after a restart
    assert!(s.state.data.join("agent").join(format!("{id}.json")).is_file());
    let (_, status, _) = s.call("GET", &format!("{base}/agent/status"), Some(&ada), None).await;
    assert_eq!((status["ask"]["id"].as_str(), status["ask"]["session"].as_str()), (Some("q1"), Some(session.as_str())), "{status}");
    let bea = s.login("bea@school.example").await;
    assert_eq!(s.call("GET", &format!("{base}/agent/status"), Some(&bea), None).await.0, StatusCode::NOT_FOUND);

    // answered: the open call's result, with the other calls' results beside it
    let wrong = json!({ "view": id, "session": session, "message": "", "files": { "view.tsx": VIEW }, "gestalts": [], "answer": { "id": "q9", "answers": {} } });
    assert_eq!(s.call("POST", &format!("{base}/agent/turn"), Some(&ada), Some(wrong)).await.0, StatusCode::CONFLICT);
    let answer = json!({ "view": id, "session": session, "message": "", "files": { "view.tsx": VIEW }, "gestalts": [], "answer": { "id": "q1", "answers": { "Wer übt damit?": "Klasse 2" } } });
    let (status, started, _) = s.call("POST", &format!("{base}/agent/turn"), Some(&ada), Some(answer.clone())).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{started}");
    let all = events(&s, &ada, &base, started["job"].as_str().unwrap()).await;
    assert_eq!(all.iter().map(|e| e["type"].as_str().unwrap()).collect::<Vec<_>>(), ["tool", "text", "done"], "{all:?}");
    assert_eq!(all[2]["waiting"], false);
    let sent = seen.lock().unwrap()[1].1.clone();
    let last = sent["messages"].as_array().unwrap().last().unwrap()["content"].as_array().unwrap().clone();
    let by_id = |id: &str| last.iter().find(|b| b["tool_use_id"] == id).cloned().unwrap_or_else(|| panic!("{id}: {last:?}"));
    assert_eq!(by_id("q2")["is_error"], true, "one card per turn");
    assert_eq!(by_id("t1")["is_error"], false);
    assert!(by_id("q1")["content"].as_str().unwrap().contains("Wer übt damit? → Klasse 2"));
    assert_eq!(last.len(), 3, "no empty text with an answer alone: {last:?}");

    // answered once
    let (_, status, _) = s.call("GET", &format!("{base}/agent/status"), Some(&ada), None).await;
    assert!(status.get("ask").is_none(), "{status}");
    assert_eq!(s.call("POST", &format!("{base}/agent/turn"), Some(&ada), Some(answer)).await.0, StatusCode::CONFLICT);
}

#[tokio::test]
async fn one_answer_without_tools_at_low_effort_within_the_budget() {
    let (url, seen) = model(vec![reply(json!([{ "type": "text", "text": "{\"one_view\": \"a quiz\"}" }]), "end_turn")]).await;
    let s = Server::with_model(Limits::default(), Some(url));
    let ada = s.login("ada@school.example").await;
    let (_, d, _) = s.call("POST", "/api/drafts", Some(&ada), Some(json!({ "title": "Plus", "kind": "sequence" }))).await;
    let at = format!("/api/drafts/{}/agent/complete", d["id"].as_str().unwrap());
    let (status, r, _) = s.call("POST", &at, Some(&ada), Some(json!({ "system": "Plan lessons.", "prompt": "Ein Quiz." }))).await;
    assert_eq!((status, r["text"].as_str()), (StatusCode::OK, Some("{\"one_view\": \"a quiz\"}")), "{r}");
    let sent = seen.lock().unwrap()[0].1.clone();
    assert_eq!((sent["output_config"]["effort"].as_str(), sent["system"][0]["text"].as_str()), (Some("low"), Some("Plan lessons.")));
    assert!(sent.get("tools").is_none());
    assert!(s.state.db.tokens_since("a1", "2026-01-01T00:00:00.000Z").unwrap() > 0, "it counts against the budget");
    assert_eq!(s.call("POST", &at, Some(&ada), Some(json!({ "system": "", "prompt": " " }))).await.0, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn a_visualization_is_built_with_the_check_handed_to_the_page() {
    let (url, seen) = model(vec![
        reply(json!([{ "type": "tool_use", "id": "t1", "name": "read_file", "input": { "path": "SPEC.md" } }, { "type": "tool_use", "id": "t2", "name": "write_file", "input": { "path": "viz.ts", "content": "export default 1;\n" } }, { "type": "tool_use", "id": "t3", "name": "write_file", "input": { "path": "view.tsx", "content": "x" } }]), "tool_use"),
        reply(json!([{ "type": "tool_use", "id": "t4", "name": "check", "input": {} }]), "tool_use"),
        reply(json!([{ "type": "text", "text": "Fertig." }]), "end_turn"),
    ]).await;
    let s = Server::with_model(Limits::default(), Some(url));
    let ada = s.login("ada@school.example").await;
    let (_, d, _) = s.call("POST", "/api/drafts", Some(&ada), Some(json!({ "title": "Wellen", "kind": "viz" }))).await;
    let id = d["id"].as_str().unwrap().to_owned();
    let base = format!("/api/drafts/{id}");
    assert_eq!(s.call("GET", &format!("{base}/agent/status"), Some(&ada), None).await.1["available"], true, "the server's agent builds vizzes too");

    // a view's files aren't a viz's
    let wrong = json!({ "view": id, "message": "Bau.", "files": { "view.tsx": "x" } });
    assert_eq!(s.call("POST", &format!("{base}/agent/turn"), Some(&ada), Some(wrong)).await.0, StatusCode::BAD_REQUEST);

    let turn = json!({ "kind": "viz", "view": id, "message": "Bau, was SPEC.md sagt.", "spec": "# Wellen\n\nEine Welle.", "files": { "package.json": "{}" }, "binary": { "files/data.csv": "YSxiCjEsMgo=" } });
    let (status, started, _) = s.call("POST", &format!("{base}/agent/turn"), Some(&ada), Some(turn)).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{started}");
    let job = started["job"].as_str().unwrap().to_owned();
    let mut all: Vec<Value> = Vec::new();
    loop {
        let (_, page, _) = s.call("GET", &format!("{base}/agent/events?job={job}&after={}", all.len()), Some(&ada), None).await;
        for e in page["events"].as_array().unwrap() {
            if e["type"] == "tool_call" {
                // the page runs the check on the files as they are, and answers with its report and a screenshot
                assert_eq!((e["name"].as_str(), e["files"]["viz.ts"].as_str()), (Some("check"), Some("export default 1;\n")), "{e}");
                let answer = json!({ "job": job, "id": e["id"], "content": [{ "type": "text", "text": "✓ all good" }, { "type": "image", "data": "iVBORw0KGgo=", "mimeType": "image/png" }] });
                assert_eq!(s.call("POST", &format!("{base}/agent/tool_result"), Some(&ada), Some(answer.clone())).await.0, StatusCode::OK);
                assert_eq!(s.call("POST", &format!("{base}/agent/tool_result"), Some(&ada), Some(answer)).await.0, StatusCode::NOT_FOUND, "answered once");
            }
            all.push(e.clone());
        }
        if page["done"] == true {
            break;
        }
    }
    let record = ["usage", "trace", "tool_result", "throttle"];
    let kinds: Vec<&str> = all.iter().map(|e| e["type"].as_str().unwrap()).filter(|t| !record.contains(t)).collect();
    assert_eq!(kinds, ["tool", "tool", "tool", "tool", "tool_call", "text", "files", "done"], "{all:?}");
    assert_eq!(all.iter().find(|e| e["type"] == "files").unwrap()["files"], json!({ "viz.ts": "export default 1;\n" }));

    let sent = seen.lock().unwrap().clone();
    let system = sent[0].1["system"][0]["text"].as_str().unwrap();
    assert!(system.contains("You build one visualization") && system.contains("viz-sources/") && system.contains("for a teacher and their class"), "{system}");
    let tools: Vec<&str> = sent[0].1["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert!(!tools.contains(&"delete_file") && tools.contains(&"check"), "{tools:?}");
    let opening = sent[0].1["messages"][0]["content"][0]["text"].as_str().unwrap();
    assert!(opening.contains("SPEC.md, files/data.csv"), "{opening}");
    let first = &sent[1].1["messages"][2]["content"];
    assert_eq!(first[0]["content"], "# Wellen\n\nEine Welle.\n", "SPEC.md is the brief");
    assert_eq!(first[2]["is_error"], true, "a view's file can't be written in a viz");
    let checked = &sent[2].1["messages"][4]["content"][0];
    assert_eq!((checked["is_error"].as_bool(), checked["content"][1]["type"].as_str(), checked["content"][1]["source"]["media_type"].as_str()), (Some(false), Some("image"), Some("image/png")), "{checked}");
}
