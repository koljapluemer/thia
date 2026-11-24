//! Publishing a draft and opening it from its link on the lesson domain.

mod common;

use axum::http::StatusCode;
use common::Server;
use thia_server::Limits;
use serde_json::{Value, json};

const RUNTIME: &str = "0123456789abcdef";

struct Draft {
    base: String,
    id: String,
    package: String,
    cookie: String,
}

async fn draft(s: &Server) -> Draft {
    let cookie = s.login("ada@school.example").await;
    let (_, d, _) = s.call("POST", "/api/drafts", Some(&cookie), Some(json!({ "title": "der, die, das" }))).await;
    let (id, package) = (d["id"].as_str().unwrap().to_owned(), d["package"].as_str().unwrap().to_owned());
    // a player for the runtime the draft says it was made against
    let player = s.state.data.join("runtime").join(RUNTIME);
    std::fs::create_dir_all(player.join("assets")).unwrap();
    std::fs::write(player.join("index.html"), "<!doctype html><html><head><title>Lesson</title></head><body></body></html>").unwrap();
    std::fs::write(player.join("assets/index.js"), "console.log(1)").unwrap();
    Draft { base: format!("/api/drafts/{id}"), id, package, cookie }
}

impl Draft {
    async fn write(&self, s: &Server, fields: &str, view: &str) -> (StatusCode, Value) {
        let (p, id) = (&self.package, &self.id);
        let members = format!("[gestalt-{p}.noun.1, haus, wording]");
        let view = format!("id: {id}\ngestalt: view@4\ntitle: Artikel\nsource: {view:?}\nreads: [{p}/noun@1, practice-event@1]\nwrites: [practice-event@1]\npackage: {p}\nruntime: '{RUNTIME}'\nmembers: {members}\nlang: de\n");
        let noun = format!("id: gestalt-{p}.noun.1\ngestalt: gestalt@1\nname: {p}/noun\nversion: 1\nfields:\n{fields}");
        let w = json!([{ "id": id, "text": view }, { "id": format!("gestalt-{p}.noun.1"), "text": noun }, { "id": "haus", "text": format!("id: haus\ngestalt: {p}/noun@1\nword: Haus\n") }, { "id": "wording", "text": WORDING }]);
        let (status, body, _) = s.call("POST", &format!("{}/sync/write", self.base), Some(&self.cookie), Some(w)).await;
        (status, body)
    }

    async fn publish(&self, s: &Server) -> (StatusCode, Value) {
        let (status, body, _) = s.call("POST", &format!("{}/publish", self.base), Some(&self.cookie), Some(json!({ "runtime": RUNTIME }))).await;
        (status, body)
    }
}

const WORD: &str = "  word: { type: string, required: true }\n";
const VIEW: &str = "import { t } from '@gestalts/view';\nexport default function View() { return <div className=\"h-full\">{t('hi')}</div>; }\n";
/** a view without text of its own, so without a wording */
const PLAIN: &str = "export default function View() { return <div className=\"h-full\" />; }\n";
/** its text, in German: shipped beside the manifest, not among its ymls */
const WORDING: &str = "id: wording\ngestalt: wording@1\nlang: de\nlayer: source\nmessages:\n  hi: { text: Hallo, description: the greeting }\n";

#[tokio::test]
async fn a_published_lesson_opens_from_its_link_until_it_is_switched_off() {
    let s = Server::new(Limits::default());
    let d = draft(&s).await;
    assert_eq!(d.write(&s, WORD, VIEW).await.0, StatusCode::NO_CONTENT);
    let (status, p) = d.publish(&s).await;
    assert_eq!(status, StatusCode::OK, "{p}");
    let lesson = p["id"].as_str().unwrap().to_owned();
    assert_eq!(lesson.len(), 22);
    assert_eq!(p["url"], format!("https://lessons.example/l/{lesson}"));

    // the link: the player for its runtime, with a <base> there, private and not indexed
    let (status, h, page) = s.lessons(&format!("/l/{lesson}")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(String::from_utf8(page).unwrap().contains(&format!("<base href=\"/runtime/{RUNTIME}/\">")));
    assert_eq!(h["x-robots-tag"], "noindex, nofollow");
    assert_eq!(h["referrer-policy"], "no-referrer");
    assert!(h["content-security-policy"].to_str().unwrap().contains("frame-ancestors 'none'"));
    assert_eq!(s.lessons(&format!("/runtime/{RUNTIME}/assets/index.js")).await.0, StatusCode::OK);

    // its current version: a deck of its ymls and a compiled view
    let (_, _, current) = s.lessons(&format!("/l/{lesson}/current")).await;
    let path = serde_json::from_slice::<Value>(&current).unwrap()["manifest"].as_str().unwrap().to_owned();
    let (status, h, manifest) = s.lessons(&path).await;
    assert_eq!((status, h["access-control-allow-origin"].to_str().unwrap()), (StatusCode::OK, "*"));
    let manifest: Value = serde_json::from_slice(&manifest).unwrap();
    assert_eq!((manifest["format"].as_str(), manifest["runtime"].as_str(), manifest["title"].as_str()), (Some("lesson@1"), Some(RUNTIME), Some("Artikel")));
    let base = path.trim_end_matches("manifest.json");
    let (_, _, js) = s.lessons(&format!("{base}{}", manifest["view"].as_str().unwrap())).await;
    assert!(String::from_utf8(js).unwrap().contains("'hi'"));
    // in its language, its text beside it
    assert_eq!(manifest["lang"], "de");
    let (status, _, wording) = s.lessons(&format!("{base}{}", manifest["wording"].as_str().unwrap())).await;
    assert_eq!(status, StatusCode::OK);
    let wording: Value = serde_json::from_slice(&wording).unwrap();
    assert_eq!(wording[0]["messages"]["hi"]["text"], "Hallo");
    assert!(wording[0].get("id").is_none() && wording[0]["layer"] == "source");
    let (_, _, ymls) = s.lessons(&format!("{base}ymls.json")).await;
    let ids: Vec<String> = serde_json::from_slice::<Vec<Value>>(&ymls).unwrap().iter().map(|y| y["id"].as_str().unwrap().to_owned()).collect();
    assert_eq!(ids, [format!("gestalt-{}.noun.1", d.package), "haus".to_owned()], "members only, never the view");
    assert_eq!(s.lessons(&format!("{base}index.json")).await.0, StatusCode::OK);

    // the same draft again is the same version
    assert_eq!(d.publish(&s).await.1["manifest"], json!(path));

    // switched off
    assert_eq!(s.call("DELETE", &format!("{}/publication", d.base), Some(&d.cookie), None).await.0, StatusCode::NO_CONTENT);
    assert_eq!(s.lessons(&format!("/l/{lesson}/current")).await.0, StatusCode::GONE);
    assert_eq!(s.lessons(&format!("/l/{lesson}")).await.0, StatusCode::GONE);
    // publishing again switches it back on, at the same link
    let (_, again) = d.publish(&s).await;
    assert_eq!((again["id"].as_str(), again["revoked"].clone()), (Some(lesson.as_str()), Value::Null));
    assert_eq!(s.lessons(&format!("/l/{lesson}/current")).await.0, StatusCode::OK);
}

#[tokio::test]
async fn what_may_not_go_out() {
    let s = Server::new(Limits::default());
    let d = draft(&s).await;
    d.write(&s, WORD, VIEW).await;
    assert_eq!(d.publish(&s).await.0, StatusCode::OK);

    // a published gestalt keeps its structure
    assert_eq!(d.write(&s, &format!("{WORD}  gender: {{ type: string }}\n"), VIEW).await.0, StatusCode::NO_CONTENT);
    let (status, body) = d.publish(&s).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(body["problems"][0].as_str().unwrap().contains("noun@2"), "{body}");

    // a view that doesn't compile
    d.write(&s, WORD, "export default function View( {").await;
    assert_eq!(d.publish(&s).await.0, StatusCode::UNPROCESSABLE_ENTITY);

    // an npm import without a pinned version
    d.write(&s, WORD, "import confetti from 'canvas-confetti';\nexport default function View() { return <p>{String(confetti)}</p>; }\n").await;
    let (status, body) = d.publish(&s).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(body.to_string().contains("exact version"), "{body}");

    // an import with its version in it: said where the version goes
    d.write(&s, WORD, "import katex from 'katex@0.16.11';\nexport default function View() { return <p>{String(katex)}</p>; }\n").await;
    let (status, body) = d.publish(&s).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(body.to_string().contains(r#"import from 'katex', not 'katex@0.16.11'"#), "{body}");

    // a page whose runtime has no player here (an old one, or the site updated before its player was installed)
    for body in [None, Some(json!({ "runtime": "fedcba9876543210" })), Some(json!({ "runtime": "../../x" }))] {
        let (status, body, _) = s.call("POST", &format!("{}/publish", d.base), Some(&d.cookie), body).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(body["error"].as_str().unwrap().starts_with("This site was just updated"), "said plainly: {body}");
    }

    // guessed links are 404s, and many of them slow down
    for _ in 0..130 {
        s.lessons("/l/AAAAAAAAAAAAAAAAAAAAAA/current").await;
    }
    assert_eq!(s.lessons("/l/AAAAAAAAAAAAAAAAAAAAAA/current").await.0, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(s.lessons("/lessons/../thia.db").await.0, StatusCode::NOT_FOUND);
}

/// A player installed from a prerendered site: the link answers with its bare `player.html`, not the catalog its
/// `index.html` is now; none of the site's pages is served as a file.
#[tokio::test]
async fn a_lesson_link_answers_with_the_bare_player_page() {
    let s = Server::new(Limits::default());
    let d = draft(&s).await;
    let player = s.state.data.join("runtime").join(RUNTIME);
    std::fs::write(player.join("index.html"), "<!doctype html><html><head><title>Everything</title></head><body><div id=\"app\"><main>catalog</main></div></body></html>").unwrap();
    std::fs::write(player.join("player.html"), "<!doctype html><html><head><title>Player</title></head><body><div id=\"app\"></div></body></html>").unwrap();
    assert_eq!(d.write(&s, WORD, VIEW).await.0, StatusCode::NO_CONTENT);
    let (status, p) = d.publish(&s).await;
    assert_eq!(status, StatusCode::OK, "{p}");
    let lesson = p["id"].as_str().unwrap().to_owned();

    let (status, _, page) = s.lessons(&format!("/l/{lesson}")).await;
    let page = String::from_utf8(page).unwrap();
    assert_eq!(status, StatusCode::OK);
    assert!(page.contains("<title>Player</title>") && page.contains(&format!("<base href=\"/runtime/{RUNTIME}/\">")), "{page}");
    for page in ["player.html", "index.html", "404.html", "v/flags-practice/flags/index.html"] {
        assert_eq!(s.lessons(&format!("/runtime/{RUNTIME}/{page}")).await.0, StatusCode::NOT_FOUND, "{page}");
    }
}

#[tokio::test]
async fn a_maintainers_draft_goes_out_only_within_the_lessons_models() {
    let s = Server::new(Limits::default());
    // the player for its runtime is here
    draft(&s).await;
    let cal = s.login("cal@school.example").await;
    let (_, c, _) = s.call("POST", "/api/drafts", Some(&cal), Some(json!({ "title": "Video" }))).await;
    let (id, p) = (c["id"].as_str().unwrap(), c["package"].as_str().unwrap());
    let view = format!("id: {id}\ngestalt: view@2\ntitle: Video\nsource: {PLAIN:?}\nreads: [media-source@1]\nwrites: []\npackage: {p}\nruntime: '{RUNTIME}'\nmembers: [m]\n");
    let media = "id: m\ngestalt: media-source@1\nprovider: youtube\nexternal_id: abc\nlanguage: it\n";
    let w = json!([{ "id": id, "text": view }, { "id": "m", "text": media }]);
    assert_eq!(s.call("POST", &format!("/api/drafts/{id}/sync/write"), Some(&cal), Some(w)).await.0, StatusCode::NO_CONTENT, "the repo's models, in a maintainer's draft");
    let (status, body, _) = s.call("POST", &format!("/api/drafts/{id}/publish"), Some(&cal), Some(json!({ "runtime": RUNTIME }))).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert!(body.to_string().contains("media-source@1"), "{body}");
}
