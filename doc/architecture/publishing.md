# Publishing to the public site

What the workshop (`/workshop`) makes, a learning view or a visualization, can be offered for the public site. An admin reviews it, and accepting it makes it part of the repo. The site is built
from the repo, prerendered page by page, and deployed with the server (`mise run server:deploy`), on the app's domain.

```
workshop ──submit──▶ server: submissions/<id>/ + a row ──review (/review)──▶ accept
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

- exactly one `view@3` (or `view@2`) makes it a **view**; it keeps the view and its members
- exactly one `viz@1` makes it a **viz**

It checks the ymls the way draft writes are checked, and checks a view the way publishing checks one (it compiles, and
its npm is pinned and bundles). The snapshot is kept immutable in `submissions/<id>/`, as a deck with an `index.json`.
A submission records its `source` (`workshop:<draft id>`; older ones `make:`, `make-viz:` or `teach:`), so the sender
can see what became of each version.

## Reviewing

`/review` is shown only to admins (`accounts.admin`; `mise run server:admin grant-admin <email>`; the local dev
account is one). It shows the queue. For each submission it shows what it is and who sent it, its files, and the
result running from its snapshot mounted read-only, so trying it changes nothing. Rejecting needs a note, which the
sender sees.

Accepting (`web/server/src/promote.rs`) writes into the checkout the server was started with (`--promote-into`, set by
`server:serve` and `just dev`). Without one, the server only queues and rejects.

- **A view** becomes `plugins/<plugin>/`:
  - `view.tsx`;
  - a `plugin.yml` from what the view declares (reads, writes, npm pins);
  - its data as `decks/<deck>/`, a `deck@3` practising what the reviewer names (concept names, canonical English;
    one of the draft's by its name, or a new concept), which is how outlines find it.
  - Its own gestalts become the model package `gestalts/<package>/`, so the draft's package name (`d-<hex>`) is
    renamed everywhere.
  - The plugin and the package are added to the site's `distribution.yml`.
- **A viz** becomes `plugins/vizint/decks/<deck>/`, a `deck@3` the same way.
- Decks are normalized as `publish-data` does it: blobs named by content, plus `index.json`.
- Every target gets an `origin.yml` (submission, credit, licence).
- A later submission from the same draft and account replaces what the earlier one put there; git shows the
  difference. Anything else already at a target is refused.

What's left is ordinary repo work, listed after accepting: `mise run gestalts:publish` (new definitions are published
for good), `mise run check`, commit, `mise run site:build`. From then on it's the content team's code, to improve like
any other.

## Not yet

- deploying the queue
- automated gates before review (bundle size, network use, performance) and an advisory AI review
- mapping a lesson's gestalts onto the repo's own instead of keeping its package
- a description per deck of its own, beyond its concepts' names
- a still for each card
