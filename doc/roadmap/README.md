# Roadmap

Proposed work and open design decisions, not current behaviour. Numbered in the order to build them; what's built
moves to [[../architecture/README|Architecture]] (or the app's own `doc/`) and out of here.

0. [[00_i18n|Languages]] — the app's text in English and German, `lang` on content, a view's text as data that can
   be reworded and translated on demand. First because the first users speak German, and every view built before
   its catalog exists is debt.
1. [[01_concept-naming|Concept naming]] — no field prefixes, canonical English; migrating the `math: …` concepts is
   cheap only before test users have practice history on them.
2. [[02_teacher-app|Teacher app]] — what's left for the classroom (QR and short codes, an offline player, screenshots
   of views for the agent), schools and sharing, submission gates.
3. [[03_web-first|Web first]] — accounts that sync encrypted, the key, sign-in, the trust model for view code,
   runtime versioning, migration from the old sites.
4. [[04_concept-model|Concept model]] — the workshop agent proposing a view's concepts, `closed` sets, one estimate per
   concept, outlines later.
5. [[05_gestalt-definitions-as-data|Gestalt definitions as data]] — the rest, once gestalts come from outside the repo.
6. [[06_deck-authoring|Deck authoring]] — a schema-driven editor, pipelines that regenerate decks, decks live without
   a redeploy.

Background for concept modelling is in [[../research/concept-modelling|Concept modelling research]].
