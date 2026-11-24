//! What an agent works on and against, by kind of draft, whoever runs its loop: the brief, the kind's instructions
//! (`packages/workshop/agent-template/kinds/<kind>.json`, shared with the page), its contract (a CLAUDE.md), which
//! paths are the draft, and what may be read besides it (the template's examples, the kit's sources), read-only.

use std::path::{Path as FsPath, PathBuf};

use serde_json::{Value, json};

use super::{Asking, Driver};

/// the `ask` tool, as the bridge's agent has it too
const ASK: &str = include_str!("../../../../packages/workshop/agent-template/ask.json");
/// Who the agent makes things for, before any kind's contract: the same text the Claude bridge's agent gets.
const BRIEF: &str = include_str!("../../../../packages/workshop/agent-template/brief.md");
const VIEW_KIND: &str = include_str!("../../../../packages/workshop/agent-template/kinds/view.json");
const VIZ_KIND: &str = include_str!("../../../../packages/workshop/agent-template/kinds/viz.json");
pub const MAX_READ_BYTES: usize = 200 * 1024;

/// What the agent works on and with for one kind of draft. `agent-template/kinds/<kind>.json` is shared with the page:
/// what it's told about the kind, which paths are the draft, the check's description. The rest is the server's own,
/// as its file tools are (the CLI has its own): what it may read besides the draft, and how those tools are described.
pub struct KindRef {
    pub kind: &'static str,
    told: String,
    keep: regex::Regex,
    check: String,
    /// the contract's text (its CLAUDE.md), or why it couldn't be read
    contract: Result<String, String>,
    /// readable, not writable: a path prefix and the folder it is
    mounts: Vec<(String, PathBuf)>,
    /// what may be deleted (prefixes of the draft's paths)
    pub deletable: &'static [&'static str],
    /// what the draft is and what else may be read, for the tools' paragraph
    pub draft_files: &'static str,
    readable: &'static str,
    example_path: &'static str,
}

impl KindRef {
    fn new(kind: &'static str, json: &str, contract: PathBuf, mounts: Vec<(String, PathBuf)>) -> Self {
        let v: Value = serde_json::from_str(json).expect("the kind's json is JSON");
        let s = |k: &str| v[k].as_str().unwrap_or_else(|| panic!("{kind}.json: no {k}")).to_owned();
        let keep = regex::Regex::new(&format!("^(?:{})$", s("keep"))).expect("the kind's keep is a regex");
        let (deletable, draft_files, readable, example_path): (&[&str], _, _, _) = match kind {
            "view" => (&["gestalts/", "data/"], "`view.tsx`, `view.json`, `gestalts/` and `data/`", "`SPEC.md`, the kit's sources (`node_modules/@gestalts/<package>/src/…`) and `examples/`", "e.g. view.tsx, gestalts/noun@1.yml, data/haus.yml, examples/noun-gender/view.tsx"),
            _ => (&[], "`viz.ts` and `package.json`", "`SPEC.md`, `files/`, `@gestalts/viz`'s sources (`viz-sources/`) and `examples/`", "e.g. viz.ts, package.json, SPEC.md, files/data.csv, viz-sources/marks.ts"),
        };
        let contract = std::fs::read_to_string(&contract).map_err(|e| format!("the {kind} agent's contract ({}): {e}", contract.display()));
        KindRef { kind, told: s("system"), keep, check: s("check"), contract, mounts, deletable, draft_files, readable, example_path }
    }

    pub fn is_draft_file(&self, path: &str) -> bool {
        self.keep.is_match(path)
    }

    /// The brief, how the draft's tools work for `driver`, the kind's instructions and its contract. Fixed text per
    /// driver, so it caches.
    pub fn system(&self, driver: &Driver) -> Result<String, String> {
        let contract = self.contract.as_ref().map_err(Clone::clone)?;
        Ok(format!("{}\n\n{}\n\n{}\n\n{contract}", BRIEF.trim(), self.tools_paragraph(driver), self.told))
    }

    /// How the agent reaches the draft: the same tools for every driver, in this one's words.
    fn tools_paragraph(&self, driver: &Driver) -> String {
        let delete = if self.deletable.is_empty() { "" } else { ", `delete_file`" };
        let files = format!(
            "`read_file`, `write_file`, `edit_file`{delete} and `list_files` work on {}; {} can be read and listed, not \
             written; `search` finds text in all of them; `check` is the contract's check. There is no shell.",
            self.draft_files, self.readable
        );
        match driver.asking {
            Asking::Tool => format!("Here the folder below is not a disk: you work on the draft's files through tools. {files}"),
            Asking::Host => format!(
                "Here there is no folder: you work on the draft's files through thia's tools, each naming the draft. {files} \
                 Every write is saved at once and checked as the workshop saves it: a refused write says why, and nothing \
                 of it was saved. The person sees the draft in thia's workshop as you change it. Ask them in this \
                 conversation when the contract says to ask."
            ),
        }
    }

    /// The tools over the draft's files, as the Messages API takes them (`input_schema`); `ask` where the driver's
    /// loop is thia's own.
    pub fn tools(&self, driver: &Driver) -> Vec<Value> {
        let path = json!({ "type": "string", "description": self.example_path });
        let mut tools = vec![
            json!({ "name": "list_files", "description": "Lists the draft's files and what may be read besides, or with `path` a folder of what may be read.",
              "input_schema": { "type": "object", "properties": { "path": path }, "additionalProperties": false } }),
            json!({ "name": "read_file", "description": "Reads a file of the draft, or one that may be read besides.",
              "input_schema": { "type": "object", "properties": { "path": path }, "required": ["path"], "additionalProperties": false } }),
            json!({ "name": "write_file", "description": format!("Writes a whole file of the draft: {}.", self.draft_files),
              "input_schema": { "type": "object", "properties": { "path": path, "content": { "type": "string" } }, "required": ["path", "content"], "additionalProperties": false } }),
            json!({ "name": "edit_file", "description": "Replaces `old_string` with `new_string` in a file of the draft. `old_string` must occur exactly once, unless `replace_all`.",
              "input_schema": { "type": "object", "properties": { "path": path, "old_string": { "type": "string" }, "new_string": { "type": "string" }, "replace_all": { "type": "boolean" } }, "required": ["path", "old_string", "new_string"], "additionalProperties": false } }),
        ];
        if !self.deletable.is_empty() {
            tools.push(json!({ "name": "delete_file", "description": format!("Deletes a file of the draft under {}.", self.deletable.join(" or ")),
              "input_schema": { "type": "object", "properties": { "path": path }, "required": ["path"], "additionalProperties": false } }));
        }
        tools.push(json!({ "name": "search", "description": "Finds lines containing `text` (case-insensitive) in the draft and in what may be read; `path` limits it to a folder or file.",
          "input_schema": { "type": "object", "properties": { "text": { "type": "string" }, "path": path }, "required": ["text"], "additionalProperties": false } }));
        tools.push(json!({ "name": "check", "description": self.check, "input_schema": { "type": "object", "properties": {}, "additionalProperties": false } }));
        if driver.asking == Asking::Tool {
            tools.push(serde_json::from_str::<Value>(ASK).expect("ask.json is JSON"));
        }
        tools
    }

    /// A path under one of the readable folders, as a file there, or `None`.
    pub(crate) fn resolve(&self, path: &str) -> Option<PathBuf> {
        if path.split('/').any(|p| p == ".." || p.is_empty() || p == ".") {
            return None;
        }
        self.mounts.iter().find_map(|(prefix, dir)| {
            if path == prefix {
                Some(dir.clone())
            } else {
                path.strip_prefix(&format!("{prefix}/")).map(|rest| dir.join(rest))
            }
        })
    }

    pub(crate) fn read(&self, path: &str) -> Option<String> {
        let p = self.resolve(path)?;
        let meta = std::fs::metadata(&p).ok()?;
        if !meta.is_file() || meta.len() as usize > MAX_READ_BYTES {
            return None;
        }
        std::fs::read_to_string(p).ok()
    }

    pub(crate) fn list(&self, path: &str) -> Option<Vec<String>> {
        let p = self.resolve(path)?;
        let mut out: Vec<String> = std::fs::read_dir(p).ok()?.flatten().map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if e.path().is_dir() { format!("{path}/{name}/") } else { format!("{path}/{name}") }
        }).collect();
        out.sort();
        Some(out)
    }

    /// Every file under the readable folders, for searching.
    pub(crate) fn files(&self) -> Vec<String> {
        fn walk(dir: &FsPath, rel: &str, out: &mut Vec<String>, depth: usize) {
            let Ok(entries) = std::fs::read_dir(dir) else { return };
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                let r = format!("{rel}/{name}");
                if e.path().is_dir() {
                    if depth < 8 && name != "node_modules" { walk(&e.path(), &r, out, depth + 1); }
                } else if [".ts", ".tsx", ".json", ".yml", ".md"].iter().any(|x| name.ends_with(x)) && !name.contains(".test.") {
                    out.push(r);
                }
            }
        }
        let mut out = Vec::new();
        for (prefix, dir) in &self.mounts {
            walk(dir, prefix, &mut out, 0);
        }
        out.sort();
        out
    }
}

/// Where the agent reads what it works against, by kind. A view's: the agent template, which links the packages'
/// sources. A viz's: `@gestalts/viz` (`packages/viz`, beside the template's package).
pub struct Reference {
    view: KindRef,
    viz: KindRef,
}

impl Reference {
    pub fn new(template: PathBuf) -> Self {
        let mut view_mounts = vec![("examples".to_owned(), template.join("examples"))];
        for p in ["view", "kit", "learning", "sources"] {
            let root = format!("node_modules/@gestalts/{p}/src");
            view_mounts.push((root.clone(), template.join(&root)));
        }
        let viz = template.join("../../viz");
        let viz_mounts = vec![("examples".to_owned(), viz.join("examples")), ("viz-sources".to_owned(), viz.join("src"))];
        Reference {
            view: KindRef::new("view", VIEW_KIND, template.join("CLAUDE.md"), view_mounts),
            viz: KindRef::new("viz", VIZ_KIND, viz.join("agent/CLAUDE.md"), viz_mounts),
        }
    }

    /// The kind of draft the agent works on, if it works on it (a lesson of several views it only plans).
    pub fn kind(&self, kind: &str) -> Option<&KindRef> {
        match kind {
            "view" => Some(&self.view),
            "viz" => Some(&self.viz),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drafting::{MCP, SERVER_AGENT};

    #[test]
    fn draft_files() {
        let r = Reference::new(PathBuf::from("/t/packages/workshop/agent-template"));
        let view = r.kind("view").unwrap();
        for ok in ["view.tsx", "view.json", "gestalts/noun@1.yml", "data/haus.yml"] {
            assert!(view.is_draft_file(ok), "{ok}");
        }
        for bad in ["notes.md", "SPEC.md", "gestalts/Noun@1.yml", "gestalts/noun@01.yml", "data/../x.yml", "data/a/b.yml", "node_modules/x.ts", "viz.ts"] {
            assert!(!view.is_draft_file(bad), "{bad}");
        }
        let viz = r.kind("viz").unwrap();
        assert!(viz.is_draft_file("viz.ts") && viz.is_draft_file("package.json"));
        for bad in ["SPEC.md", "files/a.csv", "view.tsx", "viz-sources/marks.ts"] {
            assert!(!viz.is_draft_file(bad), "{bad}");
        }
        assert!(r.kind("sequence").is_none());
    }

    #[test]
    fn the_reference_stays_in_its_roots() {
        let r = Reference::new(PathBuf::from("/t/packages/workshop/agent-template"));
        let view = r.kind("view").unwrap();
        assert!(view.resolve("examples/noun-gender/view.tsx").is_some());
        assert!(view.resolve("node_modules/@gestalts/kit/src/index.ts").is_some());
        for bad in ["node_modules/react/index.js", "examples/../check.ts", "/etc/passwd", "node_modules/@gestalts/kit/package.json", "CLAUDE.md", "viz-sources/marks.ts"] {
            assert!(view.resolve(bad).is_none(), "{bad}");
        }
        let viz = r.kind("viz").unwrap();
        assert_eq!(viz.resolve("viz-sources/marks.ts"), Some(PathBuf::from("/t/packages/workshop/agent-template/../../viz/src/marks.ts")));
        assert!(viz.resolve("examples/bezier/viz.ts").is_some());
        assert!(viz.resolve("node_modules/@gestalts/kit/src/index.ts").is_none());
    }

    #[test]
    fn a_host_asks_in_its_own_conversation() {
        let r = Reference::new(PathBuf::from("/t/packages/workshop/agent-template"));
        let view = r.kind("view").unwrap();
        let names = |d| view.tools(d).iter().map(|t| t["name"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
        assert!(names(&SERVER_AGENT).contains(&"ask".to_owned()));
        assert!(!names(&MCP).contains(&"ask".to_owned()));
    }
}
