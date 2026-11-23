//! Outlines (`outline@1`, `outline-entry@1`): curricula and guides as trees of entries, and the views found under each
//! entry through concepts. Not the Zettelkasten's outline ([`crate::outline`]), which is worked out from references.
//!
//! An entry says what it is about (`concepts`, 0..1); a deck says what a view opened on it practises as a whole
//! (`deck@3.concepts`). Nothing else is read: members' concepts are evidence, never navigation, and `concept-link`s
//! aren't walked. Where an entry names a set, a deck naming one of its members matches at half its weight.
//!
//! score(entry, deck) = Σ over the entry's concepts c of entry[c] × match(deck, c), where match(deck, c) is the deck's
//! weight for c, or half the highest it gives a member of c, whichever is more. A deck is listed under an entry from
//! [`MIN_SCORE`]: 0.5 × 0.5 counts, something that only comes up (0.2) doesn't unless it adds up. An entry lists its
//! own matches and its descendants', each once at its best score, best first.
//!
//! Worked out once per distribution, when the site is built, from the outlines' ymls and the decks' `deck@3` and
//! concept ymls; the site ships the result and never loads a deck to show an outline.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_yaml_ng::Value;

use crate::checks::{DECK3, is_concept, weighted};
use crate::yml::{Yml, content_hash};

pub const OUTLINE: &str = "outline@1";
pub const ENTRY: &str = "outline-entry@1";
/// From this score a deck is listed under an entry.
pub const MIN_SCORE: f64 = 0.25;
/// What a deck naming a member of a set an entry names counts for, of its weight.
pub const SET_MEMBER: f64 = 0.5;

/// The first 16 hex digits of the sha256 of `text`: how ids are made from names (`concept-…`, `outline-…`).
pub fn sha16(text: &str) -> String {
    content_hash(text.as_bytes())[..16].to_owned()
}

/// One yml, as text.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct IdText {
    pub id: String,
    pub text: String,
}

/// A folder of ymls: an outline's, or a deck's as `<plugin>/<deck>`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Folder {
    pub source: String,
    pub ymls: Vec<IdText>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct IndexInput {
    pub outlines: Vec<Folder>,
    /// each deck's `deck@3` yml and its concept ymls are enough
    pub decks: Vec<Folder>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct View {
    /// `<plugin>/<deck>`
    pub source: String,
    pub score: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedEntry {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// these three as given, or else as an ancestor gives them
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub grades: Vec<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub isced: Option<i64>,
    /// the names of what it is about
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub concepts: Vec<String>,
    /// its own and its descendants' views, each once, best first
    pub views: Vec<View>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub entries: Vec<IndexedEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Gap {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notation: Option<String>,
    /// for an entry no view practises: the names of what it is about
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub concepts: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedOutline {
    pub id: String,
    pub name: String,
    pub title: String,
    pub lang: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issuer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub school_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edition: Option<String>,
    /// the `name` of the outline this one replaces, and of the one that replaces it
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replaces: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replaced_by: Option<String>,
    /// entries without children, and how many of them have views
    pub leaves: usize,
    pub leaves_with_views: usize,
    pub entries: Vec<IndexedEntry>,
    /// entries that say what they're about, but no view practises it
    pub unpractised: Vec<Gap>,
    /// leaves that don't say what they're about
    pub unmapped: Vec<Gap>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineIndex {
    pub outlines: Vec<IndexedOutline>,
    /// decks without a `deck@3`, found under no entry
    pub skipped: Vec<String>,
}

fn parse(f: &Folder) -> Vec<Yml> {
    f.ymls.iter().map(|y| Yml::parse(y.id.clone(), y.text.clone())).collect()
}

fn refs(y: &Yml, field: &str) -> Vec<String> {
    y.get(field).and_then(Value::as_sequence).into_iter().flatten().filter_map(|v| v.as_str().map(str::to_owned)).collect()
}

fn string(y: &Yml, field: &str) -> Option<String> {
    y.str_field(field).map(str::to_owned)
}

/// What decks practise and what concepts are called, from every folder.
struct Concepts {
    names: BTreeMap<String, String>,
    sets: BTreeMap<String, String>,
    /// per deck, concept id to weight
    decks: Vec<(String, BTreeMap<String, f64>)>,
}

impl Concepts {
    fn name(&self, id: &str) -> String {
        self.names.get(id).cloned().unwrap_or_else(|| id.to_owned())
    }

    /// How much a deck practising `deck` practises `c`.
    fn matching(&self, deck: &BTreeMap<String, f64>, c: &str) -> f64 {
        let own = deck.get(c).copied().unwrap_or(0.0);
        let member = deck.iter().filter(|(d, _)| self.sets.get(*d).is_some_and(|s| s == c)).map(|(_, w)| *w).fold(0.0, f64::max);
        own.max(SET_MEMBER * member)
    }

    fn views(&self, entry: &BTreeMap<String, f64>) -> Vec<View> {
        let mut out: Vec<View> = self
            .decks
            .iter()
            .map(|(source, deck)| View { source: source.clone(), score: entry.iter().map(|(c, w)| w * self.matching(deck, c)).sum() })
            // a little slack, so 0.5 × 0.5 isn't lost to rounding
            .filter(|v| v.score >= MIN_SCORE - 1e-9)
            .collect();
        sort_views(&mut out);
        out
    }
}

fn sort_views(v: &mut [View]) {
    v.sort_by(|a, b| b.score.total_cmp(&a.score).then_with(|| a.source.cmp(&b.source)));
}

/// The views under each entry of each outline.
pub fn outline_index(input: &IndexInput) -> OutlineIndex {
    let outlines: Vec<Vec<Yml>> = input.outlines.iter().map(parse).collect();
    let decks: Vec<(String, Vec<Yml>)> = input.decks.iter().map(|d| (d.source.clone(), parse(d))).collect();
    let mut concepts = Concepts { names: BTreeMap::new(), sets: BTreeMap::new(), decks: Vec::new() };
    for y in outlines.iter().flatten().chain(decks.iter().flat_map(|(_, ys)| ys)).filter(|y| is_concept(y)) {
        if let Some(n) = y.str_field("name") {
            concepts.names.entry(y.id.clone()).or_insert_with(|| n.to_owned());
        }
        if let Some(s) = y.str_field("in") {
            concepts.sets.entry(y.id.clone()).or_insert_with(|| s.to_owned());
        }
    }
    let mut skipped = Vec::new();
    for (source, ymls) in &decks {
        match ymls.iter().find(|y| y.gestalt() == Some(DECK3)) {
            Some(d) => concepts.decks.push((source.clone(), weighted(d.get("concepts")))),
            None => skipped.push(source.clone()),
        }
    }
    concepts.decks.sort_by(|a, b| a.0.cmp(&b.0));

    // which outline replaces which, by id
    let roots: Vec<&Yml> = outlines.iter().filter_map(|ys| ys.iter().find(|y| y.gestalt() == Some(OUTLINE))).collect();
    let name_of = |id: &str| roots.iter().find(|r| r.id == id).and_then(|r| string(r, "name"));
    let mut out = OutlineIndex { outlines: Vec::new(), skipped };
    for ymls in &outlines {
        let Some(root) = ymls.iter().find(|y| y.gestalt() == Some(OUTLINE)) else { continue };
        let by_id: BTreeMap<&str, &Yml> = ymls.iter().filter(|y| y.gestalt() == Some(ENTRY)).map(|y| (y.id.as_str(), y)).collect();
        let mut walk = Walk { by_id: &by_id, concepts: &concepts, seen: BTreeSet::new(), unpractised: Vec::new(), unmapped: Vec::new(), leaves: 0, leaves_with_views: 0 };
        let entries = walk.children(&refs(root, "entries"), &Inherited::default());
        let replaces = root.str_field("replaces").map(|r| name_of(r).unwrap_or_else(|| r.to_owned()));
        let replaced_by = roots.iter().find(|r| r.str_field("replaces") == Some(root.id.as_str())).and_then(|r| string(r, "name"));
        out.outlines.push(IndexedOutline {
            id: root.id.clone(),
            name: string(root, "name").unwrap_or_else(|| root.id.clone()),
            title: string(root, "title").unwrap_or_default(),
            lang: string(root, "lang").unwrap_or_default(),
            issuer: string(root, "issuer"),
            region: string(root, "region").filter(|r| !r.is_empty()),
            subject: string(root, "subject"),
            school_type: string(root, "school_type"),
            edition: string(root, "edition"),
            replaces,
            replaced_by,
            leaves: walk.leaves,
            leaves_with_views: walk.leaves_with_views,
            entries,
            unpractised: walk.unpractised,
            unmapped: walk.unmapped,
        });
    }
    out.outlines.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

#[derive(Default, Clone)]
struct Inherited {
    level: Option<String>,
    grades: Vec<i64>,
    isced: Option<i64>,
}

struct Walk<'a> {
    by_id: &'a BTreeMap<&'a str, &'a Yml>,
    concepts: &'a Concepts,
    /// so a broken tree (which the checks report) can't loop
    seen: BTreeSet<String>,
    unpractised: Vec<Gap>,
    unmapped: Vec<Gap>,
    leaves: usize,
    leaves_with_views: usize,
}

impl Walk<'_> {
    fn children(&mut self, ids: &[String], up: &Inherited) -> Vec<IndexedEntry> {
        ids.iter().filter_map(|id| self.entry(id, up)).collect()
    }

    fn entry(&mut self, id: &str, up: &Inherited) -> Option<IndexedEntry> {
        let y = *self.by_id.get(id)?;
        if !self.seen.insert(id.to_owned()) {
            return None;
        }
        let grades: Vec<i64> = y.get("grades").and_then(Value::as_sequence).into_iter().flatten().filter_map(Value::as_i64).collect();
        let here = Inherited {
            level: string(y, "level").or_else(|| up.level.clone()),
            grades: if grades.is_empty() { up.grades.clone() } else { grades },
            isced: y.get("isced").and_then(Value::as_i64).or(up.isced),
        };
        let about = weighted(y.get("concepts"));
        let entries = self.children(&refs(y, "entries"), &here);
        let own = self.concepts.views(&about);
        let names: Vec<String> = about.keys().map(|c| self.concepts.name(c)).collect();
        let gap = |concepts: Vec<String>| Gap { id: y.id.clone(), label: string(y, "label").unwrap_or_default(), notation: string(y, "notation"), concepts };
        if !about.is_empty() && own.is_empty() {
            self.unpractised.push(gap(names.clone()));
        }
        if entries.is_empty() {
            self.leaves += 1;
            if about.is_empty() {
                self.unmapped.push(gap(Vec::new()));
            }
        }
        // its own views and its descendants', each at its best
        let mut best: BTreeMap<String, f64> = BTreeMap::new();
        for v in own.iter().chain(entries.iter().flat_map(|e| &e.views)) {
            let s = best.entry(v.source.clone()).or_insert(0.0);
            *s = s.max(v.score);
        }
        let mut views: Vec<View> = best.into_iter().map(|(source, score)| View { source, score }).collect();
        sort_views(&mut views);
        if entries.is_empty() && !views.is_empty() {
            self.leaves_with_views += 1;
        }
        Some(IndexedEntry {
            id: y.id.clone(),
            label: string(y, "label").unwrap_or_default(),
            notation: string(y, "notation"),
            kind: string(y, "kind"),
            level: here.level,
            grades: here.grades,
            isced: here.isced,
            concepts: names,
            views,
            entries,
        })
    }
}

/// What's wrong with an outline's folder: one `outline@1`, named by its id; a tree of entries in the folder, each under
/// one parent, every one reachable; every concept an entry names shipped with it.
pub fn outline_problems(ymls: &[Yml]) -> Vec<String> {
    let mut out = Vec::new();
    let roots: Vec<&Yml> = ymls.iter().filter(|y| y.gestalt() == Some(OUTLINE)).collect();
    if roots.len() != 1 {
        out.push(format!("an outline's folder holds one outline@1, this one {}", roots.len()));
    }
    let by_id: BTreeMap<&str, &Yml> = ymls.iter().map(|y| (y.id.as_str(), y)).collect();
    for r in &roots {
        if let Some(name) = r.str_field("name") {
            let want = format!("outline-{}", sha16(name));
            if r.id != want {
                out.push(format!("{}: an outline named {name} is {want}", r.id));
            }
        }
    }
    let mut parents: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for y in ymls.iter().filter(|y| matches!(y.gestalt(), Some(OUTLINE | ENTRY))) {
        for c in y.get("entries").and_then(Value::as_sequence).into_iter().flatten().filter_map(Value::as_str) {
            match by_id.get(c) {
                Some(e) if e.gestalt() == Some(ENTRY) => parents.entry(c).or_default().push(&y.id),
                _ => out.push(format!("{}: entry {c} isn't an outline-entry@1 in the outline", y.id)),
            }
        }
    }
    for (c, ps) in &parents {
        if ps.len() > 1 {
            out.push(format!("{c}: is under {} (an entry has one parent)", ps.join(", ")));
        }
    }
    // reachable from the outline
    let mut reached = BTreeSet::new();
    let mut todo: Vec<&str> = roots.iter().map(|r| r.id.as_str()).collect();
    while let Some(id) = todo.pop() {
        if !reached.insert(id) {
            continue;
        }
        if let Some(y) = by_id.get(id) {
            todo.extend(y.get("entries").and_then(Value::as_sequence).into_iter().flatten().filter_map(Value::as_str).filter(|c| by_id.get(c).is_some_and(|e| e.gestalt() == Some(ENTRY))));
        }
    }
    for e in ymls.iter().filter(|y| y.gestalt() == Some(ENTRY)) {
        if !reached.contains(e.id.as_str()) {
            out.push(format!("{}: isn't reachable from the outline (left out, or in a cycle)", e.id));
        }
        for c in weighted(e.get("concepts")).keys() {
            if !by_id.get(c.as_str()).is_some_and(|y| is_concept(y)) {
                out.push(format!("{}: concept {c} isn't in the outline: ship its yml", e.id));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(source: &str, ymls: &[(&str, String)]) -> Folder {
        Folder { source: source.into(), ymls: ymls.iter().map(|(id, rest)| IdText { id: (*id).into(), text: format!("id: {id}\n{rest}") }).collect() }
    }

    fn concept(name: &str, set: Option<&str>) -> String {
        match set {
            Some(s) => format!("gestalt: concept@3\nname: {name}\nin: {s}\n"),
            None => format!("gestalt: concept@2\nname: {name}\n"),
        }
    }

    fn deck(source: &str, concepts: &str) -> Folder {
        folder(source, &[("d", format!("gestalt: deck@3\nname: d\ntitle: D\nmembers: []\nconcepts: {concepts}\n"))])
    }

    fn entry(label: &str, rest: &str) -> String {
        format!("gestalt: outline-entry@1\nlabel: {label}\n{rest}")
    }

    /// o: a (grades [5, 6], level L) > [a1 {r: 1, e: 1}, a2 {r: 0.5}, a3 {r: 0.2}, a4 {r: 0.2, e: 0.2}, a5 {}],
    /// b {countries: 1}, c {x: 1}
    fn outline() -> Folder {
        let name = "test-outline";
        folder(
            "test-outline",
            &[
                (&*format!("outline-{}", sha16(name)), format!("gestalt: outline@1\nname: {name}\ntitle: T\nlang: en\nentries: [a, b, c]\n")),
                ("a", entry("A", "level: L\ngrades: [5, 6]\nisced: 2\nentries: [a1, a2, a3, a4, a5]\n")),
                ("a1", entry("A1", "concepts: {r: 1, e: 1}\n")),
                ("a2", entry("A2", "concepts: {r: 0.5}\ngrades: [6]\n")),
                ("a3", entry("A3", "concepts: {r: 0.2}\n")),
                ("a4", entry("A4", "concepts: {r: 0.2, e: 0.2}\n")),
                ("a5", entry("A5", "")),
                ("b", entry("B", "concepts: {countries: 1}\n")),
                ("c", entry("C", "concepts: {x: 1}\n")),
                ("r", concept("rounding", None)),
                ("e", concept("estimation", None)),
                ("x", concept("nothing practises this", None)),
                ("countries", concept("countries", None)),
            ],
        )
    }

    fn index() -> OutlineIndex {
        let mut world = deck("p/world", "{france: 1}");
        world.ymls.push(IdText { id: "france".into(), text: format!("id: france\n{}", concept("France", Some("countries"))) });
        let input = IndexInput {
            outlines: vec![outline()],
            decks: vec![
                deck("p/round", "{r: 0.5, e: 1}"),
                deck("p/half", "{r: 0.5}"),
                world,
                folder("p/old", &[("d", "gestalt: deck@1\nname: d\nmembers: []\n".into())]),
            ],
        };
        outline_index(&input)
    }

    fn es_find<'a>(es: &'a [IndexedEntry], id: &str) -> Option<&'a IndexedEntry> {
        es.iter().find_map(|e| if e.id == id { Some(e) } else { es_find(&e.entries, id) })
    }

    fn views(e: &IndexedEntry) -> Vec<(&str, f64)> {
        e.views.iter().map(|v| (v.source.as_str(), (v.score * 1000.0).round() / 1000.0)).collect()
    }

    #[test]
    fn decks_are_found_by_score_from_the_threshold() {
        let ix = index();
        let o = &ix.outlines[0];
        let es = &o.entries;
        // 1 × 0.5 + 1 × 1, and 1 × 0.5
        assert_eq!(views(es_find(es, "a1").unwrap()), vec![("p/round", 1.5), ("p/half", 0.5)]);
        // 0.5 × 0.5 counts
        assert_eq!(views(es_find(es, "a2").unwrap()), vec![("p/half", 0.25), ("p/round", 0.25)]);
        // 0.2 × 0.5 doesn't
        assert!(es_find(es, "a3").unwrap().views.is_empty());
        // 0.2 × 0.5 + 0.2 × 1 adds up
        assert_eq!(views(es_find(es, "a4").unwrap()), vec![("p/round", 0.3)]);
        // a member of the set at half weight
        assert_eq!(views(es_find(es, "b").unwrap()), vec![("p/world", 0.5)]);
    }

    #[test]
    fn a_subtree_lists_its_descendants_views_once_at_their_best() {
        let ix = index();
        let a = es_find(&ix.outlines[0].entries, "a").unwrap();
        assert_eq!(views(a), vec![("p/round", 1.5), ("p/half", 0.5)]);
    }

    #[test]
    fn levels_and_grades_hold_below_unless_an_entry_says_otherwise() {
        let ix = index();
        let es = &ix.outlines[0].entries;
        let a1 = es_find(es, "a1").unwrap();
        assert_eq!((a1.level.as_deref(), a1.grades.clone(), a1.isced), (Some("L"), vec![5, 6], Some(2)));
        assert_eq!(es_find(es, "a2").unwrap().grades, vec![6]);
        assert_eq!(es_find(es, "b").unwrap().level, None);
    }

    #[test]
    fn gaps_and_counts() {
        let ix = index();
        let o = &ix.outlines[0];
        assert_eq!(ix.skipped, vec!["p/old"]);
        assert_eq!(o.unmapped.iter().map(|g| g.id.as_str()).collect::<Vec<_>>(), vec!["a5"]);
        assert_eq!(o.unpractised.iter().map(|g| g.id.as_str()).collect::<Vec<_>>(), vec!["a3", "c"]);
        assert_eq!(o.unpractised[1].concepts, vec!["nothing practises this"]);
        assert_eq!((o.leaves, o.leaves_with_views), (7, 4));
        assert_eq!(es_find(&o.entries, "a1").unwrap().concepts, vec!["estimation", "rounding"]);
    }

    #[test]
    fn a_new_edition_points_back_and_the_old_one_forward() {
        let old_name = "test-outline";
        let new_name = "test-outline-2";
        let (old_id, new_id) = (format!("outline-{}", sha16(old_name)), format!("outline-{}", sha16(new_name)));
        let new = folder(new_name, &[(&*new_id, format!("gestalt: outline@1\nname: {new_name}\ntitle: T2\nlang: en\nreplaces: {old_id}\nentries: []\n"))]);
        let ix = outline_index(&IndexInput { outlines: vec![outline(), new], decks: vec![] });
        assert_eq!(ix.outlines[0].replaced_by.as_deref(), Some(new_name));
        assert_eq!(ix.outlines[1].replaces.as_deref(), Some(old_name));
    }

    fn problems(extra: &[(&str, String)], drop: &[&str]) -> Vec<String> {
        let mut f = outline();
        f.ymls.retain(|y| !drop.contains(&y.id.as_str()));
        f.ymls.extend(extra.iter().map(|(id, rest)| IdText { id: (*id).into(), text: format!("id: {id}\n{rest}") }));
        outline_problems(&parse(&f))
    }

    #[test]
    fn a_sound_outline_has_no_problems() {
        assert_eq!(problems(&[], &[]), Vec::<String>::new());
    }

    #[test]
    fn broken_trees_are_reported() {
        // two parents
        let p = problems(&[("z", entry("Z", "entries: [a1]\n")), ("y", entry("Y", "entries: [z]\n"))], &[]);
        assert!(p.iter().any(|p| p.starts_with("a1: is under")), "{p:?}");
        assert!(p.iter().any(|p| p.starts_with("y: isn't reachable")), "{p:?}");
        // a cycle
        let p = problems(&[("u", entry("U", "entries: [v]\n")), ("v", entry("V", "entries: [u]\n"))], &[]);
        assert!(p.iter().any(|p| p.starts_with("u: isn't reachable")) && p.iter().any(|p| p.starts_with("v: isn't reachable")), "{p:?}");
        // a child that isn't there, a concept that isn't shipped
        let p = problems(&[], &["a5", "r"]);
        assert!(p.iter().any(|p| p.contains("entry a5 isn't")), "{p:?}");
        assert!(p.iter().any(|p| p.contains("concept r isn't in the outline")), "{p:?}");
        // a wrong id, two outlines
        let p = problems(&[("outline-x", "gestalt: outline@1\nname: other\ntitle: T\nlang: en\nentries: []\n".into())], &[]);
        assert!(p.iter().any(|p| p.contains("holds one outline@1")), "{p:?}");
        assert!(p.iter().any(|p| p.contains("an outline named other is outline-")), "{p:?}");
    }
}
