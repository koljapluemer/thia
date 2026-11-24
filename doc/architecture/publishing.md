# Publishing to the public site

A learning view made in Workshop (`/workshop`) can be offered for the public site. An admin reviews it, and accepting it makes it part of the repo. The site is built
from the repo, prerendered page by page, and deployed with the server (`mise run server:deploy`), on the app's domain.

```
workshop ──submit──▶ server: submissions/<id>/ + a row ──review (local CMS)──▶ accept
                                                                                      │
                     web/site (static) ◀──mise run site:build── git commit ◀── plugins/, gestalts/, web/site/distribution.yml
```

## One site, and everything on it is a view

`web/site` is the only public site. To a visitor, every entry is the same kind of thing: **a view opened on one of its
decks** (`/v/<plugin>/<deck>`). It doesn't matter whether it's a learning loop from the repo, a lesson from a workshop
or a visualization:

- the loops are the repo's learning plugins with their decks (`alphabet-pronunciation-trainer` on `greek-alphabet`)
- an accepted lesson or learning view is a plugin of its own with its data as a deck
- an accepted visualization is a deck of `vizint`

The catalog (`/`) lists every `(plugin, deck)` in `web/site/distribution.yml`, titled by the deck, described by the
plugin and what the deck practises (its `deck@3` concepts' names), with a text search; a plugin without a deck is
listed on its own (`/v/<plugin>`: notes, flashcards, sources), on the user's data alone. What a learner does is kept
on their device in one store for every view (OPFS `home`), with each deck opened so far mounted read-only, so beliefs
about concepts come from everything they practised; a shared device has "Guest", a store of its own, deleted when the
guest ends it. A view's params are in the URL's hash. Every page is prerendered at build time
([`web/site/README.md`](../../web/site/README.md)): its content and head, schema.org `LearningResource` with the
outline entries it fits.

### Curricula and guides

Above the views, the catalog lists the site's **outlines** (`outlines:` in `distribution.yml`, each a folder of
`outlines/`): a curriculum as its issuer published it, or a guide, as a tree of entries (`outline@1`,
`outline-entry@1`, [data format](../reference/data-format.md#outlines)). `/o/<outline>` shows the whole tree, and
`/o/<outline>/<entry>` opens it at one entry, for links to share. An entry lists the views that practise what it is
about, best first, but those a descendant fits too: a view's card is at the deepest entries it fits only, never at
an entry and its ancestor. Each entry counts its own and its descendants' views, and is greyed where there are none
("only with views" hides those, remembered per device). Nobody puts a view under an entry: an entry names concepts, a deck says what it
practises as a whole (`deck@3.concepts`), and the build matches them (`crates/core/src/outline_index.rs`, run
through the wasm by `packages/vite/src/outlines.ts`). So a new view that practises an entry's concepts shows up under
it without anyone touching the outline. The build ships each tree as `outlines/<name>.json`, loaded only by its page,
and what's missing as `outlines/<name>.gaps.json` (entries no view practises, leaves nobody mapped), and prints the
counts.

The same build also plays unlisted lesson links (`/l/<lesson>`), served by the server's lesson domain
(`web/server`, `lessons.rs`), which installs it per frame runtime (`admin install-player`, without the site's
prerendered pages) and answers each link with its bare `player.html` (an older install's `index.html`), `noindex`.

### Allowances

What a view may do beyond the strict sandbox is declared and granted the way it always was: `permissions` in its
`plugin.yml`, and `grants` in the site's `distribution.yml` (`same-origin` and `microphone`, only for our own views).
On the site:

- every view runs under `closedCsp`: no `fetch` or socket to anywhere, scripts only from the frame and the site's own
  `npm/`. A view granted `same-origin` is the one exception.
- `pinned_npm: true`: every npm package a view imports is pinned in its `plugin.yml` (`npm: {name: exact-version}`) and
  bundled into the build (`@gestalts/vite`, with `@gestalts/npm-bundle`), so nothing is loaded from a CDN at run time.

## Submitting

The workshop's **Public site** menu (`web/app/src/workshop/submit.tsx`) asks for three things: what the result is, how
to credit its maker (optional), and that the maker may share it and agrees to publication under CC BY-SA 4.0. The
account's owner grants the rights. What's sent is the server's own copy of the draft (`POST /api/drafts/<id>/submit`).

The server (`web/server/src/submissions.rs`) works out the kind from what was sent:

- exactly one `view@4` (or an older `view@3` or `view@2`) makes it a **view**; it keeps the view and its members
- historical viz submissions contain a single `viz@1`

It checks the ymls the way draft writes are checked, and checks a view the way publishing checks one (it compiles, and
its npm is pinned and bundles). The snapshot is kept immutable in `submissions/<id>/`, as a deck with an `index.json`.
A submission records its `source` (`workshop:<draft id>`; older ones `make:`, `make-viz:` or `teach:`), so the sender
can see what became of each version.

## Reviewing

The [local CMS](../operations/cms.md) reads submission snapshots and records decisions directly against server data. It prepares imports as local Git diffs. A view becomes a plugin and deck, with its custom gestalts and wording in their repo formats. The site distribution registers the plugin and any new model package. The snapshot stays immutable.

Normalize the deck, check and preview the result, and commit it before recording acceptance. Rejection needs a note visible to the sender. The next site release ships accepted changes.

## Not yet

- automated gates before review (bundle size, network use, performance) and an advisory AI review
- mapping a lesson's gestalts onto the repo's own instead of keeping its package
- a description per deck of its own, beyond its concepts' names
- a still for each card
