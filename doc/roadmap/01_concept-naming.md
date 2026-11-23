# Concept naming

From the 2026-11-23 design discussion. Proposals unless marked decided. Current rules:
[[../reference/data-format#Concepts, practice and what a learner knows|Data format]].

## The problem

A concept's id comes from its name: `concept-` and the first 16 hex digits of the name's sha256, the rule every deck
builder shares, so decks share a concept by writing the same yml under the same id. The name is the identity, so a
prefix in it is part of the identity. Prefixes do two different jobs:

- **A qualifier that is part of what the thing is**: `vie:xin chào`, `deu:Gift` vs. `eng:gift`, `vie-script: sắc`,
  `lang: vie`. A word without its language isn't a concept. No one would choose another prefix, and it never changes.
- **A classification**: `math: rounding`, `physics: fMRI`. This is a one-level top-down taxonomy inside identity,
  which [[../research/concept-modelling|Concept modelling]] rules out. Careful authors disagree on it (fMRI: physics,
  neuroscience, medicine? significant figures: maths or physics?), so decks split one concept into two, and moving
  one changes its id and strands practice history.

Grouping by field is navigation and belongs in outlines ([[../architecture/publishing#Curricula and guides|Publishing]]), or in `in` where it is a real set.

**Test: if two careful authors could choose different prefixes, the prefix is a classification and doesn't belong in
the name.**

## Rules

- **Decided:** concept names are canonical English. Other languages go in `aliases`; an outline's labels stay in its
  own language.
- Keep qualifiers that are part of the identity: languages (ISO 639-3), scripts, code systems (countries take their
  id from the code anyway).
- No field prefixes on new concepts: the bare name (`rounding`, `fMRI`, `order of operations`). Qualify only when a
  name is ambiguous, the way Wikipedia does: `mercury (planet)`, `mercury (element)`.
- Existing `math: …` concepts stay until a migration is decided. Renaming one changes its id.
- The word/intent distinction (`vie:xin chào` a word, `vie: say hello` with a space an intent) hangs on one space.
  It works, but it's the convention most likely to be gotten wrong; worth a clearer marker when it's next touched.

## Open

- **Migrate the ~20 `math: …` concepts now**, before the first test users have practice history on them, or leave them? A migration needs an old id →
  new id mapping in the core so practice history follows.
- **Ids independent of names** (as Wikidata's): an opaque id, name and aliases only as labels. Fixes renames and
  classification at the root. Decks then can't compute a shared id and need a lookup ("is there a concept for X?"),
  which is the "find concepts" tool from [[04_concept-model#Views getting their concepts|Concept model]]. Inventory concepts with natural
  keys (words, letters, countries) could keep ids from their key. Decide together with that tool.
- **Aliases carry no language.** Other languages go in `aliases`, but a translation glossary needs a label per
  language (`{lang: label}`, [[00_i18n#Concept labels as a glossary|Languages]]). Decide with ids independent of names.
