//! The record of agent runs: what the page sends, kept once each, read back by admins, and the index rebuilt from it.

mod common;

use axum::http::StatusCode;
use common::Server;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use thia_server::Limits;

const RUN: &str = "0123456789abcdef0123456789abcdef";

fn ev(seq: i64, ty: &str, extra: Value) -> Value {
    let mut e = json!({ "v": 1, "run": RUN, "seq": seq, "at": format!("2026-11-23T10:00:{:02}Z", seq), "ms": seq * 100, "type": ty });
    e.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    e
}

async fn draft(s: &Server, cookie: &str) -> String {
    let (_, d, _) = s.call("POST", "/api/drafts", Some(cookie), Some(json!({ "title": "A view" }))).await;
    d["id"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn a_run_is_kept_once_and_read_back_by_admins() {
    let s = Server::new(Limits::default());
    let ada = s.login("ada@school.example").await;
    let d = draft(&s, &ada).await;
    let path = format!("/api/runs/{RUN}/events");
    let first = json!([
        ev(0, "start", json!({ "purpose": "turn", "draft": d, "kind": "view", "backend": { "id": "cli", "label": "Claude" } })),
        ev(1, "usage", json!({ "model": "claude-opus-5-5", "input": 1000, "output": 100, "billing": "subscription" })),
        ev(2, "text", json!({ "text": "on it" })),
    ]);
    let (status, body, _) = s.call("POST", &path, Some(&ada), Some(first.clone())).await;
    assert_eq!((status, body["accepted"].as_i64()), (StatusCode::OK, Some(3)));
    // sent again (a retry): nothing new; later events out of order are kept
    assert_eq!(s.call("POST", &path, Some(&ada), Some(first)).await.1["accepted"], 0);
    let later = json!([ev(5, "rating", json!({ "score": 4, "comment": "close" })), ev(4, "end", json!({ "outcome": "completed" })), ev(3, "some-future-event", json!({ "x": 1 }))]);
    assert_eq!(s.call("POST", &path, Some(&ada), Some(later)).await.1["accepted"], 3);

    // only the page's own events, only of this run, only by its owner
    let forged = json!([ev(6, "note", json!({ "text": "mine" }))]);
    assert_eq!(s.call("POST", &path, Some(&ada), Some(forged)).await.0, StatusCode::BAD_REQUEST);
    let bea = s.login("bea@school.example").await;
    assert_eq!(s.call("POST", &path, Some(&bea), Some(json!([ev(7, "text", json!({}))]))).await.0, StatusCode::NOT_FOUND);
    assert_eq!(s.call("GET", "/api/admin/runs", Some(&ada), None).await.0, StatusCode::FORBIDDEN);

    let (_, list, _) = s.call("GET", "/api/admin/runs?backend=cli", Some(&bea), None).await;
    let row = &list["runs"][0];
    assert_eq!((row["id"].as_str(), row["outcome"].as_str(), row["rating"].as_i64(), row["comment"].as_str()), (Some(RUN), Some("completed"), Some(4), Some("close")));
    assert_eq!((row["input"].as_i64(), row["firstOutputMs"].as_i64(), row["costUsd"].as_f64()), (Some(1000), Some(200), Some(0.006)));
    assert_eq!(s.call("GET", "/api/admin/runs?backend=server", Some(&bea), None).await.1["runs"].as_array().unwrap().len(), 0);

    let (_, sum, _) = s.call("GET", "/api/admin/runs/summary?by=model", Some(&bea), None).await;
    assert_eq!((sum["groups"][0]["key"].as_str(), sum["groups"][0]["ratingMean"].as_f64()), (Some("claude-opus-5-5"), Some(4.0)));

    assert_eq!(s.call("POST", &format!("/api/admin/runs/{RUN}/notes"), Some(&bea), Some(json!({ "text": "missed the brief" }))).await.0, StatusCode::NO_CONTENT);
    let (_, detail, _) = s.call("GET", &format!("/api/admin/runs/{RUN}"), Some(&bea), None).await;
    let types: Vec<&str> = detail["events"].as_array().unwrap().iter().map(|e| e["type"].as_str().unwrap()).collect();
    assert_eq!(types, ["start", "usage", "text", "some-future-event", "end", "rating", "owner", "note"]);
    assert_eq!(detail["run"]["notes"], 1);

    // the index is derived: made anew from the records, it's the same
    let before = s.call("GET", "/api/admin/runs", Some(&bea), None).await.1;
    let n = s.state.db.with(|c| Ok(s.state.runs.reindex(c))).unwrap().unwrap();
    assert_eq!(n, 1);
    assert_eq!(s.call("GET", "/api/admin/runs", Some(&bea), None).await.1, before);
}

#[tokio::test]
async fn blobs_are_kept_by_their_hash() {
    let s = Server::new(Limits::default());
    let ada = s.login("ada@school.example").await;
    let bytes = b"export default function View() {}".to_vec();
    let sha: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
    let (_, missing, _) = s.call("POST", "/api/runs/blobs/missing", Some(&ada), Some(json!([sha, "not-a-sha"]))).await;
    assert_eq!(missing, json!([sha]));
    assert_eq!(s.bytes("PUT", &format!("/api/runs/blobs/{}", "0".repeat(64)), &ada, bytes.clone()).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(s.bytes("PUT", &format!("/api/runs/blobs/{sha}"), &ada, bytes.clone()).await.0, StatusCode::NO_CONTENT);
    assert_eq!(s.call("POST", "/api/runs/blobs/missing", Some(&ada), Some(json!([sha]))).await.1, json!([]));
    let bea = s.login("bea@school.example").await;
    assert_eq!(s.bytes("GET", &format!("/api/admin/runs/blobs/{sha}"), &bea, vec![]).await.2, bytes);
    assert_eq!(s.bytes("GET", &format!("/api/admin/runs/blobs/{sha}"), &ada, vec![]).await.0, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_run_on_someone_elses_draft_is_refused() {
    let s = Server::new(Limits::default());
    let ada = s.login("ada@school.example").await;
    let d = draft(&s, &ada).await;
    let bea = s.login("bea@school.example").await;
    let start = json!([ev(0, "start", json!({ "draft": d }))]);
    assert_eq!(s.call("POST", &format!("/api/runs/{RUN}/events"), Some(&bea), Some(start)).await.0, StatusCode::FORBIDDEN);
}
