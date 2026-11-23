//! Where runs are kept: each one's record, a JSONL file appended to and never rewritten
//! (`runs/<yyyy-mm-dd>/<run>.jsonl`), and the contents they name, by sha256 (`runs/blobs/<aa>/<sha>`).

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use serde_json::Value;
use sha2::{Digest, Sha256};

pub struct Store {
    pub root: PathBuf,
}

pub fn is_sha(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

pub fn is_run_id(s: &str) -> bool {
    (16..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit() || b.is_ascii_lowercase())
}

impl Store {
    pub fn new(root: PathBuf) -> Store {
        Store { root }
    }

    /// A new run's record, relative to the root: dated by when it began.
    pub fn new_path(id: &str, day: &str) -> String {
        format!("{day}/{id}.jsonl")
    }

    pub fn append(&self, rel: &str, lines: &[Value]) -> std::io::Result<()> {
        let path = self.root.join(rel);
        if let Some(parent) = path.parent() { std::fs::create_dir_all(parent)?; }
        let mut out = String::new();
        for l in lines {
            out.push_str(&serde_json::to_string(l).unwrap_or_default());
            out.push('\n');
        }
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
        f.write_all(out.as_bytes())
    }

    /// The record's lines that parse, in the order written; a line that doesn't (cut off mid-write) is skipped.
    pub fn read(&self, rel: &str) -> std::io::Result<Vec<Value>> {
        let f = std::fs::File::open(self.root.join(rel))?;
        Ok(std::io::BufReader::new(f).lines().map_while(Result::ok).filter_map(|l| serde_json::from_str(&l).ok()).collect())
    }

    /// Every record, by its path relative to the root.
    pub fn records(&self) -> Vec<String> {
        let mut out = vec![];
        let Ok(days) = std::fs::read_dir(&self.root) else { return out };
        for day in days.flatten() {
            let name = day.file_name().to_string_lossy().into_owned();
            if name == "blobs" || !day.path().is_dir() { continue; }
            for f in std::fs::read_dir(day.path()).into_iter().flatten().flatten() {
                let file = f.file_name().to_string_lossy().into_owned();
                if file.ends_with(".jsonl") { out.push(format!("{name}/{file}")); }
            }
        }
        out.sort();
        out
    }

    fn blob_path(&self, sha: &str) -> PathBuf {
        self.root.join("blobs").join(&sha[..2]).join(sha)
    }

    pub fn has_blob(&self, sha: &str) -> bool {
        self.blob_path(sha).is_file()
    }

    /// Keeps `bytes` as `sha`, if that's what they hash to.
    pub fn put_blob(&self, sha: &str, bytes: &[u8]) -> Result<(), String> {
        let actual: String = Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect();
        if actual != sha { return Err(format!("the bytes hash to {actual}, not {sha}")); }
        let path = self.blob_path(sha);
        if path.is_file() { return Ok(()); }
        let dir = path.parent().expect("has a parent");
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let tmp = dir.join(format!(".{sha}.{}", crate::random_hex(4)));
        std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
    }

    pub fn blob(&self, sha: &str) -> Option<Vec<u8>> {
        std::fs::read(self.blob_path(sha)).ok()
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
}

/// Every blob a value names (`{"$blob": sha}`), anywhere in it.
pub fn blobs_in(v: &Value, out: &mut std::collections::BTreeSet<String>) {
    match v {
        Value::Object(m) => {
            if let Some(Value::String(sha)) = m.get("$blob") && is_sha(sha) { out.insert(sha.clone()); }
            m.values().for_each(|x| blobs_in(x, out));
        }
        Value::Array(a) => a.iter().for_each(|x| blobs_in(x, out)),
        _ => {}
    }
}
