//! A chat host working on a draft over MCP, as claude.ai does: it registers, the person allows it in the workshop,
//! it trades the code for tokens, and calls the tools. Each request is a run in the record, as any backend's.

mod common;

use axum::http::{HeaderMap, StatusCode};
use base64::Engine as _;
use common::Server;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use thia_server::Limits;

const REDIRECT: &str = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER: &str = "a-verifier-of-at-least-forty-three-characters-0123456789";
// no text of its own: the check refuses text written into a view (it goes in its wording)
const VIEW: &str = "export default function View() {\n  return <div className=\"h-full\" />;\n}\n";

fn query_of(location: &str) -> std::collections::HashMap<String, String> {
    let q = location.split_once('?').map_or("", |(_, q)| q);
    q.split('&').filter_map(|kv| kv.split_once('=')).map(|(k, v)| (k.to_owned(), v.replace("%2B", "+").replace("%2F", "/").replace("%3D", "="))).collect()
}

fn form(pairs: &[(&str, &str)]) -> String {
    pairs.iter().map(|(k, v)| format!("{k}={}", v.replace('+', "%2B").replace('/', "%2F").replace('=', "%3D"))).collect::<Vec<_>>().join("&")
}

/// Registers a client and signs `email` in through it: the client's id and the token response.
async fn connect(s: &Server, email: &str) -> (String, Value) {
    let (status, _, reg) = s.raw("POST", "/oauth/register", &[], Some(("application/json", json!({ "client_name": "Claude", "redirect_uris": [REDIRECT], "token_endpoint_auth_method": "none" }).to_string()))).await;
    assert_eq!(status, StatusCode::CREATED, "{reg}");
    let client = reg["client_id"].as_str().unwrap().to_owned();
    assert!(reg.get("client_secret").is_none());

    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(VERIFIER.as_bytes()));
    let auth = format!("/oauth/authorize?response_type=code&client_id={client}&redirect_uri={}&code_challenge={challenge}&code_challenge_method=S256&state=xyz&scope=drafts", REDIRECT.replace(':', "%3A").replace('/', "%2F"));
    let (status, headers, _) = s.raw("GET", &auth, &[("host", "thia.example"), ("x-forwarded-proto", "https")], None).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert!(headers["location"].to_str().unwrap().starts_with("/workshop/connect?response_type=code"));

    let cookie = s.login(email).await;
    let (status, info, _) = s.call("GET", &format!("/api/oauth/client?client_id={client}&redirect_uri={}", REDIRECT.replace(':', "%3A").replace('/', "%2F")), Some(&cookie), None).await;
    assert_eq!((status, info["name"].as_str()), (StatusCode::OK, Some("Claude")));
    let req = json!({ "response_type": "code", "client_id": client, "redirect_uri": REDIRECT, "code_challenge": challenge, "code_challenge_method": "S256", "state": "xyz" });
    let (status, approved, _) = s.call("POST", "/api/oauth/approve", Some(&cookie), Some(req)).await;
    assert_eq!(status, StatusCode::OK, "{approved}");
    let redirect = approved["redirect"].as_str().unwrap();
    assert!(redirect.starts_with(REDIRECT));
    let q = query_of(redirect);
    assert_eq!(q["state"], "xyz");

    let bad = form(&[("grant_type", "authorization_code"), ("code", &q["code"]), ("redirect_uri", REDIRECT), ("client_id", &client), ("code_verifier", "not-the-verifier-not-the-verifier-not-the-verifier")]);
    // a wrong verifier spends the code
    assert_eq!(s.raw("POST", "/oauth/token", &[], Some(("application/x-www-form-urlencoded", bad))).await.0, StatusCode::BAD_REQUEST);
    let (_, approved, _) = s.call("POST", "/api/oauth/approve", Some(&cookie), Some(json!({ "response_type": "code", "client_id": client, "redirect_uri": REDIRECT, "code_challenge": challenge, "code_challenge_method": "S256" }))).await;
    let q = query_of(approved["redirect"].as_str().unwrap());
    let good = form(&[("grant_type", "authorization_code"), ("code", &q["code"]), ("redirect_uri", REDIRECT), ("client_id", &client), ("code_verifier", VERIFIER)]);
    let (status, _, tokens) = s.raw("POST", "/oauth/token", &[], Some(("application/x-www-form-urlencoded", good.clone()))).await;
    assert_eq!(status, StatusCode::OK, "{tokens}");
    assert_eq!(tokens["token_type"], "Bearer");
    // a code is used once
    assert_eq!(s.raw("POST", "/oauth/token", &[], Some(("application/x-www-form-urlencoded", good))).await.0, StatusCode::BAD_REQUEST);
    (client, tokens)
}

struct Host<'a> {
    s: &'a Server,
    token: String,
    session: String,
    next: i64,
}

impl Host<'_> {
    async fn rpc(&mut self, method: &str, params: Value) -> (StatusCode, HeaderMap, Value) {
        self.next += 1;
        let auth = format!("Bearer {}", self.token);
        let body = json!({ "jsonrpc": "2.0", "id": self.next, "method": method, "params": params }).to_string();
        let mut headers = vec![("authorization", auth.as_str()), ("accept", "application/json, text/event-stream")];
        if !self.session.is_empty() { headers.push(("mcp-session-id", self.session.as_str())); }
        self.s.raw("POST", "/mcp", &headers, Some(("application/json", body))).await
    }

    async fn tool(&mut self, name: &str, args: Value) -> (bool, String) {
        let (status, _, body) = self.rpc("tools/call", json!({ "name": name, "arguments": args })).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let r = &body["result"];
        let text: String = r["content"].as_array().unwrap().iter().filter_map(|c| c["text"].as_str()).collect::<Vec<_>>().join("\n");
        (r["isError"] != true, text)
    }
}

async fn host<'a>(s: &'a Server, token: &str) -> Host<'a> {
    let mut h = Host { s, token: token.to_owned(), session: String::new(), next: 0 };
    let (status, headers, body) = h.rpc("initialize", json!({ "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "claude-ai", "version": "0.1.0" } })).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["result"]["protocolVersion"], "2025-06-18");
    h.session = headers["mcp-session-id"].to_str().unwrap().to_owned();
    let auth = format!("Bearer {token}");
    let note = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }).to_string();
    let (status, _, _) = s.raw("POST", "/mcp", &[("authorization", &auth), ("mcp-session-id", &h.session)], Some(("application/json", note))).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    h
}

fn work_of(opened: &str) -> String {
    opened.lines().next()
        .and_then(|line| line.strip_prefix("Request id: "))
        .and_then(|id| id.strip_suffix(". Pass this as `work` to every tool call for this request, including `finish`."))
        .expect("open_draft returns its logical request id").to_owned()
}

#[tokio::test]
async fn signing_a_host_in_asks_for_a_token_where_the_metadata_says() {
    let s = Server::new(Limits::default());
    let (status, headers, _) = s.raw("POST", "/mcp", &[("host", "thia.example"), ("x-forwarded-proto", "https")], Some(("application/json", "{}".into()))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let challenge = headers["www-authenticate"].to_str().unwrap();
    assert!(challenge.contains("resource_metadata=\"https://thia.example/.well-known/oauth-protected-resource\""), "{challenge}");
    let (_, _, prm) = s.raw("GET", "/.well-known/oauth-protected-resource", &[("host", "thia.example"), ("x-forwarded-proto", "https")], None).await;
    assert_eq!((prm["resource"].as_str(), prm["authorization_servers"][0].as_str()), (Some("https://thia.example/mcp"), Some("https://thia.example")));
    let (_, headers, asm) = s.raw("GET", "/.well-known/oauth-authorization-server", &[("host", "localhost:7740")], None).await;
    assert_eq!(asm["token_endpoint"], "http://localhost:7740/oauth/token");
    assert_eq!(headers["access-control-allow-origin"], "*");
    // a redirect that isn't https (or local) isn't registered
    let (status, _, _) = s.raw("POST", "/oauth/register", &[], Some(("application/json", json!({ "redirect_uris": ["http://evil.example/cb"] }).to_string()))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (client, tokens) = connect(&s, "ada@school.example").await;
    let access = tokens["access_token"].as_str().unwrap();
    let mut h = host(&s, access).await;
    assert_eq!(h.tool("list_drafts", json!({})).await, (true, "No drafts yet: make one with new_draft.".to_owned()));

    // refreshing rotates: the old refresh token is spent
    let refresh = tokens["refresh_token"].as_str().unwrap();
    let body = form(&[("grant_type", "refresh_token"), ("refresh_token", refresh), ("client_id", &client)]);
    let (status, _, fresh) = s.raw("POST", "/oauth/token", &[], Some(("application/x-www-form-urlencoded", body.clone()))).await;
    assert_eq!(status, StatusCode::OK, "{fresh}");
    assert_eq!(s.raw("POST", "/oauth/token", &[], Some(("application/x-www-form-urlencoded", body))).await.0, StatusCode::BAD_REQUEST);

    // Settings lists it, and disconnecting it signs it out at once
    let ada = s.login("ada@school.example").await;
    let (_, list, _) = s.call("GET", "/api/oauth/connections", Some(&ada), None).await;
    assert_eq!(list[0]["name"], "Claude");
    assert_eq!(s.call("DELETE", &format!("/api/oauth/connections/{client}"), Some(&ada), None).await.0, StatusCode::NO_CONTENT);
    let mut h2 = Host { s: &s, token: fresh["access_token"].as_str().unwrap().to_owned(), session: h.session.clone(), next: 0 };
    assert_eq!(h2.rpc("tools/list", json!({})).await.0, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_host_makes_a_view_and_each_request_is_a_run() {
    let s = Server::new(Limits::default());
    let (_, tokens) = connect(&s, "ada@school.example").await;
    let mut h = host(&s, tokens["access_token"].as_str().unwrap()).await;

    let (_, _, list) = h.rpc("tools/list", json!({})).await;
    let names: Vec<&str> = list["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    for n in ["list_drafts", "new_draft", "open_draft", "write_file", "edit_file", "check", "finish"] {
        assert!(names.contains(&n), "{n}: {names:?}");
    }
    for tool in list["result"]["tools"].as_array().unwrap().iter().filter(|t| !["list_drafts", "new_draft", "open_draft"].contains(&t["name"].as_str().unwrap())) {
        assert!(tool["inputSchema"]["required"].as_array().unwrap().iter().any(|p| p == "work"), "{} needs the logical request id", tool["name"]);
    }
    assert!(!names.contains(&"ask"), "a host asks in its own conversation");

    let (ok, made) = h.tool("new_draft", json!({ "title": "Artikel", "lang": "de" })).await;
    assert!(ok, "{made}");
    let id = made.split_whitespace().nth(3).unwrap().to_owned();
    let (ok, opened) = h.tool("open_draft", json!({ "draft": id, "request": "a view that asks der, die or das" })).await;
    assert!(ok && opened.contains("view.tsx") && opened.contains("useHost"), "the contract and the files: {opened}");
    let (_, again) = h.tool("open_draft", json!({ "draft": id, "request": "and blue", "have_contract": true })).await;
    assert!(!again.contains("useHost"), "left out when the conversation has it");
    let work = work_of(&again);

    // OpenAI may create a fresh MCP transport session for every call. The work id
    // keeps all of these calls in the run opened above.
    let mut hw = host(&s, tokens["access_token"].as_str().unwrap()).await;
    let (ok, said) = hw.tool("write_file", json!({ "draft": id, "work": work, "path": "view.tsx", "content": VIEW })).await;
    assert!(ok, "{said}");
    let ada = s.login("ada@school.example").await;
    let (_, read, _) = s.call("POST", &format!("/api/drafts/{id}/sync/read"), Some(&ada), Some(json!({ "ids": [id] }))).await;
    assert!(read[0]["text"].as_str().unwrap().contains("h-full"), "saved in the draft, for the workshop's sync: {read}");

    // a write the workshop wouldn't keep isn't kept, and says why
    let mut hw = host(&s, tokens["access_token"].as_str().unwrap()).await;
    let (ok, said) = hw.tool("write_file", json!({ "draft": id, "work": work, "path": "data/haus.yml", "content": "gestalt: d-000000000000/noun@1\nword: Haus\n" })).await;
    assert!(!ok && said.contains("Not saved"), "{said}");
    let (_, hashes, _) = s.call("GET", &format!("/api/drafts/{id}/sync/hashes"), Some(&ada), None).await;
    assert!(hashes.get("haus").is_none());

    // the preview's report goes with the check
    assert_eq!(s.call("POST", &format!("/api/drafts/{id}/diagnostics"), Some(&ada), Some(json!({ "errors": [{ "kind": "runtime", "message": "x is not defined" }] }))).await.0, StatusCode::NO_CONTENT);
    let mut hc = host(&s, tokens["access_token"].as_str().unwrap()).await;
    let (_, checked) = hc.tool("check", json!({ "draft": id, "work": work })).await;
    assert!(checked.contains("x is not defined"), "{checked}");
    let mut hf = host(&s, tokens["access_token"].as_str().unwrap()).await;
    let (ok, _) = hf.tool("finish", json!({ "draft": id, "work": work, "note": "made it" })).await;
    assert!(ok);

    // someone else's draft isn't there for this host
    let (_, other) = connect(&s, "bea@school.example").await;
    let mut hb = host(&s, other["access_token"].as_str().unwrap()).await;
    let (ok, said) = hb.tool("read_file", json!({ "draft": id, "path": "view.tsx" })).await;
    assert!(!ok && said.contains("No draft"), "{said}");

    // two requests, two runs: the second with its own message, ended by finish
    let bea = s.login("bea@school.example").await;
    let (runs, rel) = s.state.db.with(|db| {
        let runs = thia_server::runs::rows(db, &Default::default(), 10, false)?;
        let rel = thia_server::runs::index::load(db, &runs[0].id)?.unwrap().1;
        Ok((runs, rel))
    }).unwrap();
    assert_eq!(runs.len(), 2);
    assert_eq!(s.call("GET", "/api/admin/runs", Some(&bea), None).await.0, StatusCode::NOT_FOUND);
    let events = s.state.runs.store.read(&rel).unwrap();
    let start = events.iter().find(|e| e["type"] == "start").unwrap().clone();
    assert_eq!((start["message"].as_str(), start["backend"]["label"].as_str(), start["newDraft"].as_bool()), (Some("and blue"), Some("claude-ai"), Some(true)));
    let transports: std::collections::HashSet<&str> = events.iter().filter_map(|e| e["transport"].as_str()).collect();
    assert!(transports.len() >= 4, "one logical run retains its several transport sessions: {transports:?}");
    assert!(start["inputs"]["files"]["view.tsx"]["$blob"].is_string(), "contents as blobs: {start}");

    // the workshop lists them, and the person rates one
    let (_, mine, _) = s.call("GET", &format!("/api/drafts/{id}/mcp"), Some(&ada), None).await;
    assert_eq!((mine["active"].as_bool(), mine["runs"][0]["message"].as_str()), (Some(true), Some("and blue")));
    let run = mine["runs"][0]["id"].as_str().unwrap();
    assert_eq!(s.call("POST", &format!("/api/runs/{run}/rating"), Some(&ada), Some(json!({ "score": 4, "comment": "close" }))).await.0, StatusCode::NO_CONTENT);
    assert_eq!(s.call("POST", &format!("/api/runs/{run}/rating"), Some(&bea), Some(json!({ "score": 1 }))).await.0, StatusCode::NOT_FOUND);
    let rated = s.state.db.with(|db| thia_server::runs::row_of(db, run)).unwrap().unwrap();
    assert_eq!(rated.rating, Some(4));

    // the transport session ends, and nothing more is recorded
    let auth = format!("Bearer {}", h.token);
    assert_eq!(s.raw("DELETE", "/mcp", &[("authorization", &auth), ("mcp-session-id", &h.session)], None).await.0, StatusCode::NO_CONTENT);
    assert_eq!(h.rpc("tools/list", json!({})).await.0, StatusCode::NOT_FOUND);
}
