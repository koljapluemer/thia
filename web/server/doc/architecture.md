# Server architecture

```
web/app/src/workshop/      the app (/workshop): sign-in, drafts of each kind, the panes, publishing, settings
web/server/worker/         Node beside the server: compile and check a view, bundle npm packages
web/site/                  the public site, whose build also runs a published lesson from its link
web/app/src/review/        the review queue (/review): admins accept or reject submissions
web/server/                gestalts-teacher: the API, the agent, publishing, the lesson domain, submissions
packages/workshop/         drafts, Preview, Chat, the job protocol, the agent template, the Claude
                           bridge's client and the agents' tools (agents/), the lesson format (lesson.ts)
packages/check/            the check the local agent runs, in the page
installables/claude-bridge/  the CLI agent on a teacher's own computer
packages/npm-bundle/       npm packages bundled and pinned, without a CDN
web/server/deploy/         the box: Caddy, systemd, backups
```

## A draft

Each draft has a kind (`drafts.kind`), set when it's made:

- `view`: a `view@2` yml and its `members` (`packages/workshop/src/draft.ts`): `gestalt@1` definitions named in the
  draft's `package`, which the server hands out, and the ymls it ships with
- `viz`: one `viz@1` yml and the blobs it names
- `sequence`: one `sequence@1` yml, whose steps are the account's view drafts (`sequence.rs`: checked as a whole,
  published as `lesson@2`, each view a `lesson@1` folder under `views/<n>/`; the agent plans its split in one call at
  low effort, `POST /api/drafts/<id>/sequence/plan`, within the budget, making nothing)

Each draft is its own folder, in the browser (OPFS, `teacher-draft-<id>`) and on the server (`drafts/<id>/`), synced
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

It makes views; a viz's draft is built by the CLI agent only, whose check renders it in the page. On the server, on our
API key (`agent.rs`): a tool loop over the draft's files held in memory. Its tools read and
write `view.tsx`, `view.json`, `gestalts/` and `data/`, read and search the kit's sources and the examples of the agent
template, and run the check (the worker: `@gestalts/check`'s `checkView`, as the page runs it for the CLI agent, plus
whether each pinned package bundles). No filesystem, no shell. The
contract is the template's `CLAUDE.md` with a preface, cached. Turns use the workshop's job protocol, so `Chat` is the
same as learning-workshop's; the browser writes the files a turn hands back. One turn at a time per teacher, within a
monthly token budget (`turns` in the database). A draft's conversation is kept on disk (`agent/<draft>.json`) for a
week after its last turn.

It may **ask** (`packages/workshop/agent-template/ask.json`, the tool's description carrying when to): one to four
questions with two to four options each, shown as a card in `Chat` (`AskCard.tsx`). The turn ends with that call open
(`done` says `waiting`), and the question is kept with the conversation: `GET status` returns it (`ask`), so it shows
on any device and after a restart. The answer comes as the next turn's `answer`, the open call's result, with the
results of the calls beside it; a message written instead answers it too. One card per turn: a second is refused to
the agent.

### Or the claude CLI on the teacher's computer

Settings (kept in the browser, `teacher:agent`) can switch a teacher to the CLI instead: Claude Code on their own
computer through the Claude bridge (`installables/claude-bridge`, :7737) (`bridgeBackend` in
`packages/workshop/src/agents/bridge.ts`). The bridge asks the teacher once, in a dialog on their computer, whether
the site may use it. A turn sends the draft and the template; the check runs in the teacher's page
(`@gestalts/check`). Each turn carries a `brief` (`src/agent.ts`, the server's preface less its tools) that goes
before the template's contract. The draft, its sync and its validation are
the same as with the server's agent: the browser writes what a turn hands back, and the server checks it. CLI turns
use the teacher's own Claude plan, not the school's budget; the npm bundling check runs only at publishing. Chat
sessions are kept per backend, so switching starts a new conversation.

## Previewing

The preview runs the view under `closedCsp`, as the player does: nothing reaches a server, npm packages come from
`/api/npm/` at the versions `view.json` pins (bundled on demand by the worker), so what breaks in a lesson breaks in
the preview first.

## Publishing

`publish.rs`: a view's draft as the server has it is checked with the same check the agents run (the worker's
`check-draft`: it compiles and typechecks, reads and writes gestalts a lesson has, imports npm pinned in view.json and
loads nothing from other servers; each package bundles), and here: every member valid, published gestalts keep their
structure. A problem goes back as the check says it, for the teacher to hand to the agent. Then it is written as a version folder named by its content:
`lessons/<lesson>/<version>/` with `manifest.json`, the compiled view, and its ymls as a published deck. It is
published for the frame runtime of the page publishing it, which is what its preview runs, and the player its link
serves from then on (`admin install-player` puts each runtime's player here, as deploying does). Without that player,
the teacher is told the site was just updated, to reload and try again. npm bundles go to `npm/`, shared. A draft has one publication, so its link stays across
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

## Not yet

Headless screenshots for the agent, QR and short codes, rotating a link, an offline player, schools and sharing in
the UI, gates and an AI review before a submission's human review, OIDC sign-in, results for teachers. See [[../../../doc/roadmap/teacher-app|the roadmap]].
