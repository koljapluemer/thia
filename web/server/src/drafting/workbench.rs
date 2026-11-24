//! A draft's files and the tools over them, held in memory, never a filesystem or a shell: the same whichever driver
//! runs the loop. Where the files come from and where changes go is the driver's (the page's files for a turn of the
//! server's agent, saved by the page; the server's own ymls for a host over MCP, saved on each write).

use std::collections::BTreeMap;

use serde_json::{Value, json};

use super::contract::KindRef;

pub const MAX_FILE_BYTES: usize = 512 * 1024;

/// A tool's result for the model: its content (a text, or text and images), and whether it failed.
pub type ToolOut = (Value, bool);

/// The draft's files, and what may be read besides.
pub struct Workspace<'a> {
    pub files: BTreeMap<String, String>,
    /// read-only: the brief (`SPEC.md`), a viz's `files/` as text where they are
    pub extra: BTreeMap<String, String>,
    pub gestalts: &'a [String],
    pub kind: &'a KindRef,
}

impl Workspace<'_> {
    /// What a file tool did, as its result text, or an error the model sees. `check` is the driver's.
    pub fn run(&mut self, name: &str, input: &Value) -> Result<String, String> {
        let s = |k: &str| input.get(k).and_then(Value::as_str);
        let need = |k: &str| s(k).ok_or_else(|| format!("`{k}` is missing"));
        match name {
            "list_files" => match s("path").filter(|p| !p.is_empty() && *p != ".") {
                None => Ok(self.files.keys().chain(self.extra.keys()).cloned().collect::<Vec<_>>().join("\n")),
                Some(p) => {
                    let p = p.trim_end_matches('/');
                    let mine: Vec<String> = self.files.keys().chain(self.extra.keys()).filter(|f| f.starts_with(&format!("{p}/"))).cloned().collect();
                    if !mine.is_empty() || self.kind.deletable.iter().any(|d| d.trim_end_matches('/') == p) {
                        return Ok(mine.join("\n"));
                    }
                    self.kind.list(p).map(|l| l.join("\n")).ok_or_else(|| format!("{p}: no such folder here"))
                }
            },
            "read_file" => {
                let p = need("path")?;
                self.files.get(p).or_else(|| self.extra.get(p)).cloned().or_else(|| self.kind.read(p)).ok_or_else(|| format!("{p}: no such file"))
            }
            "write_file" => {
                let (p, content) = (need("path")?, need("content")?);
                if !self.kind.is_draft_file(p) {
                    return Err(format!("{p}: only {} can be written", self.kind.draft_files));
                }
                if content.len() > MAX_FILE_BYTES {
                    return Err(format!("{p}: longer than {MAX_FILE_BYTES} bytes"));
                }
                self.files.insert(p.to_owned(), content.to_owned());
                Ok(format!("wrote {p}"))
            }
            "edit_file" => {
                let (p, old, new) = (need("path")?, need("old_string")?, need("new_string")?);
                let all = input.get("replace_all").and_then(Value::as_bool).unwrap_or(false);
                let text = self.files.get(p).ok_or_else(|| format!("{p}: no such file in the draft"))?;
                let n = text.matches(old).count();
                if old.is_empty() || n == 0 {
                    return Err(format!("{p}: old_string isn't there; read the file again"));
                }
                if n > 1 && !all {
                    return Err(format!("{p}: old_string is there {n} times; give more context, or replace_all"));
                }
                let next = if all { text.replace(old, new) } else { text.replacen(old, new, 1) };
                if next.len() > MAX_FILE_BYTES {
                    return Err(format!("{p}: longer than {MAX_FILE_BYTES} bytes"));
                }
                self.files.insert(p.to_owned(), next);
                Ok(format!("edited {p}"))
            }
            "delete_file" => {
                let p = need("path")?;
                if !self.kind.deletable.iter().any(|d| p.starts_with(d)) || self.files.remove(p).is_none() {
                    return Err(format!("{p}: only an existing file under {} can be deleted", if self.kind.deletable.is_empty() { "nothing here".to_owned() } else { self.kind.deletable.join(" or ") }));
                }
                Ok(format!("deleted {p}"))
            }
            "search" => {
                let text = need("text")?.to_lowercase();
                let scope = s("path").unwrap_or("").trim_end_matches('/');
                let in_scope = |f: &str| scope.is_empty() || f == scope || f.starts_with(&format!("{scope}/"));
                let mut hits = Vec::new();
                let mut search = |f: &str, body: &str| {
                    for (i, line) in body.lines().enumerate() {
                        if hits.len() < 60 && line.to_lowercase().contains(&text) {
                            hits.push(format!("{f}:{}: {}", i + 1, line.trim().chars().take(200).collect::<String>()));
                        }
                    }
                };
                for (f, body) in self.files.iter().chain(self.extra.iter()) {
                    if in_scope(f) { search(f, body); }
                }
                for f in self.kind.files().into_iter().filter(|f| in_scope(f)) {
                    if let Some(body) = self.kind.read(&f) { search(&f, &body); }
                }
                Ok(if hits.is_empty() { "nothing found".into() } else { hits.join("\n") })
            }
            other => Err(format!("no tool {other}")),
        }
    }

    /// What differs from `before`, by path: the new text, or `None` for a file that's gone.
    pub fn changed_since(&self, before: &BTreeMap<String, String>) -> BTreeMap<String, Option<String>> {
        self.files.iter().filter(|(p, t)| before.get(*p) != Some(*t)).map(|(p, t)| (p.clone(), Some(t.clone())))
            .chain(before.keys().filter(|p| !self.files.contains_key(*p)).map(|p| (p.clone(), None)))
            .collect()
    }
}

/// MCP content (the page's: `{type: text, text}`, `{type: image, data, mimeType}`) as the Messages API takes it.
pub fn api_content(content: &[Value]) -> Value {
    Value::Array(content.iter().filter_map(|c| match c["type"].as_str() {
        Some("text") => Some(json!({ "type": "text", "text": c["text"].as_str().unwrap_or_default() })),
        Some("image") => Some(json!({ "type": "image", "source": { "type": "base64", "media_type": c["mimeType"].as_str().unwrap_or("image/png"), "data": c["data"].as_str().unwrap_or_default() } })),
        _ => None,
    }).collect())
}

/// A tool result's content as MCP and the page's tools give it (`ToolContent`): texts, and images as base64 with their
/// type.
pub fn page_content(content: &Value) -> Value {
    match content {
        Value::String(s) => json!([{ "type": "text", "text": s }]),
        Value::Array(blocks) => Value::Array(blocks.iter().map(|b| match b["type"].as_str() {
            Some("image") => json!({ "type": "image", "mimeType": b["source"]["media_type"], "data": b["source"]["data"] }),
            Some("text") => json!({ "type": "text", "text": b["text"] }),
            _ => b.clone(),
        }).collect()),
        other => json!([{ "type": "text", "text": other.to_string() }]),
    }
}

/// What a tool call is about, in a few words, as the chat shows it.
pub fn summary(name: &str, input: &Value) -> String {
    match name {
        "search" => format!("“{}”", input["text"].as_str().unwrap_or_default()),
        "check" => String::new(),
        _ => input["path"].as_str().unwrap_or_default().to_owned(),
    }
}
