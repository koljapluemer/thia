# Concept model roadmap

Proposals from the 2026-11-16 design discussion, and what's left of the outlines plan of 2026-11-23. Built and
documented: set membership (`concept@3`'s `in`) and set state derived in the core, `deck@3`'s `concepts`, queries over
several gestalts, and outlines with views found through concepts
([[../architecture/publishing#Curricula and guides|Publishing]]). The rest is not implemented or decided. See
[[../research/concept-modelling|Concept modelling]] for the distinctions and literature behind them, and
[[../reference/data-format#Concepts, practice and what a learner knows|Data format]] for the current model.

## Ownership

| Owner | Writes | Lives in |
|---|---|---|
| deck / plugin author | concepts, items with `concepts`, evidence links, set concepts and memberships | `plugins/*/decks/` |
| outline author | curricula and guides: entries naming concepts (built) | `outlines/` |
| user, by practising | practice events, FSRS data, concepts created at runtime | the user's repository |
| anyone | extra `concept-link` claims, signed via `source` | wherever they are made |

The core would derive topic → entry points, deck → concepts, set → member counts, per-concept estimates, and the
unfiled list rather than storing them.

## Needs design

- A `closed` marker on set concepts, because the core cannot infer whether a deck ships every member: then closed
  sets show *k of n* (`members.of`). It is structural, so it is `concept@4`.
- One concept-level estimate fed by fact and skill evidence, with FSRS remaining the item scheduler. This continues
  the Bayesian direction in [[../research/generic-learning-original-brief|the original generic-learning brief]].
- Aggregate activity by set and abstraction rather than every raw concept touched.
- Give a fact its own concept when multiple items share it; otherwise the item may be sufficient.
- Naming rules for concepts: [[01_concept-naming|Concept naming]].

## Views getting their concepts

The outlines only show what decks declare (`deck@3.concepts`); today the reviewer names them when accepting a
submission.

- The workshop agent proposes a deck's concepts while building: a "find concepts" tool over existing names and
  aliases, lexical first; embeddings from a model the server runs only once matching misses or there are more than
  about 300 concepts besides set members. Decided together with ids independent of names
  ([[01_concept-naming|Concept naming]]).
- The maker proposes and edits them; an admin confirms in the local CMS, which shows new concepts with their closest
  existing ones and the outline entries the view will appear under.
- A "doesn't fit here" report on a view listed under an entry, back into the review queue.
- The gaps (`outlines/<name>.gaps.json`: entries no view practises) shown in the local CMS as candidate briefs.

## Outlines, later

- Concept chips on a view, linking to the catalog filtered by them (`?concept=`). Concepts are filters, not pages.
- The Niedersachsen competence tables (chapter 3.1/3.2) as a second outline; the PDF's tag tree (Word's table
  cells) is the clean route, its layout text isn't.
- Other Länder and school types (CuVo has a PDF each: Oberschule `upload=345`, Realschule 255, IGS 235, Hauptschule
  344, Grundschule 737, Sek II 208).
- KMK Bildungsstandards as a hub other outlines align to (`aligns`).
- Hand-picked views on entries, for small guides; guides themselves; outlines written by accounts.
- Carrying concepts over to a new edition by matching keys and labels.

## Later

- Entry-point restrictions such as “world-map, only Africa,” shared by search and practice configuration.
- Everyday-language search mapped to concepts and then ranked entry points.
- Emergent clustering as an exploration lens, without storing it as canonical structure.
- Honest aggregate labels and explicit treatment of missing response diagnoses.
