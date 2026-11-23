//! Submitting workshop results for the public site, reviewing them, and accepting them into a checkout.

mod common;

use axum::http::StatusCode;
use common::Server;
use thia_server::Limits;
use serde_json::{Value, json};

const VIEW: &str = "export default function View() { return <div className=\"h-full\">Hallo</div>; }\n";

/// An account's draft with its own gestalt and one yml of it; its id and the cookie of its owner.
async fn draft(s: &Server, email: &str, title: &str) -> (String, String, String) {
    let cookie = s.login(email).await;
    let (_, d, _) = s.call("POST", "/api/drafts", Some(&cookie), Some(json!({ "title": title }))).await;
    let (id, p) = (d["id"].as_str().unwrap().to_owned(), d["package"].as_str().unwrap().to_owned());
    let view = format!("id: {id}\ngestalt: view@2\ntitle: {title}\nsource: {VIEW:?}\nreads: [{p}/noun@1, practice-event@1]\nwrites: [practice-event@1]\npackage: {p}\nmembers: [gestalt-{p}.noun.1, haus]\n");
    let noun = format!("id: gestalt-{p}.noun.1\ngestalt: gestalt@1\nname: {p}/noun\nversion: 1\nfields:\n  word: {{ type: string, required: true }}\n");
    let w = json!([{ "id": id, "text": view }, { "id": format!("gestalt-{p}.noun.1"), "text": noun }, { "id": "haus", "text": format!("id: haus\ngestalt: {p}/noun@1\nword: Haus\n") }, { "id": "tried", "text": "id: tried\ngestalt: note@1\n" }]);
    assert_eq!(s.call("POST", &format!("/api/drafts/{id}/sync/write"), Some(&cookie), Some(w)).await.0, StatusCode::NO_CONTENT);
    (id, p, cookie)
}

async fn submit(s: &Server, draft: &str, cookie: &str) -> (StatusCode, Value) {
    let (status, body, _) = s.call("POST", &format!("/api/drafts/{draft}/submit"), Some(cookie), Some(json!({ "about": "Der, die, das üben.", "credit": "Ada L.", "rights": true }))).await;
    (status, body)
}

/// A checkout with what accepting writes into: the site's distribution and the vizint plugin.
fn checkout() -> tempfile::TempDir {
    let repo = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(repo.path().join("web/site")).unwrap();
    std::fs::create_dir_all(repo.path().join("plugins/vizint")).unwrap();
    std::fs::create_dir_all(repo.path().join("gestalts")).unwrap();
    std::fs::write(repo.path().join("web/site/distribution.yml"), "id: site\n# the views\nplugins:\n  - ../../plugins/vizint\nmodels:\n  - ../../gestalts/viz\n").unwrap();
    repo
}

fn read(repo: &std::path::Path, f: &str) -> String {
    std::fs::read_to_string(repo.join(f)).unwrap_or_else(|e| panic!("{f}: {e}"))
}

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

    // only admins review
    assert_eq!(s.call("GET", "/api/admin/submissions", Some(&ada), None).await.0, StatusCode::FORBIDDEN);
    assert_eq!(s.call("GET", "/api/admin/submissions", None, None).await.0, StatusCode::UNAUTHORIZED);
    let bea = s.login("bea@school.example").await;
    let (_, me, _) = s.call("GET", "/api/me", Some(&bea), None).await;
    assert_eq!(me["admin"], true);
    let (status, queue, _) = s.call("GET", "/api/admin/submissions", Some(&bea), None).await;
    assert_eq!((status, queue["submissions"].as_array().unwrap().len(), queue["repo"].clone()), (StatusCode::OK, 1, Value::Null));
    let (_, detail, _) = s.call("GET", &format!("/api/admin/submissions/{sid}"), Some(&bea), None).await;
    let ids: Vec<&str> = detail["ymls"].as_array().unwrap().iter().map(|y| y["id"].as_str().unwrap()).collect();
    assert!(ids.contains(&"haus") && !ids.contains(&"tried"), "the view and its members only: {ids:?}");
    assert_eq!(detail["proposed"], json!({ "plugin": "artikel", "package": "artikel", "deck": "artikel" }));

    // as a deck, for the preview
    let (status, index, _) = s.call("GET", &format!("/api/admin/submissions/{sid}/deck/index.json"), Some(&bea), None).await;
    assert_eq!((status, index["ymls"].as_array().unwrap().len()), (StatusCode::OK, 3));
    assert_eq!(s.call("GET", &format!("/api/admin/submissions/{sid}/deck/ymls.json"), Some(&bea), None).await.1.as_array().unwrap().len(), 3);
    assert_eq!(s.call("GET", &format!("/api/admin/submissions/{sid}/deck/index.json"), Some(&ada), None).await.0, StatusCode::FORBIDDEN);

    // a server without a checkout only rejects
    let target = json!({ "plugin": "artikel", "package": "artikel", "deck": "artikel" });
    assert_eq!(s.call("POST", &format!("/api/admin/submissions/{sid}/accept"), Some(&bea), Some(target)).await.0, StatusCode::CONFLICT);
    assert_eq!(s.call("POST", &format!("/api/admin/submissions/{sid}/reject"), Some(&bea), Some(json!({ "note": " " }))).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(s.call("POST", &format!("/api/admin/submissions/{sid}/reject"), Some(&bea), Some(json!({ "note": "Too short." }))).await.0, StatusCode::NO_CONTENT);
    let (_, mine, _) = s.call("GET", &format!("/api/submissions?source=workshop:{id}"), Some(&ada), None).await;
    assert_eq!((mine[0]["status"].as_str(), mine[0]["note"].as_str()), (Some("rejected"), Some("Too short.")));
    assert_eq!(s.call("POST", &format!("/api/admin/submissions/{sid}/reject"), Some(&bea), Some(json!({ "note": "again" }))).await.0, StatusCode::CONFLICT);
}

#[tokio::test]
async fn an_accepted_view_becomes_a_plugin_with_its_own_package_and_deck() {
    let repo = checkout();
    let s = Server::promoting_into(repo.path());
    let (id, package, ada) = draft(&s, "ada@school.example", "Artikel").await;
    let (_, sub) = submit(&s, &id, &ada).await;
    let bea = s.login("bea@school.example").await;
    let target = json!({ "plugin": "artikel", "package": "artikel", "deck": "nomen" });
    let (status, p, _) = s.call("POST", &format!("/api/admin/submissions/{}/accept", sub["id"].as_str().unwrap()), Some(&bea), Some(target.clone())).await;
    assert_eq!(status, StatusCode::OK, "{p}");
    assert_eq!(p["at"], "plugins/artikel");

    let r = repo.path();
    assert!(read(r, "plugins/artikel/view.tsx").contains("Hallo"));
    let manifest = read(r, "plugins/artikel/plugin.yml");
    assert!(manifest.contains("id: artikel") && manifest.contains("artikel/noun@1") && !manifest.contains(&package), "{manifest}");
    let def = read(r, "gestalts/artikel/noun/v1.yml");
    assert!(def.starts_with("name: artikel/noun\nversion: 1\nfields:") && !def.contains("gestalt:") && !def.contains("id:"), "as a definition in gestalts/ reads: {def}");
    assert!(read(r, "plugins/artikel/decks/nomen/notes/haus.yml").contains("gestalt: artikel/noun@1"));
    assert!(read(r, "plugins/artikel/decks/nomen/notes/deck-artikel-nomen.yml").contains("- haus"));
    assert!(read(r, "plugins/artikel/decks/nomen/index.json").contains("haus"));
    assert!(read(r, "plugins/artikel/origin.yml").contains("credit: Ada L."));
    let site = read(r, "web/site/distribution.yml");
    assert!(site.contains("  - ../../plugins/vizint\n  - ../../plugins/artikel\n") && site.contains("  - ../../gestalts/artikel\n"), "{site}");

    // the same draft again replaces it
    let (_, again) = submit(&s, &id, &ada).await;
    let (_, detail, _) = s.call("GET", &format!("/api/admin/submissions/{}", again["id"].as_str().unwrap()), Some(&bea), None).await;
    assert_eq!(detail["proposed"], target, "where it went before");
    assert_eq!(s.call("POST", &format!("/api/admin/submissions/{}/accept", again["id"].as_str().unwrap()), Some(&bea), Some(target.clone())).await.0, StatusCode::OK);
    assert_eq!(read(r, "web/site/distribution.yml"), site, "listed once");

    // another draft may not take its place, nor its package
    let (other, _, _) = draft(&s, "ada@school.example", "Artikel zwei").await;
    let (_, sub) = submit(&s, &other, &ada).await;
    let accept = format!("/api/admin/submissions/{}/accept", sub["id"].as_str().unwrap());
    assert_eq!(s.call("POST", &accept, Some(&bea), Some(target)).await.0, StatusCode::CONFLICT);
    assert_eq!(s.call("POST", &accept, Some(&bea), Some(json!({ "plugin": "artikel-2", "package": "artikel", "deck": "x" }))).await.0, StatusCode::CONFLICT);
    assert_eq!(s.call("POST", &accept, Some(&bea), Some(json!({ "plugin": "../x", "package": "a", "deck": "x" }))).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(s.call("POST", &accept, Some(&bea), Some(json!({ "plugin": "artikel-2", "package": "artikel-2", "deck": "x" }))).await.0, StatusCode::OK);
}

#[tokio::test]
async fn a_visualization_draft_becomes_a_vizint_deck() {
    let repo = checkout();
    let s = Server::promoting_into(repo.path());
    let ada = s.login("ada@school.example").await;
    let (_, d, _) = s.call("POST", "/api/drafts", Some(&ada), Some(json!({ "title": "Wellen", "kind": "viz" }))).await;
    let id = d["id"].as_str().unwrap().to_owned();
    let html = b"<!doctype html><p>a viz</p>";
    let viz = format!("id: {id}\ngestalt: viz@1\ntitle: Wellen\nintro: Eine Welle.\nbuilt: page.html\n");
    let w = json!([{ "id": id, "text": viz }]);
    assert_eq!(s.call("POST", &format!("/api/drafts/{id}/sync/write"), Some(&ada), Some(w)).await.0, StatusCode::NO_CONTENT);

    // its page isn't there yet
    let (status, body) = submit(&s, &id, &ada).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "its file is missing: {body}");
    assert_eq!(s.bytes("PUT", &format!("/api/drafts/{id}/blobs/page.html"), &ada, html.to_vec()).await.0, StatusCode::NO_CONTENT);
    let (status, sub) = submit(&s, &id, &ada).await;
    assert_eq!((status, sub["kind"].as_str(), sub["title"].as_str(), sub["source"].clone()), (StatusCode::CREATED, Some("viz"), Some("Wellen"), json!(format!("workshop:{id}"))), "{sub}");

    let bea = s.login("bea@school.example").await;
    let accept = format!("/api/admin/submissions/{}/accept", sub["id"].as_str().unwrap());
    assert_eq!(s.call("POST", &accept, Some(&bea), Some(json!({ "deck": "examples" }))).await.0, StatusCode::CONFLICT);
    let (status, p, _) = s.call("POST", &accept, Some(&bea), Some(json!({ "deck": "wellen" }))).await;
    assert_eq!((status, p["at"].as_str()), (StatusCode::OK, Some("plugins/vizint/decks/wellen")), "{p}");

    let r = repo.path();
    let yml = read(r, &format!("plugins/vizint/decks/wellen/notes/{id}.yml"));
    let blob = yml.lines().find_map(|l| l.strip_prefix("built: ")).unwrap().to_owned();
    assert!(blob.ends_with(".html") && blob.len() == 21, "named by content: {blob}");
    assert_eq!(std::fs::read(r.join("plugins/vizint/decks/wellen/blobs").join(&blob)).unwrap(), html);
    assert!(read(r, "plugins/vizint/decks/wellen/notes/deck-vizint-wellen.yml").contains("title: Wellen"));
    assert!(read(r, "plugins/vizint/decks/wellen/origin.yml").contains("licence: CC BY-SA 4.0"));
    assert_eq!(s.call("POST", &accept, Some(&bea), Some(json!({ "deck": "wellen" }))).await.0, StatusCode::CONFLICT, "decided already");

    // drafts are submitted from the server's copy only
    assert_eq!(s.call("POST", "/api/submissions", Some(&ada), Some(json!({}))).await.0, StatusCode::METHOD_NOT_ALLOWED);
}
