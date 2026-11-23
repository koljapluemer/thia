# The workshop (`/workshop`)

Everything made with an agent, behind the account: one list of drafts, each of a kind, kept on the server
([`web/server`](../../../server)), which checks every write and holds each account to its quota. *New* makes a view, a
visualization or a lesson of several of them ([`doc/roadmap/one-workshop.md`](../../../../doc/roadmap/one-workshop.md)).
Views and vizzes are made the same way, with either agent: one layout, one chat, one brief, one call path; what
differs is each kind's contract, preview and what it goes out as (below).
There is no mode without an account: on a dev machine it's `dev@localhost`, which `scripts/setup.sh` makes
(`teacher-data/dev-login.txt`); everyone else gets one from the admins (`gestalts-teacher admin add-teacher`).

```
web/app/src/workshop/
  Workshop.tsx               the sign-in; the list of drafts, New, the one open
  open.tsx                   a draft as its own store in this browser (OPFS), synced with the server's copy
  DraftPane.tsx              a view's draft; `Shell`, every draft's layout (header, preview, brief and chat beside it);
                             publishing, export, delete
  VizPane.tsx                a viz's draft: the vizint view showing it, its brief, texts and files, the chat (viz.md)
  Brief.tsx                  a draft's brief (`spec`), whatever its kind, saved as typed and before a turn reads it
  viz/Editor.tsx             a viz's title, texts before and after it, and files
  SequencePane.tsx           a lesson of several views and vizzes: its steps, the planner, the play-through
  submit.tsx                 offering a draft for the public site
  move.tsx                   moving drafts this browser kept before the workshop moved to accounts
  agent.ts, Settings.tsx     which agents make views, tried in the teacher's order: the server's, Claude Code through
                             the Claude bridge, Ollama through the Ollama bridge (experimental), Gemini's free tier
  api.ts                     the server's API

packages/workshop/           shared by the panes:
  draft.ts, viz.ts           a view's draft as ymls (`view@3` and its members), a viz as its `viz@1` yml
  work.ts                    a draft as a conversation works on it, per kind (`Work`): what the agent is sent, where
                             what comes back goes, and the page's own check after a turn (`settle`)
  Preview.tsx                compiles a draft's view in the browser and runs it in a frame, as any view runs
  Chat.tsx                   one conversation about one draft of any kind
  agents/                    what an agent backend is; the teacher server's (a job over HTTP, jobs.ts); Claude Code
                             through the Claude bridge (bridge.ts); a local model through the Ollama bridge, on the same
                             protocol (ollama.ts); Gemini's free models from the page (gemini.ts); each kind's
                             contract (kinds.ts); the agents'
                             tools (tools.ts); the templates sent with each turn (template.ts)
  agent-template/            what the agents work against: `brief.md` (who for), `kinds/<kind>.json` (what each kind's
                             agent is told, which paths are the draft, the check's description: read by the server's
                             agent too), a view's contract (CLAUDE.md) and examples, the lesson planner's instructions
packages/check/              the `check` tool, run in the page (and in Node, by the tests)
installables/claude-bridge/  runs `claude -p` on this computer for a site the person allowed
installables/ollama-bridge/  the same protocol, with an Ollama model asked with tools in a loop (experimental)
```

## Kinds

| kind | what it holds | agent | goes out |
|---|---|---|---|
| `view` | a `view@3` yml and its members | either | to a class, as a lesson; to the public site, reviewed |
| `viz` | one `viz@1` yml and its blobs | either | to a class, as a lesson (the vizint view on it); to the public site, reviewed |
| `sequence` | one `sequence@1` yml: steps, each another view or viz draft, with at most one rule | either, to plan the split; then each step as its kind | to a class, as a lesson of several views |

A draft's id is its view's or viz's. The server checks each kind ([`web/server/src/validate.rs`](../../../server/src/validate.rs)):
a viz's draft holds its viz and nothing else.

A draft is previewed in the context it would go out in. A teacher's view runs as a lesson does: the core's gestalts
and the lesson models (`distributions/teacher.yml`, the server's `MODELS`). A **maintainer**'s (a role on the account,
`gestalts-teacher admin grant-maintainer`) runs as the public site's learning views do: every model package in the repo
and the plugins' decks beside it (`distributions/workshop.yml`), with more room. The server judges a maintainer's
drafts by every model package, and still publishes one to a class only within the lesson models. A viz is shown by
the vizint view, as the public site shows it.

A lesson of several views is checked as a whole by the server (`GET /api/drafts/<id>/sequence`, `web/server/src/sequence.rs`):
every step's view is there, every rule's concept is one a step's view practises, and a warning when no earlier step
practises a rule's concept (on a new device such a rule never applies, so a short check step comes first). A viz step practises nothing, so no rule depends on it; it plays in the vizint view. The agent **plans** it, whichever is picked in Settings: one answer at low effort (`AgentBackend.complete`: the
server's `POST …/agent/complete`, or a Claude Code run through the bridge with no tools and nothing kept), its
instructions in `agent-template/plan-lesson.md`. `planLesson` (`packages/workshop/src/plan.ts`) checks what comes back
the same for both: one view instead, or the steps (each a view or a viz) with their briefs and rules; it drops a rule no earlier step can
feed, and appends to each brief what ties the view to the rules (its concepts as
`concept@2` data, practice logged on them, `done()`). Taking the plan makes each step a draft of its kind with its brief as
the draft's, built when the teacher asks its chat to, one at a time. The steps can be edited in the form besides. Its
**play-through** walks it for a pretend student who is new, knows a concept, or struggles with it
(`packages/workshop/src/sequence.ts`, `walk`, the same decisions the player makes).

Each draft can be downloaded as a zip of the folder the server keeps (a folder a gestalts node opens).

Drafts were kept in this browser before the workshop moved to accounts (the `drafts` folder of the `learning-workshop`
distribution, from `/make` and `/make-viz`). The workshop offers once to move them; each keeps its id and package, and
the copy here stays.

## Every draft: brief, chat, check

A draft keeps its **brief** (`spec`): what it should be, in the teacher's words. It's edited above the chat, kept with
the draft, and every turn sends it, as `SPEC.md`, which the agent reads and can't change. Once there is one, the chat
offers *Build from the brief* as a message of one click.

A turn is the same for every kind and either agent (`Chat` over `Work`): the draft as files and the brief go out, the
files the turn changed come back and are written, what couldn't be saved goes with the next message. Then the kind
may check what's there itself (`settle`): a viz is built and rendered in the page, and its page kept only when that
passes. Which agent runs the turn is Settings': the server's (API calls, within the account's budget) or Claude Code
through the Claude bridge (the teacher's own plan, no API tokens), which is how anything is tried locally for free.
Experimental: a local Ollama model through the Ollama bridge. The page sends it the same as the Claude bridge, and
it runs its own file tools on the files in memory ([its README](../../../../installables/ollama-bridge/README.md)).

Settings lists the agents in an order the teacher sets, each switched on or off: a turn goes to the first one
switched on that's available (`usePickedBackend`, asked again when a turn ends and when the window comes back). Each
keeps its own conversation of a draft, so when another takes over, the chat shows that one's.

Gemini runs in the page, on the teacher's own AI Studio key, which stays in this browser and goes only to Google
(`agents/gemini.ts`). Its loop is the Ollama bridge's in TS: the same file tools on the files in memory, then the
kind's page tools (`check`, whose screenshots go along as images, and `ask`, which waits while the turn runs, as on
the bridge). Free-tier quotas are per model, so the models are a chain fixed in code (`GEMINI_CHAIN`, after theadoc's):
each request goes to the first one not paused. A 429 pauses that model (an hour for a daily quota, else its
`retryDelay` or a minute; a 503 for 30 s), remembered in this browser, and the same request goes to the next. When
all are paused, a pause up to a minute is waited out; a longer one ends the turn, and the agent is unavailable until
then, so the next one in Settings takes over. The conversation lives in the tab: a reload starts a new one. None of
it touches the server or its budget.

## A view's draft

A draft is a `view@3` yml and its `members`: `gestalt@1` definitions of its own gestalts (named in the draft's
`package`) and the ymls it ships with. What the view writes while it's tried out isn't a member. A `view@1` reads as
a draft without members, a `view@2` as one without a brief; either is written as a `view@3` when it's next saved.

A turn with the bridge: the browser sends the bridge the draft as files (`view.tsx`, `view.json`, `gestalts/<name>@<N>.yml`,
`data/<id>.yml`), its brief (`SPEC.md`), the template (the contract, the examples, and the sources of what a view may import, under
`node_modules/@gestalts/*/src`), and any errors the preview reported or the last save refused (`runtime-errors.md`).
Claude reads and edits them in the bridge's workspace for this draft. Its `check` tool comes back to this page, which
runs `@gestalts/check` on the draft as it is then: the compile the preview does, a typecheck (TypeScript in a worker,
on types recorded by `packages/check/scripts/pack.ts`), `view.json`, `gestalts/`, `data/` and the npm imports pinned.
At the end the bridge hands back the files that changed; the browser turns those into ymls and writes them,
definitions first. What the repo refuses goes with the next message. The agent never touches any data, and the check
is the app's, whichever model runs the turn.

The agent may ask (the `ask` tool, `agent-template/ask.json`): a card of options in `Chat`, always with a field for
an answer of one's own. With the bridge, it's a tool of the page like `check`: the run waits for the answer, for as
long as the bridge waits on a tool (ten minutes), and the card closes with the run. The server's agent ends its turn
on it instead and keeps the question with the draft, so it can be answered later, from another device.

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
turn's process outcome (`completed`, `failed` or `cancelled`), how each page tool's last call came out (`verification`,
by tool: the bridge knows none of them) and permission warnings. Wall and
provider timings, token/cache usage and tools belong to that run. Claude's API time, cost and model usage are cumulative
for a resumed session, so they live under `session_totals`; reports count only the latest totals for each session.
`raw/<date>/<run>.jsonl` contains the complete Claude stream with receipt timing, including assistant and tool content;
it is private local data and is kept until manually deleted. Prompts and view files are not copied into the normalized
record. Older record schemas are left untouched and ignored by the report.

Run `mise run workshop:agent-stats`, optionally followed by `-- --days N`, `--view ID`, `--limit N` or `--json`, to summarize
the journal. A failed logging write is reported on the bridge's stderr but never changes the turn's result.
