//! Accepting a submission: it becomes part of the repo checkout the server was started with (`--promote-into`), as
//! files that are reviewed, changed and committed like any other, and that the public site (`web/site`) is built from.
//! Committing is what publishes it.
//!
//! - **A view** becomes a plugin, `plugins/<plugin>/`: its `view.tsx`, a `plugin.yml` from what the view declares,
//!   and its data as the deck `decks/<deck>/`. Its own gestalts become the model package `gestalts/<package>/`, so
//!   the draft's package (`d-<hex>`, unique, so a plain replace is safe) is renamed in everything it ships. The plugin
//!   and the package are added to the site's `distribution.yml`.
//! - **A visualization** becomes the deck `plugins/vizint/decks/<deck>/`, holding the one `viz@1`.
//!
//! Each target gets an `origin.yml`: the submission it came from, the credit asked for, and the licence. A later
//! submission from the same draft (and account) replaces what the earlier one put there; anything else already at a
//! target is refused, as is a package that is already there.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use gestalts_core::gestalt::DEFINITION_PREFIX;
use gestalts_core::{Yml, YmlState};
use gestalts_fs::FsStorage;
use serde::{Deserialize, Serialize};
use serde_yaml_ng::{Mapping, Value};

use crate::db::Submission;
use crate::validate::draft_gestalts;
use crate::{ApiError, ApiResult, AppState, now_iso};

/// What everything published on the site is under; the sender agrees to it on submitting.
pub const LICENCE: &str = "CC BY-SA 4.0";
const SITE: &str = "web/site/distribution.yml";
const VIZINT: &str = "plugins/vizint";

/// Where accepting puts it: `plugin` and `package` for a view, `deck` for both.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Target {
    #[serde(default)]
    pub plugin: Option<String>,
    #[serde(default)]
    pub package: Option<String>,
    pub deck: String,
}

#[derive(Serialize)]
pub struct Promoted {
    /// the target, from the repo's root: `plugins/<plugin>` or `plugins/vizint/decks/<deck>`
    pub at: String,
    /// every file written, from the repo's root
    pub written: Vec<String>,
    /// what's left to do before committing
    pub next: Vec<String>,
    /// what the reviewer should know
    pub warnings: Vec<String>,
}

fn io(e: impl std::fmt::Display) -> ApiError {
    ApiError::Internal(e.to_string())
}

fn name_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= 48 && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') && !s.starts_with('-') && !s.ends_with('-')
}

/// What the target was the last time this draft was accepted, read back from its `origin.yml`.
#[derive(Debug, Default, Serialize, Deserialize)]
struct Origin {
    submission: String,
    source: String,
    accepted: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    credit: Option<String>,
    licence: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    package: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    deck: Option<String>,
}

fn read_origin(dir: &Path) -> Option<Origin> {
    serde_yaml_ng::from_str(&std::fs::read_to_string(dir.join("origin.yml")).ok()?).ok()
}

/// What this draft was last accepted as, if it was.
fn earlier(state: &AppState, s: &Submission) -> ApiResult<Option<Submission>> {
    Ok(state.db.submissions_of(&s.account, &s.source)?.into_iter().find(|e| e.status == "accepted" && e.promoted.is_some()))
}

/// The defaults the review form starts from: where it went the last time, else names from its title.
pub fn proposed(state: &AppState, s: &Submission) -> ApiResult<Target> {
    let name = crate::drafts::slug(&s.title);
    if let (Some(e), Some(repo)) = (earlier(state, s)?, &state.promote_into) {
        let at = e.promoted.unwrap_or_default();
        if let Some(o) = read_origin(&repo.join(&at)) {
            let plugin = (s.kind == "view").then(|| at.trim_start_matches("plugins/").to_owned());
            return Ok(Target { plugin, package: o.package, deck: o.deck.unwrap_or(name) });
        }
    }
    Ok(match s.kind.as_str() {
        "view" => Target { plugin: Some(name.clone()), package: Some(name.clone()), deck: name },
        _ => Target { plugin: None, package: None, deck: name },
    })
}

/// Whether this submission may write at `at` (from the repo root): nothing is there, or this draft put it there.
fn may_write(state: &AppState, repo: &Path, s: &Submission, at: &str) -> ApiResult<()> {
    match state.db.promoted_to(at)? {
        Some(e) if e.account == s.account && e.source == s.source => Ok(()),
        Some(e) => Err(ApiError::Conflict(format!("{at} is “{}”, from another draft", e.title))),
        None if repo.join(at).exists() => Err(ApiError::Conflict(format!("{at} is already there, and not from a submission"))),
        None => Ok(()),
    }
}

pub async fn promote(state: &AppState, s: &Submission, t: &Target) -> ApiResult<Promoted> {
    let repo = state.promote_into.clone().ok_or_else(|| ApiError::Conflict("this server doesn't accept into a checkout (start it with --promote-into <repo>): only rejecting works here".into()))?;
    if !name_ok(&t.deck) {
        return Err(ApiError::BadRequest("deck: lowercase letters, digits and -".into()));
    }
    let (st, s, t) = (state.clone(), s.clone(), t.clone());
    tokio::task::spawn_blocking(move || match s.kind.as_str() {
        "view" => promote_view(&st, &repo, &s, &t),
        "viz" => promote_viz(&st, &repo, &s, &t),
        k => Err(ApiError::Internal(format!("a submission of kind {k}"))),
    })
    .await
    .map_err(io)?
}

fn snapshot(state: &AppState, s: &Submission) -> ApiResult<(FsStorage, BTreeMap<String, String>)> {
    let store = FsStorage::new(state.submission_dir(&s.id));
    let mut ymls = BTreeMap::new();
    for id in store.list_ymls_sync()? {
        if let Some(t) = store.read_yml_sync(&id)? {
            ymls.insert(id, t);
        }
    }
    Ok((store, ymls))
}

fn origin(s: &Submission, package: Option<&str>, deck: &str) -> Origin {
    Origin {
        submission: s.id.clone(),
        source: s.source.clone(),
        accepted: now_iso(),
        credit: s.credit.clone(),
        licence: LICENCE.into(),
        package: package.map(str::to_owned),
        deck: Some(deck.into()),
    }
}

struct Writer<'a> {
    repo: &'a Path,
    written: Vec<String>,
}

impl Writer<'_> {
    fn write(&mut self, rel: impl AsRef<Path>, bytes: &[u8]) -> ApiResult<()> {
        let path = self.repo.join(rel.as_ref());
        std::fs::create_dir_all(path.parent().expect("a file in the repo has a folder")).map_err(io)?;
        std::fs::write(&path, bytes).map_err(io)?;
        self.written.push(rel.as_ref().display().to_string());
        Ok(())
    }

    /// A deck folder of `ymls` and the blobs they use, from `from`, normalized as `publish-data` does.
    fn deck(&mut self, rel: &Path, ymls: &BTreeMap<String, String>, from: &FsStorage, gestalts: &gestalts_core::Gestalts) -> ApiResult<Vec<String>> {
        let dir = self.repo.join(rel);
        // what an earlier version put here goes: git shows the difference
        let _ = std::fs::remove_dir_all(dir.join("notes"));
        let _ = std::fs::remove_dir_all(dir.join("blobs"));
        let to = FsStorage::new(&dir);
        for (id, text) in ymls {
            to.write_yml_sync(id, text)?;
            let y = Yml::parse(id.clone(), text.clone());
            for b in gestalts_core::blobs_of(&y, &gestalts.classify(&y), gestalts) {
                if let Some(bytes) = from.read_blob_sync(&b)? {
                    to.write_blob_sync(&b, &bytes)?;
                }
            }
        }
        let report = gestalts_fs::publish(&dir, gestalts).map_err(io)?;
        for f in walk(&dir) {
            self.written.push(f.strip_prefix(self.repo).unwrap_or(&f).display().to_string());
        }
        Ok(report.problems)
    }
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        if p.is_dir() { out.extend(walk(&p)); } else { out.push(p); }
    }
    out.sort();
    out
}

fn deck_yml(id: &str, name: &str, title: &str, members: &[&String]) -> String {
    let mut m = Mapping::new();
    m.insert("id".into(), id.into());
    m.insert("gestalt".into(), "deck@1".into());
    m.insert("name".into(), name.into());
    m.insert("title".into(), title.into());
    m.insert("members".into(), Value::Sequence(members.iter().map(|s| Value::from(s.as_str())).collect()));
    serde_yaml_ng::to_string(&m).expect("yaml")
}

fn strings(m: &Mapping, k: &str) -> Vec<String> {
    m.get(k).and_then(Value::as_sequence).into_iter().flatten().filter_map(|v| v.as_str().map(str::to_owned)).collect()
}

/// Adds `item` to the list under `key:` in a distribution file, keeping the rest (and its comments) as it is.
fn add_to_list(text: &str, key: &str, item: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let entry = format!("  - {item}");
    let Some(start) = lines.iter().position(|l| l.trim_end() == format!("{key}:")) else {
        return format!("{}\n{key}:\n{entry}\n", text.trim_end());
    };
    let end = start + 1 + lines[start + 1..].iter().take_while(|l| l.starts_with("  - ")).count();
    if lines[start + 1..end].iter().any(|l| l.trim() == entry.trim()) {
        return text.to_owned();
    }
    let mut out: Vec<String> = lines.iter().map(|l| (*l).to_owned()).collect();
    out.insert(end, entry);
    format!("{}\n", out.join("\n"))
}

fn promote_view(state: &AppState, repo: &Path, s: &Submission, t: &Target) -> ApiResult<Promoted> {
    let plugin = t.plugin.as_deref().filter(|p| name_ok(p)).ok_or_else(|| ApiError::BadRequest("plugin: lowercase letters, digits and -".into()))?;
    let package = t.package.as_deref().filter(|p| name_ok(p)).ok_or_else(|| ApiError::BadRequest("package: lowercase letters, digits and -".into()))?;
    let at = format!("plugins/{plugin}");
    may_write(state, repo, s, &at)?;
    let previous = read_origin(&repo.join(&at));
    if repo.join("gestalts").join(package).exists() && previous.as_ref().and_then(|o| o.package.as_deref()) != Some(package) {
        return Err(ApiError::Conflict(format!("gestalts/{package} is already there: name the package another way")));
    }

    let (store, ymls) = snapshot(state, s)?;
    let view = ymls.iter().map(|(id, t)| Yml::parse(id.clone(), t.clone())).find(|y| y.map().and_then(|m| m.get("gestalt")).and_then(Value::as_str) == Some(crate::submissions::VIEW)).ok_or_else(|| ApiError::Internal("the snapshot has no view".into()))?;
    let m = view.map().ok_or_else(|| ApiError::Internal("the view isn't a map".into()))?.clone();
    let old = view.str_field("package").unwrap_or_default().to_owned();
    if !(old.starts_with("d-") && old.len() > 4) {
        return Err(ApiError::Internal(format!("the view's package {old} isn't a draft's")));
    }
    let rename = |s: &str| s.replace(&format!("{old}/"), &format!("{package}/")).replace(&format!("{DEFINITION_PREFIX}{old}."), &format!("{DEFINITION_PREFIX}{package}."));

    let mut w = Writer { repo, written: Vec::new() };
    let mut warnings = Vec::new();

    // its gestalts: the model package
    let mut definitions = BTreeMap::new();
    for (id, text) in ymls.iter().filter(|(id, _)| id.starts_with(DEFINITION_PREFIX) && *id != &view.id) {
        let renamed = rename(text);
        let mut def: Mapping = serde_yaml_ng::from_str(&renamed).map_err(io)?;
        def.shift_remove("id");
        def.shift_remove("gestalt");
        let name = def.get("name").and_then(Value::as_str).unwrap_or_default().to_owned();
        let version = def.get("version").and_then(Value::as_u64).unwrap_or(1);
        let short = name.split_once('/').map_or(name.as_str(), |(_, n)| n).to_owned();
        w.write(format!("gestalts/{package}/{short}/v{version}.yml"), serde_yaml_ng::to_string(&def).expect("yaml").as_bytes())?;
        definitions.insert(rename(id), renamed);
    }

    // its data: the deck
    let data: BTreeMap<String, String> = ymls.iter().filter(|(id, _)| !id.starts_with(DEFINITION_PREFIX) && *id != &view.id).map(|(id, t)| (id.clone(), rename(t))).collect();
    let mut deck = data.clone();
    let deck_id = format!("deck-{plugin}-{}", t.deck);
    deck.insert(deck_id.clone(), deck_yml(&deck_id, &t.deck, &s.title, &data.keys().collect::<Vec<_>>()));
    let gestalts = draft_gestalts(&state.gestalts, package, definitions);
    let deck_dir = PathBuf::from(&at).join("decks").join(&t.deck);
    if let Some(d) = previous.as_ref().and_then(|o| o.deck.as_deref()).filter(|d| *d != t.deck) {
        let _ = std::fs::remove_dir_all(repo.join(&at).join("decks").join(d));
    }
    for p in w.deck(&deck_dir, &deck, &store, &gestalts)? {
        warnings.push(format!("deck: {p}"));
    }
    for (id, text) in &data {
        if !matches!(gestalts.classify(&Yml::parse(id.clone(), text.clone())), YmlState::Valid(_)) {
            warnings.push(format!("{id}: not valid by the site's gestalts: add the model package it needs to web/site/distribution.yml"));
        }
    }

    // the view and its manifest
    let source = m.get("source").and_then(Value::as_str).unwrap_or_default();
    w.write(format!("{at}/view.tsx"), rename(source).as_bytes())?;
    let mut manifest = Mapping::new();
    manifest.insert("id".into(), plugin.into());
    manifest.insert("version".into(), "1.0.0".into());
    manifest.insert("title".into(), s.title.as_str().into());
    manifest.insert("description".into(), s.about.as_str().into());
    manifest.insert("tags".into(), Value::Sequence(vec!["learning".into()]));
    for k in ["reads", "writes"] {
        manifest.insert(k.into(), Value::Sequence(strings(&m, k).iter().map(|g| Value::from(rename(g))).collect()));
    }
    if let Some(npm) = m.get("npm").and_then(Value::as_mapping).filter(|n| !n.is_empty()) {
        manifest.insert("npm".into(), Value::Mapping(npm.clone()));
    }
    w.write(format!("{at}/plugin.yml"), serde_yaml_ng::to_string(&manifest).expect("yaml").as_bytes())?;
    let defines = w.written.iter().any(|f| f.starts_with("gestalts/"));
    let o = origin(s, defines.then_some(package), &t.deck);
    w.write(format!("{at}/origin.yml"), serde_yaml_ng::to_string(&o).expect("yaml").as_bytes())?;

    // on the site
    let site = repo.join(SITE);
    let mut text = std::fs::read_to_string(&site).map_err(|e| io(format!("{SITE}: {e}")))?;
    text = add_to_list(&text, "plugins", &format!("../../plugins/{plugin}"));
    if defines {
        text = add_to_list(&text, "models", &format!("../../gestalts/{package}"));
    }
    w.write(SITE, text.as_bytes())?;

    let mut next = Vec::new();
    if defines {
        next.push(format!("mise run gestalts:publish   # records gestalts/{package} as published"));
    }
    next.extend(["mise run check".to_owned(), format!("git add {at} gestalts {SITE} && git commit"), "mise run site:build".to_owned()]);
    Ok(Promoted { at, written: w.written, next, warnings })
}

fn promote_viz(state: &AppState, repo: &Path, s: &Submission, t: &Target) -> ApiResult<Promoted> {
    if t.deck == "examples" {
        return Err(ApiError::Conflict("the examples deck is the repo's own".into()));
    }
    let at = format!("{VIZINT}/decks/{}", t.deck);
    may_write(state, repo, s, &at)?;
    let (store, ymls) = snapshot(state, s)?;
    let mut w = Writer { repo, written: Vec::new() };
    let mut deck = ymls.clone();
    let deck_id = format!("deck-vizint-{}", t.deck);
    deck.insert(deck_id.clone(), deck_yml(&deck_id, &t.deck, &s.title, &ymls.keys().collect::<Vec<_>>()));
    let warnings = w.deck(Path::new(&at), &deck, &store, &state.gestalts)?.into_iter().map(|p| format!("deck: {p}")).collect();
    w.write(format!("{at}/origin.yml"), serde_yaml_ng::to_string(&origin(s, None, &t.deck)).expect("yaml").as_bytes())?;
    let next = vec!["mise run check".to_owned(), format!("git add {at} && git commit"), "mise run site:build".to_owned()];
    Ok(Promoted { at, written: w.written, next, warnings })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_in_a_distribution_grow_in_place() {
        let text = "id: site\n# the views\nplugins:\n  - ../../plugins/a\n  - ../../plugins/b\n# models\nmodels:\n  - ../../gestalts/geo\n";
        let added = add_to_list(text, "plugins", "../../plugins/c");
        assert_eq!(added, "id: site\n# the views\nplugins:\n  - ../../plugins/a\n  - ../../plugins/b\n  - ../../plugins/c\n# models\nmodels:\n  - ../../gestalts/geo\n");
        assert_eq!(add_to_list(&added, "plugins", "../../plugins/c"), added, "once");
        assert!(add_to_list("id: site\n", "models", "../../gestalts/x").ends_with("models:\n  - ../../gestalts/x\n"));
    }
}
