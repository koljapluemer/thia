# The workshop (`/workshop`)

Everything made with an agent, behind the account: one list of drafts, each of a kind, kept on the server
([`web/server`](../../../server)), which checks every write and holds each account to its quota. *New* makes a view or a
visualization; lessons of several views come next ([`doc/roadmap/one-workshop.md`](../../../../doc/roadmap/one-workshop.md)).
There is no mode without an account: on a dev machine it's `dev@localhost`, which `scripts/setup.sh` makes
(`teacher-data/dev-login.txt`); everyone else gets one from the admins (`gestalts-teacher admin add-teacher`).

```
web/app/src/workshop/
  Workshop.tsx               the sign-in; the list of drafts, New, the one open
  open.tsx                   a draft as its own store in this browser (OPFS), synced with the server's copy
  DraftPane.tsx              a view's draft: the preview beside the chat; publishing, export, delete
  VizPane.tsx                a viz's draft: the editor beside the vizint view showing it (viz.md)
  viz/                       the viz's editor, its build, the agent's template, `viz@1` as a yml
  submit.tsx                 offering a draft for the public site
  move.tsx                   moving drafts this browser kept before the workshop moved to accounts
  agent.ts, Settings.tsx     which agent makes views: the server's, or Claude Code through the Claude bridge
  api.ts                     the server's API

packages/workshop/           shared by the panes:
  draft.ts                   a draft as ymls (`view@2` and its members) and as the files the agent sees
  Preview.tsx                compiles a draft's view in the browser and runs it in a frame, as any view runs
  Chat.tsx                   one conversation about one draft
  agents/                    what an agent backend is; the teacher server's (a job over HTTP, jobs.ts); Claude Code
                             through the Claude bridge (bridge.ts); the agents' tools (tools.ts); the template sent
                             with each turn (template.ts)
  agent-template/            what the agent works against: its contract (CLAUDE.md), examples
packages/check/              the `check` tool, run in the page (and in Node, by the tests)
installables/claude-bridge/  runs `claude -p` on this computer for a site the person allowed
```

## Kinds

| kind | what it holds | agent | goes out |
|---|---|---|---|
| `view` | a `view@2` yml and its members | the server's, or the bridge's | to a class, as a lesson; to the public site, reviewed |
| `viz` | one `viz@1` yml and its blobs | the bridge's only, until the server renders | to the public site, reviewed |

A draft's id is its view's or viz's. The server checks each kind ([`web/server/src/validate.rs`](../../../server/src/validate.rs)):
a viz's draft holds its viz and nothing else.

A draft is previewed in the context it would go out in. A teacher's view runs as a lesson does: the core's gestalts
and the lesson models (`distributions/teacher.yml`, the server's `MODELS`). A **maintainer**'s (a role on the account,
`gestalts-teacher admin grant-maintainer`) runs as the public site's learning views do: every model package in the repo
and the plugins' decks beside it (`distributions/workshop.yml`), with more room. The server judges a maintainer's
drafts by every model package, and still publishes one to a class only within the lesson models. A viz is shown by
the vizint view, as the public site shows it.

Each draft can be downloaded as a zip of the folder the server keeps (a folder a gestalts node opens).

Drafts were kept in this browser before the workshop moved to accounts (the `drafts` folder of the `learning-workshop`
distribution, from `/make` and `/make-viz`). The workshop offers once to move them; each keeps its id and package, and
the copy here stays.

## A view's draft

A draft is a `view@2` yml and its `members`: `gestalt@1` definitions of its own gestalts (named in the draft's
`package`) and the ymls it ships with. What the view writes while it's tried out isn't a member. A `view@1` reads as
a draft without members.

A turn with the bridge: the browser sends the bridge the draft as files (`view.tsx`, `view.json`, `gestalts/<name>@<N>.yml`,
`data/<id>.yml`), the template (the contract, the examples, and the sources of what a view may import, under
`node_modules/@gestalts/*/src`), and any errors the preview reported or the last save refused (`runtime-errors.md`).
Claude reads and edits them in the bridge's workspace for this draft. Its `check` tool comes back to this page, which
runs `@gestalts/check` on the draft as it is then: the compile the preview does, a typecheck (TypeScript in a worker,
on types recorded by `packages/check/scripts/pack.ts`), `view.json`, `gestalts/`, `data/` and the npm imports pinned.
At the end the bridge hands back the files that changed; the browser turns those into ymls and writes them,
definitions first. What the repo refuses goes with the next message. The agent never touches any data, and the check
is the app's, whichever model runs the turn.

A turn has no deadline: it lasts as long as its socket. Stop (or leaving the page) closes the socket, which stops
claude; what it changed until then still comes back. The CLI's session is resumed in the same workspace, and the
bridge tells it which files changed outside the conversation.

Tailwind's browser build runs in the frame here, because a vibecoded view's classes aren't known at build time.

The server's agent works on its own copy of the files, with the same tools, and its `check` runs on the server
([`web/server/doc/architecture.md`](../../../server/doc/architecture.md)).

A view goes out as a lesson for a class (**Publish**), or is offered for the public site (the **Public site** menu,
`src/workshop/submit.tsx`): the server's copy of the view yml, its members and the blobs they use, as
`workshop:<draft id>`, for review. Accepted, it becomes a plugin in `plugins/`
([`doc/architecture/publishing.md`](../../../../doc/architecture/publishing.md)). Its `reads` and `writes` come from what the agent declared in
`view.json`, and there is no prompt when they widen. Chat history isn't kept across reloads; the CLI's session is.

## Agent run logs

The Claude bridge records every turn locally under its data folder's `runs/` (on Linux
`~/.local/share/gestalts-claude-bridge/runs`). Daily `workshop-agent-run@2` JSONL files distinguish the
turn's process outcome (`completed`, `failed` or `cancelled`), its final check result and permission warnings. Wall and
provider timings, token/cache usage and tools belong to that run. Claude's API time, cost and model usage are cumulative
for a resumed session, so they live under `session_totals`; reports count only the latest totals for each session.
`raw/<date>/<run>.jsonl` contains the complete Claude stream with receipt timing, including assistant and tool content;
it is private local data and is kept until manually deleted. Prompts and view files are not copied into the normalized
record. Older record schemas are left untouched and ignored by the report.

Run `mise run workshop:agent-stats`, optionally followed by `-- --days N`, `--view ID`, `--limit N` or `--json`, to summarize
the journal. A failed logging write is reported on the bridge's stderr but never changes the turn's result.
