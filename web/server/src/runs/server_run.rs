//! A run the server records itself, for a driver whose loop the page doesn't see (a chat host over MCP): the same
//! record as the page's (`packages/workshop/src/runs/recorder.ts`), so the index, `/runs` and `admin runs` read it
//! alike. Its events have the page's seqs, from 0, as if the server were the page; what the server writes about any
//! run (its owner, notes) keeps the negative ones.

use std::time::Instant;

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use super::index::{self, Summary};
use super::store::Store;
use crate::{AppState, now_iso};

/// a text longer than this anywhere in an event goes to a blob (the page's `LONG`)
const LONG: usize = 16 * 1024;
/// a tool result's text longer than this goes to a blob (the page's `RESULT_TEXT`)
const RESULT_TEXT: usize = 4 * 1024;

pub struct ServerRun {
    pub id: String,
    rel: String,
    t0: Instant,
    seq: i64,
    ended: bool,
}

impl ServerRun {
    /// A new run of `account`'s, with `start` as its `start` event (`type` is added).
    pub async fn start(state: &AppState, account: &str, mut start: Value) -> Result<ServerRun, String> {
        let id = crate::random_hex(16);
        let rel = Store::new_path(&id, &now_iso()[..10]);
        start["type"] = json!("start");
        let mut run = ServerRun { id, rel, t0: Instant::now(), seq: 0, ended: false };
        let owner = json!({ "v": 1, "run": run.id, "seq": -1, "type": "owner", "by": "server", "at": now_iso(), "account": account, "provenance": super::server_provenance() });
        let first = run.envelope(&state.runs.store, start)?;
        let _w = state.runs.writes.lock().await;
        let mut s = Summary { server_seq: -2, ..Summary::default() };
        s.fold(&owner);
        s.first_time(0);
        s.fold(&first);
        state.runs.store.append(&run.rel, &[owner, first]).map_err(|e| e.to_string())?;
        state.db.with(|c| index::save(c, &run.id, &run.rel, &s)).map_err(|e| e.to_string())?;
        run.seq = 1;
        Ok(run)
    }

    /// Adds an event (`{type, …}`) to the record; an `end` ends it, and nothing comes after.
    pub async fn add(&mut self, state: &AppState, event: Value) -> Result<(), String> {
        if self.ended { return Ok(()); }
        if event["type"] == "end" { self.ended = true; }
        let line = self.envelope(&state.runs.store, event)?;
        let _w = state.runs.writes.lock().await;
        let (mut s, _) = state.db.with(|c| index::load(c, &self.id)).map_err(|e| e.to_string())?.ok_or("the run isn't indexed")?;
        s.first_time(line["seq"].as_i64().unwrap_or(0));
        s.fold(&line);
        state.runs.store.append(&self.rel, &[line]).map_err(|e| e.to_string())?;
        state.db.with(|c| index::save(c, &self.id, &self.rel, &s)).map_err(|e| e.to_string())
    }

    pub fn ended(&self) -> bool {
        self.ended
    }

    /// The event as a line of the record: its contents in blobs, its own `ms` as `took`, in an envelope.
    fn envelope(&mut self, store: &Store, event: Value) -> Result<Value, String> {
        let mut e = stored(store, event)?;
        let o = e.as_object_mut().ok_or("an event is an object")?;
        if let Some(ms) = o.remove("ms") { o.insert("took".into(), ms); }
        let mut line = Map::new();
        line.insert("v".into(), json!(1));
        line.insert("run".into(), json!(self.id));
        line.insert("seq".into(), json!(self.seq));
        line.insert("at".into(), json!(now_iso()));
        line.insert("ms".into(), json!(self.t0.elapsed().as_millis() as i64));
        line.extend(std::mem::take(o));
        self.seq += 1;
        Ok(Value::Object(line))
    }
}

/// A text as a blob: `{$blob, bytes}`.
fn blob(store: &Store, bytes: &[u8]) -> Result<Value, String> {
    let sha: String = Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect();
    store.put_blob(&sha, bytes)?;
    Ok(json!({ "$blob": sha, "bytes": bytes.len() }))
}

/// Every text of a map as a blob (`null` stays: deleted).
fn all_blobs(store: &Store, m: &Value) -> Result<Value, String> {
    let Some(m) = m.as_object() else { return Ok(m.clone()) };
    let mut out = Map::new();
    for (k, v) in m {
        out.insert(k.clone(), match v.as_str() { Some(t) => blob(store, t.as_bytes())?, None => v.clone() });
    }
    Ok(Value::Object(out))
}

/// Long texts anywhere in `v` as blobs.
fn long_ones(store: &Store, v: Value, depth: usize) -> Result<Value, String> {
    Ok(match v {
        Value::String(s) if s.len() > LONG => blob(store, s.as_bytes())?,
        Value::Array(a) if depth <= 6 => Value::Array(a.into_iter().map(|x| long_ones(store, x, depth + 1)).collect::<Result<_, _>>()?),
        Value::Object(m) if depth <= 6 => Value::Object(m.into_iter().map(|(k, x)| Ok((k, long_ones(store, x, depth + 1)?))).collect::<Result<_, String>>()?),
        other => other,
    })
}

/// What an event keeps in the line, and what goes to blobs: contents always, long texts anywhere (the page's `stored`).
fn stored(store: &Store, mut e: Value) -> Result<Value, String> {
    use base64::Engine as _;
    match e["type"].as_str() {
        Some("start") => {
            let inputs = &mut e["inputs"];
            if inputs.is_object() {
                inputs["files"] = all_blobs(store, &inputs["files"])?;
                for k in ["spec", "system"] {
                    if let Some(t) = inputs[k].as_str().map(str::to_owned) { inputs[k] = blob(store, t.as_bytes())?; }
                }
            }
        }
        Some("files") => e["files"] = all_blobs(store, &e["files"])?,
        Some("tool_result") => {
            if let Some(content) = e["content"].as_array_mut() {
                for c in content {
                    match c["type"].as_str() {
                        Some("image") => {
                            let bytes = base64::engine::general_purpose::STANDARD.decode(c["data"].as_str().unwrap_or_default()).unwrap_or_default();
                            let mut b = blob(store, &bytes)?;
                            b["type"] = json!("image");
                            b["mimeType"] = c["mimeType"].clone();
                            *c = b;
                        }
                        Some("text") if c["text"].as_str().is_some_and(|t| t.len() > RESULT_TEXT) => {
                            let mut b = blob(store, c["text"].as_str().unwrap_or_default().as_bytes())?;
                            b["type"] = json!("text");
                            *c = b;
                        }
                        _ => {}
                    }
                }
            }
        }
        _ => {}
    }
    long_ones(store, e, 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contents_go_to_blobs_as_the_page_keeps_them() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_owned());
        let e = stored(&store, json!({ "type": "files", "files": { "view.tsx": "x", "data/a.yml": null } })).unwrap();
        assert_eq!(e["files"]["view.tsx"]["bytes"], 1);
        assert!(e["files"]["data/a.yml"].is_null());
        let long = "y".repeat(RESULT_TEXT + 1);
        let e = stored(&store, json!({ "type": "tool_result", "content": [{ "type": "text", "text": "short" }, { "type": "text", "text": long }] })).unwrap();
        assert_eq!(e["content"][0]["text"], "short");
        assert_eq!((e["content"][1]["type"].as_str(), e["content"][1]["bytes"].as_u64()), (Some("text"), Some(RESULT_TEXT as u64 + 1)));
        let sha = e["content"][1]["$blob"].as_str().unwrap();
        assert_eq!(store.blob(sha).unwrap().len(), RESULT_TEXT + 1);
    }
}
