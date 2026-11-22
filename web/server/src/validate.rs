//! What a draft's folder may hold, checked on every write: the browser is untrusted here.
//!
//! - every yml is valid by the core's gestalts, the model packages', or the draft's own definitions, or a tombstone
//! - a view's draft: its own definitions (`gestalt@1`) are named in its package, never another's; the view yml
//!   (`view@1`/`view@2`/`view@3`) has the draft's id and package, and nothing else has that id
//! - a visualization's draft: one `viz@1`, with the draft's id, and nothing else; a lesson's (several views): one
//!   `sequence@1`, with at most one rule per step
//! - within the limits on how many ymls and how big

use std::collections::{BTreeMap, BTreeSet};

use gestalts_core::gestalt::{DEFINITION_PREFIX, GESTALT};
use gestalts_core::{Gestalts, Yml, YmlState};

use crate::Limits;

/// What a draft makes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// a `view@3` (or an older one) and its members
    View,
    /// a `viz@1`
    Viz,
    /// a `sequence@1`: a lesson of several views, each another draft
    Sequence,
}

impl Kind {
    pub fn parse(s: &str) -> Option<Kind> {
        match s {
            "view" => Some(Kind::View),
            "viz" => Some(Kind::Viz),
            "sequence" => Some(Kind::Sequence),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Kind::View => "view",
            Kind::Viz => "viz",
            Kind::Sequence => "sequence",
        }
    }

    /// The gestalt of the yml with the draft's id, which says its title.
    pub fn is_main(self, gestalt: &str) -> bool {
        match self {
            Kind::View => is_view(gestalt),
            Kind::Viz => gestalt == VIZ,
            Kind::Sequence => gestalt == SEQUENCE,
        }
    }
}

pub const VIZ: &str = "viz@1";
pub const SEQUENCE: &str = "sequence@1";

/// The gestalts of a draft's views.
pub fn is_view(gestalt: &str) -> bool {
    matches!(gestalt, "view@1" | "view@2" | "view@3")
}

/// A draft's ymls as they would be after a write.
pub struct Batch<'a> {
    pub kind: Kind,
    pub draft: &'a str,
    pub package: &'a str,
    /// what's being written
    pub incoming: &'a BTreeMap<String, String>,
    /// the ids already there
    pub existing: &'a BTreeSet<String>,
    /// the definitions already there, by id, unless overwritten
    pub definitions: &'a BTreeMap<String, String>,
}

/// The definitions `gestalts` gets from a draft's definition ymls: those valid and in its package.
pub fn draft_gestalts(base: &Gestalts, package: &str, texts: impl IntoIterator<Item = (String, String)>) -> Gestalts {
    let prefix = format!("{package}/");
    let defs = texts.into_iter().filter_map(|(id, text)| {
        let y = Yml::parse(id, text);
        matches!(base.classify(&y), YmlState::Valid(_)).then(|| base.definition(&y).ok()).flatten().filter(|d| d.name.starts_with(&prefix))
    });
    base.with_data(defs)
}

/// What's wrong with a write, each as `<id>: why`; empty when it may go ahead.
pub fn check(base: &Gestalts, limits: &Limits, b: &Batch<'_>) -> Vec<String> {
    let mut problems = Vec::new();
    let mut texts: BTreeMap<String, String> = b.definitions.clone();
    texts.extend(b.incoming.iter().filter(|(id, _)| id.starts_with(DEFINITION_PREFIX)).map(|(id, t)| (id.clone(), t.clone())));
    let gestalts = draft_gestalts(base, b.package, texts);
    let prefix = format!("{}/", b.package);
    for (id, text) in b.incoming {
        if !gestalts_core::yml::valid_key(id) {
            problems.push(format!("{id}: not an id"));
            continue;
        }
        if text.len() > limits.yml_bytes {
            problems.push(format!("{id}: longer than {} bytes", limits.yml_bytes));
            continue;
        }
        let y = Yml::parse(id.clone(), text.clone());
        match gestalts.classify(&y) {
            YmlState::Valid(g) if b.kind != Kind::View => {
                let what = b.kind.as_str();
                if id != b.draft {
                    problems.push(format!("{id}: this draft holds its {what} only, {}", b.draft));
                } else if !b.kind.is_main(&g) {
                    problems.push(format!("{id}: the draft's own id is its {what}'s"));
                } else if b.kind == Kind::Sequence {
                    let steps = y.map().and_then(|m| m.get("steps")).and_then(|s| s.as_sequence()).cloned().unwrap_or_default();
                    for (i, st) in steps.iter().enumerate() {
                        if st.get("skip_if_known").is_some() && st.get("detour").is_some() {
                            problems.push(format!("{id}: step {} has two rules; a step has at most one", i + 1));
                        }
                    }
                }
            }
            YmlState::Valid(g) => {
                if g == GESTALT {
                    let name = gestalts.definition(&y).map(|d| d.name).unwrap_or_default();
                    if !name.starts_with(&prefix) {
                        problems.push(format!("{id}: defines {name}, but this draft's gestalts are named {prefix}<name>"));
                    }
                } else if is_view(&g) {
                    if id != b.draft {
                        problems.push(format!("{id}: a draft has one view, {}", b.draft));
                    } else if matches!(g.as_str(), "view@2" | "view@3") && y.str_field("package") != Some(b.package) {
                        problems.push(format!("{id}: its package is {}", b.package));
                    }
                } else if id == b.draft {
                    problems.push(format!("{id}: the draft's own id is its view's"));
                }
            }
            YmlState::Tombstone if id == b.draft => problems.push(format!("{id}: the {} can't be deleted, only the draft", b.kind.as_str())),
            YmlState::Tombstone => {}
            YmlState::Unknown(g) => problems.push(format!("{id}: no gestalt {g} here")),
            YmlState::Invalid(p) => problems.push(format!("{id}: {}", p.iter().map(|p| if p.path.is_empty() { p.message.clone() } else { format!("{} {}", p.path, p.message) }).collect::<Vec<_>>().join("; "))),
        }
    }
    let total = b.existing.iter().chain(b.incoming.keys()).collect::<BTreeSet<_>>().len();
    if total > limits.ymls_per_draft {
        problems.push(format!("a draft holds at most {} ymls", limits.ymls_per_draft));
    }
    problems
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(incoming: &[(&str, &str)], definitions: &[(&str, &str)]) -> Vec<String> {
        run_kind(Kind::View, &Gestalts::builtin(), incoming, definitions)
    }

    fn run_kind(kind: Kind, base: &Gestalts, incoming: &[(&str, &str)], definitions: &[(&str, &str)]) -> Vec<String> {
        let incoming: BTreeMap<String, String> = incoming.iter().map(|(a, b)| ((*a).to_owned(), (*b).to_owned())).collect();
        let definitions: BTreeMap<String, String> = definitions.iter().map(|(a, b)| ((*a).to_owned(), (*b).to_owned())).collect();
        let existing = definitions.keys().cloned().collect();
        check(base, &Limits { ymls_per_draft: 4, ..Limits::default() }, &Batch { kind, draft: "v", package: "d-abc", incoming: &incoming, existing: &existing, definitions: &definitions })
    }

    const VIEW: &str = "id: v\ngestalt: view@2\ntitle: T\nsource: x\nreads: []\nwrites: []\npackage: d-abc\n";
    const NOUN: &str = "id: gestalt-d-abc.noun.1\ngestalt: gestalt@1\nname: d-abc/noun\nversion: 1\nfields:\n  word: { type: string, required: true }\n";

    #[test]
    fn a_draft_with_its_own_gestalt_and_content() {
        assert_eq!(run(&[("v", VIEW), ("gestalt-d-abc.noun.1", NOUN), ("haus", "id: haus\ngestalt: d-abc/noun@1\nword: Haus\n")], &[]), Vec::<String>::new());
        // the definition already there
        assert_eq!(run(&[("baum", "id: baum\ngestalt: d-abc/noun@1\nword: Baum\n")], &[("gestalt-d-abc.noun.1", NOUN)]), Vec::<String>::new());
        assert_eq!(run(&[("n", "id: n\ndeleted: 2026-11-20T10:00:00Z\n")], &[]), Vec::<String>::new());
    }

    #[test]
    fn what_a_draft_may_not_hold() {
        for (why, incoming, defs) in [
            ("invalid by its definition", vec![("haus", "id: haus\ngestalt: d-abc/noun@1\n")], vec![("gestalt-d-abc.noun.1", NOUN)]),
            ("another draft's gestalt", vec![("x", "id: x\ngestalt: d-other/noun@1\nword: x\n")], vec![]),
            ("a definition in another package", vec![("gestalt-d-other.noun.1", "id: gestalt-d-other.noun.1\ngestalt: gestalt@1\nname: d-other/noun\nversion: 1\n")], vec![]),
            ("a second view", vec![("w", &VIEW.replace("id: v", "id: w"))], vec![]),
            ("the view in another package", vec![("v", &VIEW.replace("package: d-abc", "package: d-x"))], vec![]),
            ("the view's id for something else", vec![("v", "id: v\ngestalt: note@1\n")], vec![]),
            ("the view deleted", vec![("v", "id: v\ndeleted: 2026-11-20T10:00:00Z\n")], vec![]),
            ("not parsing", vec![("x", "a: [")], vec![]),
        ] {
            let incoming: Vec<(&str, &str)> = incoming.iter().map(|(a, b)| (*a, *b)).collect();
            assert!(!run(&incoming, &defs).is_empty(), "{why}");
        }
        let notes: Vec<(String, String)> = ["a", "b", "c", "d", "e"].iter().map(|i| ((*i).to_owned(), format!("id: {i}\ngestalt: note@1\n"))).collect();
        let notes: Vec<(&str, &str)> = notes.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
        assert_eq!(run(&notes[..4], &[]), Vec::<String>::new());
        assert_eq!(run(&notes, &[]).len(), 1, "too many");
    }

    #[test]
    fn a_visualization_draft() {
        let models = crate::model_texts(crate::MODELS).unwrap();
        let base = Gestalts::builtin_with(&models.iter().map(String::as_str).collect::<Vec<_>>()).unwrap();
        let viz = "id: v\ngestalt: viz@1\ntitle: T\nspec: a curve\n";
        assert_eq!(run_kind(Kind::Viz, &base, &[("v", viz)], &[]), Vec::<String>::new());
        for (why, incoming) in [
            ("a view", vec![("v", VIEW)]),
            ("anything besides the viz", vec![("v", viz), ("n", "id: n\ngestalt: note@1\n")]),
            ("a second viz", vec![("w", &viz.replace("id: v", "id: w"))]),
            ("the viz deleted", vec![("v", "id: v\ndeleted: 2026-11-20T10:00:00Z\n")]),
        ] {
            let incoming: Vec<(&str, &str)> = incoming.iter().map(|(a, b)| (*a, *b)).collect();
            assert!(!run_kind(Kind::Viz, &base, &incoming, &[]).is_empty(), "{why}");
        }
    }
}
