# Thia server architecture

The app origin serves account sessions, Workshop draft sync, and MCP with OAuth. The lesson origin serves the public player and lesson artifacts from separate browser storage.

Personal sync runs on the app origin under `/api/personal-sync`. It stores one opaque, revisioned backup in
SQLite per signed-in account. The client uses a separate passphrase to unlock the backup, merges YAML in the
browser, and replaces the backup only if the revision it read is still current. The browser keeps local data in
a separate OPFS directory for each account. Guest data stays local unless explicitly imported. Personal sync
data is outside the MCP tool surface.


## A draft

Each draft has a kind (`drafts.kind`), set when it's made:

- `view`: a `view@3` yml and its `members` (`packages/workshop/src/draft.ts`): `gestalt@1` definitions named in the
  draft's `package`, which the server hands out, and the ymls it ships with
- `viz`: one `viz@1` yml and the blobs it names
- `sequence`: one `sequence@1` yml, whose steps are the account's view and viz drafts (`sequence.rs`: checked as a
  whole, published as `lesson@2`, each step a `lesson@1` folder under `views/<n>/`)

Each draft is its own folder, in the browser (OPFS, `draft-<id>`) and on the server (`drafts/<id>/`), synced
over the node's `/sync` and `/blobs` shapes under `/api/drafts/<id>/`. The browser is untrusted: the server validates
every write with the core (`validate.rs`): valid by the core's, the model packages' or the draft's own gestalts,
definitions only in its package, one view (or one viz, and nothing else), the quotas. A refused write shows as "Not
saved" in the workbench. `GET /api/drafts/<id>/export` is the folder as a zip. A draft moved from a browser (where the
workshop kept drafts before accounts) keeps its id and package (`moved` in `POST /api/drafts`); neither is ever used
twice.

The model packages a draft may use are the server's `MODELS`, which lessons may read. A **maintainer**
(`accounts.maintainer`, `admin grant-maintainer`) makes what the public site ships: their drafts are judged by every
model package in the repo, with a larger quota (`Limits::maintainer`), and one goes out as a lesson only if it stays
within `MODELS`.

## MCP and preview

Chat hosts sign in through OAuth and edit drafts with the [MCP tools](mcp.md). The server supplies the drafting contract and validates each write. Workshop syncs the draft and reports preview diagnostics for the connector.

## Publishing

`publish.rs`: a viz goes out as the vizint view (`plugins/vizint`, compiled here) started on it by the manifest's
`params`, with the viz and its page, still and files as the deck; only once built, and checked and rendered again
when `GESTALTS_VIZ_RENDER=worker`. A view's draft as the server has it is checked with the same check the agents run (the worker's
`check-draft`: it compiles and typechecks, reads and writes gestalts a lesson has, imports npm pinned in view.json and
loads nothing from other servers; each package bundles), and here: every member valid, published gestalts keep their
structure. A problem goes back as the check says it, to hand to the agent. Then it is written as a version folder named by its content:
`lessons/<lesson>/<version>/` with `manifest.json`, the compiled view, and its ymls as a published deck. It is
published for the frame runtime of the page publishing it, which is what its preview runs, and the player its link
serves from then on (`admin install-player` puts each runtime's player here, as deploying does). Without that player,
the page says the site was just updated, to reload and try again. npm bundles go to `npm/`, shared. A draft has one publication, so its link stays across
versions; unpublishing switches it off (410).

## The lesson domain

A different registrable domain (`lessons.rs`). A `lesson@2` plays its steps in order under the one link
(`web/site/src/Sequence.tsx`), on one folder for the whole lesson, so a step's practice counts in the next: a step
skipped when its concept is known (`p` ≥ 0.8), a detour first when the student struggles (practised, `p` < 0.5), the
path shown, going back and doing a skipped step anyway always allowed. A view goes on with `useHost().done()`; the
player's *Next* is always there besides. `/l/<lesson>` serves the site's build (`web/site`, installed per frame
runtime with `admin install-player`) for the lesson's runtime with a `<base>`, `/l/<lesson>/current` names the current manifest, everything else is immutable files. No indexing, no
referrer, and many not-founds a minute are answered with 429. The page keeps a student's data on the device, one
OPFS folder per lesson, with "start fresh" for shared devices.

## Submissions and runs

The server validates and stores an immutable snapshot when an author submits a view. The author can see its status through the submission API. The [local CMS](../../../doc/operations/cms.md) reviews snapshots, imports the result into source, and records decisions through direct data access.

MCP records its operations in JSONL with a derived SQLite index. Workshop owners can rate those operations. The CMS reads the run data through the same direct file and SQLite access.
