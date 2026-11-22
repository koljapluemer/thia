# One workshop, and lessons of several views

Decided on 2026-11-22. Three steps, in this order: the workshops become one (built, 2026-11-22), the agent can ask
(built, 2026-11-22), then lessons made of several views (sequences; the MVP built 2026-11-22). Then views and vizzes
on one stack (built, 2026-11-22, section 4). Prior art is at the end.

## 1. One workshop

Built: `/workshop` ([`web/app/doc/workshop`](../../web/app/doc/workshop/architecture.md)). Where it went another way
than below: a viz is previewed in the workshop distribution (the vizint view, as the public site shows it), so
`teacher.yml` didn't change; a moved draft keeps its id and package; *New* offers a view and a visualization until
sequences exist.

There were three areas for making something with an agent: `/make` (learning views, local, the bridge agent),
`/make-viz` (vizzes, local, the bridge agent) and `/teach` (lessons, an account, the server's agent or the bridge).
`/make` is `/teach` without the server: the same `view@2` draft, `Chat`, `Preview` and `createDraft`. Their shells are
near-copies. A sequence has to point at views and vizzes alike, which three stores don't allow; merging after
sequences exist would mean moving them too.

What it becomes:

- **One area, behind the login.** No mode without an account and no mocked login: on a dev machine it is the account
  `scripts/setup.sh` makes (`teacher-data/dev-login.txt`). Everyone using it gets an account from the admins.
- **One list of drafts**, with *New: view · visualization · lesson*. Each kind brings its own format, editor, agent
  contract, check and template, as today: `view@2` with its members, `viz@1` (not folded into `view@2`), and
  `sequence@1` (below).
- **Drafts on the server**, checked and under quota as `/teach`'s are now. Either agent, as `/teach` lets choose now.
- **Publishing to a class is an action on a draft**, as are later classes and schools. There is no teacher section:
  what is teacher-only is small (links, short codes, classes), the rest comes with the account.
- **A maintainer role** on accounts. The server allows a draft only the core's gestalts, its own and `MODELS`
  (`web/server/src/lib.rs`); learning views read flashcards, phrasebook and the other plugins' models. A maintainer's
  drafts may use the repo's models, and get a larger quota. What a maintainer makes can't be published to a class
  unless it stays within `MODELS`: the preview runs in the context the draft will be published in, never a wider one.

Costs and what to watch:

- Distribution ids are for good. Local drafts are under `learning-workshop`; offer once to move them to the account,
  and keep the id until nobody has any.
- ~~Vizzes need the bridge agent until the server renders headless.~~ Either agent makes them now (section 4).
- Folder sync of drafts goes away (drafts are the server's); export instead.
- The workshop needs the server up.
- Scripts and agents that exercise the workshop need a session from the dev login.
- `/review` and the submission sources (`make:`, `make-viz:`, `teach:`) map onto the one workshop.

## 2. The agent asks

Built. The tool is `packages/workshop/agent-template/ask.json`, shared by both agents; the server keeps a draft's
conversation on disk with its open question. With the bridge the question lives while the run does (the bridge waits
ten minutes on a tool).

An `ask` tool for the agent, as Claude Code's `AskUserQuestion`: 1–4 questions, each with a short header, 2–4
options (label, description, an optional preview) and multi-select, and always free text besides.

- The loop pauses: the turn ends with the `tool_use` open, the job says it is waiting, and the teacher's answer is
  its `tool_result`.
- The open question is kept with the draft, not only in the job: an answer may come an hour later, from another
  device.
- `Chat.tsx` shows it as a card.
- The tool's description carries the policy, since current models can't be made to call a tool: ask only when the
  answer changes what is built and a wrong guess is costly (how a lesson splits into views, which existing one to
  reuse, which concept a detour depends on, what the student does, the class's devices); never about looks or wording,
  where building and letting the preview speak is the cheaper question; never in schema terms; mark an option
  recommended only with a reason; one card per turn, rarely more than one at the start of a draft.

The chat itself (rendering, tool calls folded together, scrolling, a transcript kept with the draft) is a separate
piece of work; assistant-ui over `AgentBackend` and Streamdown are the candidates.

## 3. Sequences

A lesson of several views, in order, some steps skipped or added depending on what the student knows. Not a graph:
a list, each step with at most one rule, read top to bottom; detours always come back. Branching stories are one view
that branches inside, not a sequence.

### In the MVP

Built. The agent writes the sequence as a plan the teacher takes or discards (one call, low effort, either agent:
`AgentBackend.complete`, checked once in `packages/workshop/src/plan.ts`): taking it makes
each step's view a draft with its brief, built one at a time when the teacher sends it; a form edits the steps
besides (`SequencePane.tsx`). The done signal is `useHost().done()`, an op the bridge answers when a host listens; no
protocol bump, since it's only added. The player shows *Next* always, as it can't know whether a view will say it's
done. *Struggling* is practised and `p` below a half.

- **A done signal** in the view protocol, with a helper in the kit. A view that never sends it gets a *Next* button
  from the player, so existing views work as steps.
- **`sequence@1`**: a title and ordered steps, each a view and at most one rule:
  - *skip if known*: a concept, known at `p ≥ 0.8` (as for set members);
  - *detour if struggling*: a concept, and a step played first before coming back.
  Thresholds are fixed. Rules name concepts, never other steps, so steps stay independent and every view feeds them
  through its `practice-event`s.
- **The player plays a sequence** under one link: a path (*step 2 of 5*), skipped steps shown with why and a way to
  do them anyway, a detour marked as extra with why, going back always allowed. One store on the device for the whole
  sequence, so beliefs build up across its steps.
- **Publishing** a sequence as a lesson: its manifest lists the steps' views; all on one runtime.
- **A sequence draft** holds `sequence.yml` and points at the account's other drafts. The agent writes it with the
  tools it has; each new step is built in its own draft, from a brief that names the concepts the rules depend on.
  `check` also checks that steps exist and the rules' concepts do, and warns when no earlier step declares writing
  `practice-event`.
- **A play-through preview**: the sequence played as a pretend student (*knows X*, *struggles with X*), showing what
  gets skipped and added.

### Before building

- Does the player compute beliefs? Yes: it runs the core on a store per lesson (`web/site/src/Run.tsx`), and a view
  that reads `concept@…` gets beliefs; rules can ask the same.
- Try the agent on a dozen realistic requests for a sequence, by hand. If its splits are poor, the rest doesn't
  matter. The split runs on the same model as the rest, at low effort: it costs little, a cheaper model saves
  nothing worth losing the cache over, and a poor split costs expensive turns later.
  Tried on 2026-11-22 (12 requests, one CLI call at low effort): the splits hold. It kept three as one view (a
  recall drill, a quiz, a branching story), split the rest into four concrete steps each, with prerequisites as
  *skip if known* and easier variants as detours. What to build differently:
  - It puts *skip if known* on the first step. With one store per sequence, nothing has been practised yet on a new
    device, so the rule never fires. `check` warns when no earlier step practises a rule's concept, and the
    contract tells the agent to start with a short check step when it wants to skip (as it did unprompted once).
  - Four steps means four view drafts to build: say so to the teacher, and build them one at a time, the first
    before the others.

### Later

- Rules *repeat until* and *optional*; a free order for students; thresholds a teacher sets.
- A step that is a view with a deck of its own, so one view serves many lessons; steps from the public site.
- Steps on different runtimes.
- A cheaper model for the split, if an eval says it holds.
- Results for teachers ([[teacher-app]]: student accounts, a separate project).

## 4. One stack for views and vizzes

Built, 2026-11-22. Views and vizzes had grown two stacks: a viz was built by a call of its own straight to the bridge,
with its own events, template, prompt and editor, no chat, no ask and no server agent; a view had all of those and no
brief it kept. Now:

- **Each kind is a contract, once.** `agent-template/brief.md` (who for) and `agent-template/kinds/<kind>.json` (what
  the agent is told, which paths are the draft, the check's description) are read by the page for the Claude bridge
  and by the server for its agent. The templates are `packages/workshop`'s.
- **One turn path.** `Chat` over a `Work` per kind, through `AgentBackend` with either agent. A viz's *Build* is a
  chat message; the page's own check after a turn (`settle`, from the viz) keeps a viz's page only when it passes.
- **A brief on every draft** (`spec`, sent as `SPEC.md`; `view@3` is `view@2` with it), and one layout (`Shell`).
- **The bridge knows nothing of kinds.** Its run log records the last result of each page tool by name, not of a tool
  named `check`. It stays the optional, local way to try any kind on one's own plan, at no API cost; the server makes
  the same things on API calls.
- **Vizzes go out to a class**, alone or as steps of a lesson, played in the vizint view (`params` in a `lesson@1`).

What has to stay apart, and why:

1. The agent loop: the server's own (API key, budget, survives the tab, questions kept on disk) and Claude Code's.
2. File tools: the server's over files it holds, Claude Code's in a workspace; so contracts never name file tools.
3. Asking: the bridge keeps the run open, the server ends the turn and keeps the question. `AgentEvent.ask.reply`.
4. Where the check runs: the page (esbuild-wasm, frames) and the server's worker (Node; a viz's render in Chromium
   or handed to the page, `GESTALTS_VIZ_RENDER`). One `@gestalts/check`, `Platform` is the seam.
5. Sessions and auth: a CLI session and a pairing token per site; a server session file, the account and its budget.
6. Preview: a view compiled in a frame; a viz's built page in the vizint view; a lesson's play-through.
7. Draft format and kept paths: `view@3` and members; `viz@1` and blobs.
8. What goes out: a view's own `lesson@1`; the vizint view on a viz; a sequence of those.

## Prior art

- **Sequencing.** General rule systems fail with authors: SCORM 2004's Simple Sequencing was widely judged too complex,
  and its successor cmi5 kept one *moveOn* criterion per unit
  ([eFront](https://www.efrontlearning.com/blog/2013/04/why-scorm-2004-failed-what-that-means-for-tin-can.html),
  [EduTech Wiki](https://edutechwiki.unige.ch/en/Cmi5)); Moodle's access restrictions confuse teachers
  ([MDL-81786](https://tracker-old.moodle.org/browse/MDL-81786)). What works is small: Canvas Mastery Paths' three
  score ranges ([Canvas](https://community.canvaslms.com/t5/Canvas-Basics-Guide/What-is-MasteryPaths/ta-p/404483)),
  testing out at Khan Academy, Duolingo's one path (and the backlash at losing the choice of order,
  [Duolingo](https://blog.duolingo.com/new-duolingo-home-screen-design)). Branching tools daunt teachers
  ([UTS on H5P](https://educationexpress.uts.edu.au/blog/2020/07/01/focus-on-h5p-benefit-branching-scenarios/)), and
  working choice-based structures are mostly a main line with branches that rejoin it
  ([Ashwell](https://www.ifwiki.org/Standard_Patterns_in_Choice-Based_Games)).
- **Asking.** Ask when the answer is worth more than the interruption
  ([Horvitz 1999](https://www.erichorvitz.com/chi99horvitz.pdf)); recent agents score questions by expected
  information gain ([Deng et al.](https://proceedings.mlr.press/v306/deng26l.html),
  [value of information](https://arxiv.org/pdf/2601.06407)). Questions with 2–5 offered answers are the norm in
  conversational search and get far more replies than open ones
  ([MIMICS](https://arxiv.org/pdf/2006.00166.pdf), [AGENT-CQ](https://arxiv.org/pdf/2410.19692)); suggestions shown
  by default anchor ([BIT](https://www.bi.team/wp-content/uploads/2025/09/How-can-LLMs-reduce-our-own-biases-Analysis-Report.pdf)).
