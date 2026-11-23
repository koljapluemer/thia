# Outlines: curricula and guides on the site (MVP plan)

Plan from the 2026-11-23 design discussion, built the same day (see "Built" at the end for what differs). Background:
[[concept-model|Concept model roadmap]] (navigation vs. knowledge, curricula as sourced schemes),
[[concept-naming|Concept naming]], [[../research/concept-modelling|Concept modelling research]].

## Goal

Two outlines on the public site (`web/site`), each a tree you can browse, with the views that fit each entry listed
under it, found through concepts rather than tagged by hand:

1. **Niedersachsen, Kerncurriculum Mathematik Gymnasium 5–10 (2015)**, in German, by its Lernbereiche.
2. **US Common Core State Standards for Mathematics**, in English, by grade › domain › cluster › standard.

An entry maps to concepts; the core derives which entry points (plugin + deck) practise them. A new view that
practises those concepts shows up under the entry without anyone touching the outline.

## Why outlines and not concepts

- A curriculum is rigid and top-down. It stays out of the concept graph: concepts say what can be known, outlines say
  where to find views. Mixing them would turn `concept-link` into a taxonomy.
- The same shape serves official curricula and smaller guides ("Quantum computing": basics, advanced; "fMRI"). The UI
  calls an outline with a `region` a curriculum (Lehrplan) and one without a guide.
- No `topic` gestalt: a topic page is an outline with one or two levels; "everything about X across outlines" is a
  query over concepts.
- No page per concept as navigation. Concept names are evidence grain and most have one view or none. Concepts are
  filters (chips on a view linking to the catalog filtered by them), not destinations. Not in the MVP.

## Gestalts

`outline@1`, the root:

```yaml
name: outline
version: 1
description: >-
  An ordered tree of `outline-entry`s for finding views, never evidence about what someone knows: a curriculum as its
  issuer published it, or a guide someone wrote. `lang` (BCP 47) is the language of its own text, labels included.
  `region` is ISO 3166-2 (DE-NI, US) when an authority issued it, empty for a guide. `edition` names this version of
  it, `replaces` the outline it supersedes. `entries` are the top level, in order.
fields:
  name: { type: string, required: true }
  title: { type: string, required: true }
  lang: { type: string, required: true }
  issuer: { type: string }
  region: { type: string }
  subject: { type: string }
  school_type: { type: string }
  edition: { type: string }
  valid_from: { type: partial_date }
  replaces: { type: ref, targets: [outline] }
  source: { type: ref, targets: [source] }
  entries: { type: ref_list, required: true }
```

`outline-entry@1`, every node below it:

```yaml
name: outline-entry
version: 1
description: >-
  One node of an outline: a stage, an area, a unit, an expectation. `label` is in its outline's `lang`, as the issuer
  wrote it. `notation` is the issuer's own code (5.NBT.A.4), never one we make up. `level` is in the issuer's terms
  ("Doppelschuljahrgang 5/6"); `grades` and `isced` only where they apply, for filters across outlines; all three
  hold for the entries below unless they say otherwise. `kind` is a hint for people ("Lernbereich", "cluster").
  `concepts` (canonical English concepts, 0..1) is what the entry is about. `entries` are its children, in order.
fields:
  label: { type: string, required: true }
  notation: { type: string }
  kind: { type: string }
  level: { type: string }
  grades: { type: list, items: { type: integer } }
  isced: { type: integer }
  concepts: { type: ref_map, min: 0, max: 1, targets: [concept] }
  entries: { type: ref_list }
```

Rules the checks enforce:

- Children point down (`entries`), so order comes free and a tree is complete by construction. An entry is in exactly
  one outline, under exactly one parent; no cycles. Which outline an entry belongs to is derived.
- Concepts are canonical English ([[concept-naming]]); labels stay in the outline's language. A German teacher reads
  German labels; the concept behind them is the same one a US standard maps to.
- `concepts` weights take three values: **1** the entry is about it, **0.5** needed or practised, **0.2** it comes up.
- Ids follow the repo rule: `outline-<sha16(name)>`, `outline-entry-<sha16(outline name + "/" + key)>` where `key` is
  the `notation`, or the builder's path of ordinals (`2/4/1`) when the issuer has none. The key isn't stored.

No `aligns` to other outlines (KMK Bildungsstandards as a hub) in the MVP.

## Versioning (kept simple)

- **Gestalt versions** as everywhere: `outline@1` is published and frozen; a structural change is `outline@2`.
- **An outline is one edition.** Its `name` carries the edition (`de-ni-gym-mathe-2015`). A new edition is a new
  outline with new entry ids and `replaces` pointing at the old one; the old one stays in the repo.
- **Within an edition**, labels and structure only get fixes (typos, a missed bullet). Those keep ids because the key
  is the notation or the position. Moving entries around is a new edition.
- **Concepts on entries change freely**: they're our interpretation, not the issuer's text. git keeps their history.
- **The site lists only current editions** (those nothing `replaces`). A replaced one stays reachable by its link,
  with a note pointing to its successor.
- Later, not now: carrying concepts over to a new edition by matching keys and labels.

## Where it lives

```
outlines/<name>/
  notes/          outline, outline-entry and source ymls; concept ymls the outline needs that no deck ships
  index.json      as a published deck's (mise run publish-data)
  tools/          the builder: fetches or reads the source and writes notes/ (dev time only)
  README.md       where the data comes from, how to rebuild it, and the licence or attribution notice
```

- `web/site/distribution.yml` gets `outlines: [../../outlines/de-ni-gym-mathe-2015, ../../outlines/us-ccss-math-2010]`.
- `packages/vite` bundles them into the registry as it bundles decks (`virtual:gestalts-plugins` or a sibling module).
- The builders' output is committed, like decks' notes. Re-extracting needs the builder's tools (for Niedersachsen,
  `pdftotext` from poppler); building the site does not.
- `outline` and `outline-entry` are core gestalts (`gestalts/outline/`, `gestalts/outline-entry/`), published with
  `mise run gestalts:publish`.

## Derived in the core

Built once per distribution, at site build time, and shipped as JSON. The page never loads every deck.

- **entry point → concepts**: a deck's `deck@2.concepts`; failing that, per concept the highest weight any member
  (item or item model) gives it. A view's own concepts come from its deck.
- **concept → entry points**, the inverse.
- **Sets**: an entry that maps to a set concept S also matches entry points whose concepts are `in` S, at half the
  weight. No walking `concept-link`s: that would mix navigation into evidence.
- **score(entry, P) = Σ over concepts c: entry.concepts[c] × concepts(P)[c]**. P is listed under the entry when the
  score is **≥ 0.25** (a 0.5 × 0.5 match counts; something that only comes up, 0.2, on either side doesn't, unless it
  adds up). The constant lives in one place and gets tuned once there is content.
- **A subtree** counts the union of its descendants' entry points and its own, without duplicates, but lists only
  its own that no descendant fits: an entry point is listed at the deepest entries it fits, never at an entry and an
  ancestor of it, so opening a chapter doesn't repeat its sections.
- **Inherited fields** (`level`, `grades`, `isced`) resolved down the tree.
- **Gaps**: entries with no concepts, and entries whose concepts no entry point practises. The admin reads them as
  candidate workshop briefs (a later step can show them in `/review`).

The derivation goes in the core (Rust), run at build through the existing node binding or wasm, not in the site or
the vite plugin.

## Site UX

- The catalog (`/`) gets a short "Curricula and guides" list above the views: each outline's title, issuer, edition,
  and how many of its entries have views.
- `/o/<outline>` shows the tree; `/o/<outline>/<entry>` opens it at that entry (deep links for teachers to share).
- The page's few own words (views, nothing yet, only with views, back) come in the outline's `lang`, German or
  English; everything else is the outline's own text. The rest of the site stays as it is.
- **Empty branches**: the whole tree is shown, because teachers want the curriculum intact. Each entry shows its count
  of views. Entries without any are greyed and don't expand to an empty list. A toggle "only with views"
  (nur mit Inhalten) hides them; off by default, remembered per device.
- An entry lists its ranked views as the catalog's cards (title, about), linking to `/v/<plugin>/<deck>` as now.
- Layout: daisyUI collapse or menu for the tree, the catalog's card grid for views; no custom CSS.

## Sources

### Niedersachsen, Mathematik Gymnasium Sek I

Checked 2026-11-23.

- Portal: https://bildungsportal-niedersachsen.de/allgemeinbildung/unterrichtsfaecher/mathematische-und-technische-faecher/mathematik-sek-i
  (links into CuVo, https://cuvo.nibis.de/). No API, JSON/XML or export; each document has numeric ids.
- PDF: https://cuvo.nibis.de/index.php?p=download&upload=63 (detail: `index.php?p=detail_view&docid=1779`).
  "Kerncurriculum für das Gymnasium, Schuljahrgänge 5–10, Mathematik", Niedersächsisches Kultusministerium, 2015.
  61 pages, from Word 2013, tagged, with a real text layer; `pdftotext -layout` reads it cleanly.
- Other school types are separate PDFs (`upload=`): Oberschule 345, Realschule 255, IGS 235, Hauptschule 344,
  Grundschule 737 (new from 2025-08-01), Sek II 208. Not checked whether a newer Gymnasium edition is in
  "Entwürfe und Anhörfassungen".
- The portal's Impressum forbids reusing its own texts without consent and says nothing on the curriculum PDFs. Store
  labels (short bullets) and the link, never the PDF or its prose (the Intentionen).

Structure. Chapter 3 holds two views of the same content:

- **3.1/3.2 competence tables**: six process areas (Mathematisch argumentieren, Probleme mathematisch lösen,
  Mathematisch modellieren, Mathematische Darstellungen verwenden, Mit symbolischen, formalen und technischen Elementen
  der Mathematik umgehen, Kommunizieren) and five content areas (Zahlen und Operationen, Größen und Messen, Raum und
  Form, Funktionaler Zusammenhang, Daten und Zufall). Each has three columns, "am Ende von Schuljahrgang 6",
  "zusätzlich am Ende von Schuljahrgang 8", "… 10", one expectation per cell ("nutzen Runden und
  Überschlagsrechnungen"). No codes. As layout text, cells wrap and columns run over page breaks, so parsing is
  fragile; the PDF's tag tree (Word's table cells) would be the clean route. **Not in the MVP.**
- **3.3 Lernbereiche**, the MVP outline: 22 units, one page each (pp. 37–61), per Doppelschuljahrgang. Each has a
  heading `Lernbereich: <name>`, an "Intentionen" paragraph (not stored), a "Kern" of bullets (glyph U+F0B7) with
  sub-bullets (`o`), "Fakultative Erweiterungen" (one line, `;`-separated), the content areas it belongs to, and
  "Hinweise zum Einsatz digitaler Mathematikwerkzeuge". Pages are separated by form feeds, with the page number on
  its own line.
  - 5/6: Umgang mit natürlichen Zahlen; Körper und Figuren; Umgang mit Brüchen; Planung und Durchführung
    statistischer Erhebungen; Umgang mit Dezimalzahlen; Symmetrien; Maßzahlen statistischer Erhebungen
  - 7/8: Umgang mit negativen Zahlen; Wahrscheinlichkeit; Proportionale und antiproportionale Zusammenhänge; Längen,
    Flächen- und Rauminhalte und deren Terme; Elementare Termumformungen; Entdeckungen an Dreiecken – Konstruktionen
    und besondere Linien; Ein- und mehrstufige Zufallsversuche; Lineare Zusammenhänge
  - 9/10: Baumdiagramme und Vierfeldertafeln; Entdeckungen an rechtwinkligen Dreiecken und Ähnlichkeit; Quadratische
    Zusammenhänge; Kreis- und Körperberechnungen; Exponentielle Zusammenhänge; Periodische Zusammenhänge;
    Näherungsverfahren als Grenzprozesse – Zahlbereichserweiterungen

  (The page order gives the split 7 / 8 / 7; check it against the section headings when extracting.)

The outline:

```
de-ni-gym-mathe-2015                 lang: de, region: DE-NI, school_type: Gymnasium, edition: 2015
└ Doppelschuljahrgang 5/6            kind: Doppelschuljahrgang, grades: [5, 6], isced: 2
  └ Umgang mit natürlichen Zahlen    kind: Lernbereich
    ├ mit natürlichen Zahlen rechnen kind: Kern
    │ ├ Grundrechenarten in alltagsrelevanten Zahlenräumen anwenden
    │ └ …
    ├ natürliche Zahlen darstellen und ordnen
    ├ runden und schätzen            concepts: { rounding: 1, estimation: 1 }
    └ Fakultative Erweiterungen      kind: Erweiterung; its items as children
```

The content areas a Lernbereich names aren't entries (they'd duplicate the tree); the builder may keep them in the
README until the competence tables are an outline of their own.

### US Common Core, Mathematics

- Not checked yet. Candidates, in order: the CASE Network's CCSS package (1EdTech, CFPackage JSON with stable
  identifiers), the Common Standards Project API (JSON), the official site (thecorestandards.org). Prefer whichever
  gives the hierarchy and the official codes (`5.NBT.A.4`) in one machine-readable file.
- Outline `us-ccss-math-2010`, `lang: en`, `region: US`: grade (K–8) and high-school conceptual category › domain
  (NBT) › cluster (A) › standard (4), `notation` the official code, `grades` per grade. The Standards for
  Mathematical Practice (MP1–MP8) as their own top-level entry.
- The licence allows use with its attribution notice; put the notice in the outline's `source@1` and its README.

## Concepts on entries

- First pass by hand, in the implementing session: for each leaf, pick concepts from those the site's decks already
  have (names only, sets but not their members), and propose new ones in canonical English where nothing fits
  ([[concept-naming]]). The user reviews a sample before it's committed.
- Concepts no deck practises yet are allowed: those are the gaps. The outline ships their concept ymls in its
  `notes/`, so a later deck that writes the same concept (same name, same id) matches.
- Existing `math: …` concepts are used as they are.

## Getting views to have concepts

The outlines only show what decks declare. Today only math-drills (5 decks, about 20 concepts) is school maths, and
vizint's decks have none. Part of the MVP:

- Backfill `deck@2.concepts` on the site's current decks where they fit, by hand, reviewed.

After the MVP:

- The workshop agent proposes `deck@2.concepts` while building (a "find concepts" tool over existing names and
  aliases: lexical first; embeddings from a model the server runs only once matching misses or the concepts other
  than set members exceed about 300).
- The maker (any user) proposes and edits them; an admin confirms at `/review`, which shows the new concepts with
  their closest existing ones and the outline entries the view will appear under.
- A "doesn't fit here" report on a view listed under an entry, back into the review queue.

## Steps

1. `outline@1`, `outline-entry@1`: definitions, checks (tree, single parent, concept refs), `data-format.md`.
2. `outlines/` packages, `distribution.yml` `outlines:`, bundling in `packages/vite`.
3. Derived index in the core, with tests on a small fixture outline.
4. Niedersachsen builder and data (Lernbereiche), concepts on its entries.
5. Common Core builder and data, concepts on its entries.
6. Backfill `deck@2.concepts` on the site's decks.
7. Site: outline list on `/`, `/o/<outline>[/<entry>]`, the tree, counts, empties, the toggle.
8. Docs: architecture (publishing, site README), this file marked built.

## Not in the MVP

Competence tables as a second outline; other Länder or school types; KMK Bildungsstandards as a hub (`aligns`);
hand-picked views on entries (for small guides); guides themselves; concept chips and `?concept=` filtering;
carrying concepts across editions; a German UI for the rest of the site; outlines written by accounts.

## Built (2026-11-23)

As planned, except:

- **`deck@3` instead of "deck@2, failing that its members".** What a view practises as a whole is its deck's own
  declaration, required (`concepts`, at least one), and the index reads only that: members' concepts are evidence,
  never navigation. Every deck on the site is a `deck@3` (their builders write it; `check-distributions` refuses one
  that isn't), the core checks a deck names only what its members practise or a set theirs are in, and accepting a
  submission asks the reviewer for its concepts. The workshop agent proposing them is still after the MVP.
- **Sets:** an entry naming a set S matches a deck at the higher of its weight for S and half the highest it gives a
  member of S (the highest, not the sum, so 240 countries don't add up).
- **Where it runs:** `crates/core/src/outline_index.rs` (the Zettelkasten's `outline.rs` keeps its name), exposed as the
  wasm's `outlineIndex`, which `packages/vite/src/outlines.ts` calls at build time; there is no Node binding. Its
  checks are in `crates/core/src/checks.rs`, run by `publish-data` and `health`.
- **Gaps:** "unmapped" counts leaves where neither they nor an entry above them names concepts, so generic
  sub-bullets ("vergleichen, schätzen, berechnen") under a mapped bullet aren't gaps. They ship as
  `outlines/<name>.gaps.json` and are printed at build; `/review` doesn't show them yet.
- **Sources:** Common Core from CCSSO's CASE package as OpenSALT serves it (`opensalt.net/cfpackage/doc/1912.json`;
  the CASE Network API refused); Niedersachsen from the PDF, with a few formulas the text layer garbles corrected to
  what the PDF prints.
- **Concepts on entries:** keyed by notation (CCSS) or by labels from the Lernbereich down (Niedersachsen) in each
  outline's `tools/concepts.yml`, so a mapping reads as what it maps.

