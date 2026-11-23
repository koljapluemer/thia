//! The bridge end to end, with a fake Ollama that answers `/api/chat` from a script: a write outside the draft
//! (refused), a write in it, the page's `check`, then a last word. start → tool_call → tool_result → files → done.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::{Json, Router, extract::State, routing::{get, post}};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};

type Seen = Arc<Mutex<Vec<Value>>>;

/// Answers each chat by how many tool results it holds so far; keeps every request.
async fn chat(State(seen): State<Seen>, Json(req): Json<Value>) -> Json<Value> {
    seen.lock().unwrap().push(req.clone());
    let results = req["messages"].as_array().unwrap().iter().filter(|m| m["role"] == "tool").count();
    let call = |name: &str, args: Value| json!({ "role": "assistant", "content": "", "tool_calls": [{ "function": { "name": name, "arguments": args } }] });
    let message = match results {
        0 => call("write_file", json!({ "path": "CLAUDE.md", "content": "mine" })),
        1 => call("write_file", json!({ "path": "view.tsx", "content": "new" })),
        2 => call("check", json!({ "strict": true })),
        _ => json!({ "role": "assistant", "content": "Done: view.tsx is new." }),
    };
    Json(json!({ "model": req["model"], "message": message, "done": true }))
}

struct Bridge {
    child: std::process::Child,
    port: u16,
    seen: Seen,
    _dir: tempfile::TempDir,
}

impl Drop for Bridge {
    fn drop(&mut self) { let _ = self.child.kill(); }
}

fn free_port() -> u16 { std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port() }

async fn bridge() -> Bridge {
    let seen: Seen = Arc::default();
    let fake = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let host = format!("http://{}", fake.local_addr().unwrap());
    let app = Router::new()
        .route("/api/chat", post(chat))
        .route("/api/tags", get(|| async { Json(json!({ "models": [{ "name": "fake:1b" }] })) }))
        .with_state(seen.clone());
    tokio::spawn(async move { axum::serve(fake, app).await.unwrap() });
    let dir = tempfile::tempdir().unwrap();
    let port = free_port();
    let child = std::process::Command::new(env!("CARGO_BIN_EXE_gestalts-ollama-bridge"))
        .args(["serve", "--dev", "--port", &port.to_string(), "--profile", "test"])
        .env("GESTALTS_OLLAMA_HOST", &host).env("GESTALTS_OLLAMA_MODEL", "fake:1b")
        .env("XDG_CONFIG_HOME", dir.path().join("config")).env("HOME", dir.path()).stdout(std::process::Stdio::null()).spawn().unwrap();
    let b = Bridge { child, port, seen, _dir: dir };
    for _ in 0..100 {
        if reqwest::get(format!("http://127.0.0.1:{port}/status")).await.is_ok() { return b; }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("the bridge didn't start");
}

async fn connect(port: u16, origin: &str) -> Result<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, String> {
    let mut req = format!("ws://127.0.0.1:{port}/runs").into_client_request().unwrap();
    req.headers_mut().insert("Origin", origin.parse().unwrap());
    tokio_tungstenite::connect_async(req).await.map(|(ws, _)| ws).map_err(|e| e.to_string())
}

#[tokio::test]
async fn a_turn_with_a_tool_call() {
    let b = bridge().await;
    let status: Value = reqwest::Client::new().get(format!("http://127.0.0.1:{}/status", b.port)).header("Origin", "http://localhost:5173")
        .send().await.unwrap().json().await.unwrap();
    assert_eq!(status["app"], "gestalts-ollama-bridge");
    assert_eq!(status["paired"], true);
    assert_eq!(status["ollama"], json!({ "found": true, "host": status["ollama"]["host"], "model": "fake:1b", "hasModel": true }));

    let mut ws = connect(b.port, "http://localhost:5173").await.unwrap();
    let start = json!({ "type": "start", "workspace": "d1", "prompt": "make it", "system": "be good", "keep": r"view\.tsx|data/[^/]+\.yml",
        "files": { "view.tsx": "old", "data/a.yml": "x", "CLAUDE.md": "the contract" },
        "tools": [{ "name": "check", "description": "checks", "inputSchema": { "type": "object" } }] });
    ws.send(Message::Text(start.to_string().into())).await.unwrap();
    let mut seen = vec![];
    let mut session = Value::Null;
    while let Some(Ok(msg)) = tokio::time::timeout(Duration::from_secs(20), ws.next()).await.expect("the bridge answers") {
        let Message::Text(t) = msg else { continue };
        let ev: Value = serde_json::from_str(&t).unwrap();
        seen.push(ev["type"].as_str().unwrap().to_owned());
        match ev["type"].as_str().unwrap() {
            "tool_call" => {
                assert_eq!(ev["name"], "check");
                assert_eq!(ev["input"], json!({ "strict": true }));
                // the draft as it is now: the write in, the template not part of it
                assert_eq!(ev["files"], json!({ "view.tsx": "new", "data/a.yml": "x" }));
                let reply = json!({ "type": "tool_result", "id": ev["id"], "content": [{ "type": "text", "text": "all good" }] });
                ws.send(Message::Text(reply.to_string().into())).await.unwrap();
            }
            "text" => assert_eq!(ev["text"], "Done: view.tsx is new."),
            "files" => assert_eq!(ev["files"], json!({ "view.tsx": "new" })),
            "done" => { session = ev["session"].clone(); break; }
            "error" => panic!("{ev}"),
            _ => {}
        }
    }
    // the conversation, between what's for the page's record: each answer's usage and itself, the own tools' results
    let record = ["usage", "trace", "tool_result"];
    let said: Vec<&str> = seen.iter().map(String::as_str).filter(|t| !record.contains(t)).collect();
    assert_eq!(said, ["tool", "tool", "tool", "tool_call", "text", "files", "done"]);
    assert_eq!(seen.iter().filter(|t| *t == "usage").count(), 4);
    assert_eq!(seen.iter().filter(|t| *t == "tool_result").count(), 2);
    assert!(session.is_string());

    let reqs = b.seen.lock().unwrap().clone();
    assert_eq!(reqs.len(), 4);
    let last = &reqs[3];
    assert_eq!(last["model"], "fake:1b");
    let system = last["messages"][0]["content"].as_str().unwrap();
    assert!(system.starts_with("be good") && system.ends_with("the contract"), "{system}");
    let tools: Vec<&str> = last["tools"].as_array().unwrap().iter().map(|t| t["function"]["name"].as_str().unwrap()).collect();
    assert!(tools.contains(&"read_file") && tools.contains(&"check"));
    let results: Vec<&str> = last["messages"].as_array().unwrap().iter().filter(|m| m["role"] == "tool").map(|m| m["content"].as_str().unwrap()).collect();
    assert!(results[0].starts_with("Error: CLAUDE.md: only the draft's files"), "{}", results[0]);
    assert_eq!(&results[1..], ["wrote view.tsx", "all good"]);
}

#[tokio::test]
async fn only_allowed_sites() {
    let b = bridge().await;
    assert!(connect(b.port, "https://evil.example").await.is_err());
    let status: Value = reqwest::Client::new().get(format!("http://127.0.0.1:{}/status", b.port)).header("Origin", "https://evil.example")
        .send().await.unwrap().json().await.unwrap();
    assert_eq!(status["paired"], false);
}
