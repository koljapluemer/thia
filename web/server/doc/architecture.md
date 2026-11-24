# Server architecture

```
web/app/src/workshop/      the app (/workshop): sign-in, drafts of each kind, the panes, publishing, settings
web/server/worker/         Node beside the server: compile and check a view or a viz (render.ts: headless Chromium), bundle npm
web/site/                  the public site, whose build also runs a published lesson from its link
web/app/src/review/        the review queue (/review): admins accept or reject submissions
web/server/                thia-server: the API, the agent, MCP for chat apps, publishing, the lesson domain, submissions
packages/workshop/         drafts, Preview, Chat, the job protocol, the agent template, the Claude
                           bridge's client and the agents' tools (agents/), the lesson format (lesson.ts)
packages/check/            the check every agent runs: in the page, and in the worker
installables/claude-bridge/  the CLI agent on your own computer
packages/npm-bundle/       npm packages bundled and pinned, without a CDN
web/server/deploy/         the box: Caddy, systemd, backups
```

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

## The agent

What an agent works on and against is shared by whoever runs its loop (`src/drafting/`): the contract for each kind
(`contract.rs`), the draft's files and the tools over them (`workbench.rs`), and a `Driver` naming what differs (who
asks the person, where the files come from, who records the run). The server's own agent is one driver. A chat app
over MCP is another ([`mcp.md`](mcp.md)): Claude works on an account's view drafts with the same tools, signed in with
OAuth, and each write is saved as the workshop saves one.

Besides turns, `POST /api/drafts/<id>/agent/complete` `{system, prompt}` gives one answer without tools, at low effort,
within the budget: the transport for features built on any agent (`AgentBackend.complete`; planning a lesson), which
the Claude bridge gives as well. What the answer is for is the page's.

It makes views and vizzes, on our API key (`agent.rs`): a tool loop over the draft's files held in memory. What it's
told about each kind, which paths are the draft and the check's description are `packages/workshop/agent-template/kinds/<kind>.json`
after `brief.md`, the same the Claude bridge's agent gets; then how its own tools work (the one part that is the
server's: the CLI has its own), then the kind's contract (the template's `CLAUDE.md`, or `packages/viz/agent/CLAUDE.md`),
cached. Its tools read and write the draft's files (a view's `view.tsx`, `view.json`, `gestalts/`, `data/`; a viz's
`viz.ts`, `package.json`), read `SPEC.md` (the draft's brief) and a viz's `files/`, read and search the kind's
sources and examples, and run the check. No filesystem, no shell. A view's check is the worker's (`@gestalts/check`'s
`checkView`, as the page runs it for the CLI agent, plus whether each pinned package bundles). A viz's is rendered
where `GESTALTS_VIZ_RENDER` says: `page` (the default) hands it to the workshop page the turn came from, as a
`tool_call` event it answers with `POST …/agent/tool_result` (as the bridge hands its tools to the page; the page has
to stay open), `worker` renders it in headless Chromium in the worker (`worker/render.ts`, playwright-core;
`GESTALTS_CHROMIUM` names the browser). Either way the agent gets the screenshots. Turns use the workshop's job
protocol, so `Chat` is the same for both agents; the browser writes the files a turn hands back. One turn at a time per account, within a
monthly token budget (`turns` in the database). A draft's conversation is kept on disk (`agent/<draft>.json`) for a
week after its last turn.

It may **ask** (`packages/workshop/agent-template/ask.json`, the tool's description carrying when to): one to four
questions with two to four options each, shown as a card in `Chat` (`AskCard.tsx`). The turn ends with that call open
(`done` says `waiting`), and the question is kept with the conversation: `GET status` returns it (`ask`), so it shows
on any device and after a restart. The answer comes as the next turn's `answer`, the open call's result, with the
results of the calls beside it; a message written instead answers it too. One card per turn: a second is refused to
the agent.

### Or the claude CLI on your computer

Settings (kept in the browser, `workshop:agent`) can switch to the CLI instead: Claude Code on your own
computer through the Claude bridge (`installables/claude-bridge`, :7737) (`bridgeBackend` in
`packages/workshop/src/agents/bridge.ts`). The bridge asks you once, in a dialog on your computer, whether
the site may use it. A turn sends the draft and the kind's template, told the same `brief.md` and kind as the server's
agent; the check runs in your page (`@gestalts/check`). The draft, its sync and its validation are
the same as with the server's agent: the browser writes what a turn hands back, and the server checks it. CLI turns
use your own Claude plan, not the account's budget; the npm bundling check runs only at publishing. Chat
sessions are kept per backend, so switching starts a new conversation.

## Previewing

The preview runs the view under `closedCsp`, as the player does: nothing reaches a server, npm packages come from
`/api/npm/` at the versions `view.json` pins (bundled on demand by the worker), so what breaks in a lesson breaks in
the preview first.

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

## Submissions

A draft can be offered for the public site (`submissions.rs`), from the server's copy, as `workshop:<draft id>`.
Older submissions came from `make:`, `make-viz:` (uploaded from the browser) and `teach:`. It is checked as a write and as publishing would check it,
and kept as an immutable snapshot (`submissions/<id>/`). Admins (`accounts.admin`) review it in `/review`; accepting
(`promote.rs`) writes it into the repo checkout given with `--promote-into`, as a plugin or a vizint deck. See
[`doc/architecture/publishing.md`](../../../doc/architecture/publishing.md).

## Agent runs

`runs/` keeps the record of every agent turn, whichever backend ran it, as the workshop page sent it: one JSONL file
per run under `runs/<yyyy-mm-dd>/`, appended to and never rewritten, and the contents it names as blobs by sha256
under `runs/blobs/`. The `runs` table is an index folded from them (`src/runs/index.rs`), rebuilt from the records
whenever its `VERSION` changes, and by `admin reindex-runs`; cost is derived there from tokens and the dated prices in
`src/runs/prices.rs`. A run is its account's: the first line says whose (`owner`), and only that account appends to
it; admins read every run (`/api/admin/runs…`, or `admin runs …` in a terminal) and add notes. The server's own agent sends its usage, retries,
tool results and responses as job events, which reach the record through the page like the rest. A chat app's
requests over MCP don't pass through a page: the server records them itself, in the same format (`runs/server_run.rs`). See
[`web/app/doc/workshop/runs.md`](../../app/doc/workshop/runs.md).

## Not yet

QR and short codes, rotating a link, an offline player, schools and sharing in
the UI, gates and an AI review before a submission's human review, OIDC sign-in, results for whoever published a lesson. See [[../../../doc/roadmap/02_teacher-app|the roadmap]].
