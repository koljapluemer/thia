//! Checks across the ymls of one published folder (a deck, an outline), beyond what each yml's gestalt says about it
//! alone: what `publish-data` and `health` report besides invalid ymls.
//!
//! A `deck@3` says what it practises as a whole (`concepts`), apart from its members' evidence. So that the two can't
//! drift apart, where members name concepts, each of the deck's is one a member names (directly, through its `model`,
//! or as evidence of a response) or a set (`in`) one of those is a member of. A deck whose members name none (a
//! visualization) may say anything. Either way it names at least one, and ships each concept yml it names.

use std::collections::{BTreeMap, BTreeSet};

use serde_yaml_ng::Value;

use crate::yml::Yml;

pub const DECK3: &str = "deck@3";

/// A `{id: weight}` map's keys with a weight above 0.
pub(crate) fn weighted(v: Option<&Value>) -> BTreeMap<String, f64> {
    v.and_then(Value::as_mapping)
        .into_iter()
        .flatten()
        .filter_map(|(k, w)| Some((k.as_str()?.to_owned(), w.as_f64()?)))
        .filter(|(_, w)| *w > 0.0)
        .collect()
}

pub(crate) fn is_concept(y: &Yml) -> bool {
    y.gestalt().and_then(|g| g.split('@').next()) == Some("concept")
}

/// Every concept a yml names as what it practises or what an answer to it is evidence of.
fn named_concepts(y: &Yml) -> BTreeSet<String> {
    let mut out: BTreeSet<String> = weighted(y.get("concepts")).into_keys().collect();
    for r in y.get("responses").and_then(Value::as_mapping).into_iter().flatten().map(|(_, r)| r) {
        out.extend(weighted(r.get("concepts")).into_keys());
    }
    out
}

/// What's wrong across `ymls`, one folder's, as `<id>: <problem>` lines.
pub fn folder_problems(ymls: &[Yml]) -> Vec<String> {
    let by_id: BTreeMap<&str, &Yml> = ymls.iter().map(|y| (y.id.as_str(), y)).collect();
    let mut out = Vec::new();
    for deck in ymls.iter().filter(|y| y.gestalt() == Some(DECK3)) {
        out.extend(deck_problems(deck, &by_id).into_iter().map(|p| format!("{}: {p}", deck.id)));
    }
    if ymls.iter().any(|y| y.gestalt() == Some(crate::outline_index::OUTLINE)) {
        out.extend(crate::outline_index::outline_problems(ymls));
    }
    out
}

fn deck_problems(deck: &Yml, by_id: &BTreeMap<&str, &Yml>) -> Vec<String> {
    let mut out = Vec::new();
    let concepts = weighted(deck.get("concepts"));
    if concepts.is_empty() {
        out.push("`concepts` names nothing: say what the deck practises as a whole".to_owned());
    }
    let members: Vec<&str> = deck.get("members").and_then(Value::as_sequence).into_iter().flatten().filter_map(Value::as_str).collect();
    for m in &members {
        if !by_id.contains_key(m) {
            out.push(format!("member {m} isn't in the deck"));
        }
    }
    for c in concepts.keys() {
        if !by_id.get(c.as_str()).is_some_and(|y| is_concept(y)) {
            out.push(format!("concept {c} isn't in the deck: ship its yml"));
        }
    }
    // what the members practise, an item's model's included
    let mut practised = BTreeSet::new();
    for m in members.iter().filter_map(|m| by_id.get(m)) {
        practised.extend(named_concepts(m));
        if let Some(model) = m.str_field("model").and_then(|id| by_id.get(id)) {
            practised.extend(named_concepts(model));
        }
    }
    if practised.is_empty() {
        return out;
    }
    let sets: BTreeSet<&str> = practised.iter().filter_map(|c| by_id.get(c.as_str())?.str_field("in")).collect();
    for c in concepts.keys() {
        if !practised.contains(c) && !sets.contains(c.as_str()) {
            let name = by_id.get(c.as_str()).and_then(|y| y.str_field("name")).unwrap_or(c);
            out.push(format!("concept {c} ({name}) is neither practised by a member nor a set their concepts are in"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ymls(list: &[(&str, &str)]) -> Vec<Yml> {
        list.iter().map(|(id, rest)| Yml::parse(*id, format!("id: {id}\n{rest}"))).collect()
    }

    const SET: (&str, &str) = ("set", "gestalt: concept@2\nname: s\n");
    const MEMBER: (&str, &str) = ("m", "gestalt: concept@3\nname: m\nin: set\n");
    const OTHER: (&str, &str) = ("o", "gestalt: concept@2\nname: o\n");
    const MODEL: (&str, &str) = ("model", "gestalt: item-model@1\nname: x\nconcepts: {m: 1}\nresponses: {r: {label: r, concepts: {o: 1}}}\n");
    const ITEM: (&str, &str) = ("i", "gestalt: flashcard@1\nfront: a\nback: b\nmodel: model\n");

    fn deck(concepts: &str) -> String {
        format!("gestalt: deck@3\nname: d\ntitle: D\nmembers: [set, m, o, model, i]\nconcepts: {concepts}\n")
    }

    #[test]
    fn a_deck_names_what_its_members_practise_or_their_set() {
        for ok in ["{m: 1}", "{set: 1}", "{o: 0.5}"] {
            let d = deck(ok);
            assert_eq!(folder_problems(&ymls(&[SET, MEMBER, OTHER, MODEL, ITEM, ("d", &d)])), Vec::<String>::new(), "{ok}");
        }
    }

    #[test]
    fn a_deck_that_says_nothing_or_something_else_is_refused() {
        let empty = deck("{}");
        let p = folder_problems(&ymls(&[SET, MEMBER, OTHER, MODEL, ITEM, ("d", &empty)]));
        assert!(p[0].contains("names nothing"), "{p:?}");
        let unrelated = format!("{}\n", deck("{x: 1}"));
        let p = folder_problems(&ymls(&[SET, MEMBER, OTHER, MODEL, ITEM, ("x", "gestalt: concept@2\nname: x\n"), ("d", &unrelated)]));
        assert_eq!(p.len(), 1, "{p:?}");
        assert!(p[0].contains("neither practised"), "{p:?}");
    }

    #[test]
    fn a_deck_ships_its_members_and_concepts() {
        let d = "gestalt: deck@3\nname: d\ntitle: D\nmembers: [v, gone]\nconcepts: {c: 1}\n";
        let p = folder_problems(&ymls(&[("v", "gestalt: note@1\n"), ("d", d)]));
        assert!(p.iter().any(|p| p.contains("member gone")), "{p:?}");
        assert!(p.iter().any(|p| p.contains("concept c isn't in the deck")), "{p:?}");
        // members without concepts (a visualization): anything goes, once shipped
        let p = folder_problems(&ymls(&[("v", "gestalt: note@1\n"), ("c", "gestalt: concept@2\nname: c\n"), ("d", &d.replace("[v, gone]", "[v]"))]));
        assert!(p.is_empty(), "{p:?}");
    }
}
