//! Submitting workshop results for the public site, reviewing them, and accepting them into a checkout.

mod common;

use axum::http::StatusCode;
use common::Server;
use thia_server::Limits;
use serde_json::{Value, json};

const VIEW: &str = "import { t } from '@gestalts/view';\nexport default function View() { return <div className=\"h-full\">{t('hi')}</div>; }\n";
/** its text, in German */
const WORDING: &str = "id: wording\ngestalt: wording@1\nlang: de\nlayer: source\nmessages:\n  hi: { text: Hallo, description: the greeting }\n";

/// An account's draft with its own gestalt and one yml of it; its id and the cookie of its owner.
async fn draft(s: &Server, email: &str, title: &str) -> (String, String, String) {
    let cookie = s.login(email).await;
    let (_, d, _) = s.call("POST", "/api/drafts", Some(&cookie), Some(json!({ "title": title }))).await;
    let (id, p) = (d["id"].as_str().unwrap().to_owned(), d["package"].as_str().unwrap().to_owned());
    let view = format!("id: {id}\ngestalt: view@4\ntitle: {title}\nsource: {VIEW:?}\nreads: [{p}/noun@1, practice-event@1]\nwrites: [practice-event@1]\npackage: {p}\nmembers: [gestalt-{p}.noun.1, haus, wording]\nlang: de\n");
    let noun = format!("id: gestalt-{p}.noun.1\ngestalt: gestalt@1\nname: {p}/noun\nversion: 1\nfields:\n  word: {{ type: string, required: true }}\n");
    let w = json!([{ "id": id, "text": view }, { "id": format!("gestalt-{p}.noun.1"), "text": noun }, { "id": "haus", "text": format!("id: haus\ngestalt: {p}/noun@1\nword: Haus\n") }, { "id": "wording", "text": WORDING }, { "id": "tried", "text": "id: tried\ngestalt: note@1\n" }]);
    assert_eq!(s.call("POST", &format!("/api/drafts/{id}/sync/write"), Some(&cookie), Some(w)).await.0, StatusCode::NO_CONTENT);
    (id, p, cookie)
}

async fn submit(s: &Server, draft: &str, cookie: &str) -> (StatusCode, Value) {
    let (status, body, _) = s.call("POST", &format!("/api/drafts/{draft}/submit"), Some(cookie), Some(json!({ "about": "Der, die, das üben.", "credit": "Ada L.", "rights": true }))).await;
    (status, body)
}

/// A checkout with what accepting writes into: the site's distribution and the vizint plugin.
#[tokio::test]
async fn an_accounts_draft_is_queued_as_a_snapshot_for_admins_only() {
    let s = Server::new(Limits::default());
    let (id, _, ada) = draft(&s, "ada@school.example", "Artikel").await;

    let (status, body, _) = s.call("POST", &format!("/api/drafts/{id}/submit"), Some(&ada), Some(json!({ "about": "x", "rights": false }))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (status, sub) = submit(&s, &id, &ada).await;
    assert_eq!(status, StatusCode::CREATED, "{sub}");
    assert_eq!((sub["kind"].as_str(), sub["status"].as_str(), sub["source"].clone()), (Some("view"), Some("pending"), json!(format!("workshop:{id}"))));
    let sid = sub["id"].as_str().unwrap();

    // the sender sees their own
    let (_, mine, _) = s.call("GET", &format!("/api/submissions?source=workshop:{id}"), Some(&ada), None).await;
    assert_eq!(mine.as_array().unwrap().len(), 1);

    let bea = s.login("bea@school.example").await;
    assert_eq!(s.call("GET", "/api/admin/submissions", Some(&bea), None).await.0, StatusCode::NOT_FOUND);
    let index = std::fs::read_to_string(s.state.submission_dir(sid).join("index.json")).unwrap();
    let index: Value = serde_json::from_str(&index).unwrap();
    let ids = index["ymls"].as_array().unwrap();
    assert_eq!(ids.len(), 4);
    assert!(ids.contains(&json!("haus")) && !ids.contains(&json!("tried")));
}
