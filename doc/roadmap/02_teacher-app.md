# The app for teachers: what's left

From discussions on 2026-11-16, 2026-11-17 and 2026-11-22. Built and documented: accounts made by admins, drafts of
each kind on the server, both agents, asking, lessons of several views, previews under the closed CSP with npm from
our own origin, publishing by link to the player on the lesson domain, unpublishing, "start fresh", a minimal
submission and review ([`web/server/doc/architecture.md`](../../web/server/doc/architecture.md),
[`web/app/doc/workshop/architecture.md`](../../web/app/doc/workshop/architecture.md),
[[../architecture/publishing|Publishing]]). What follows is what isn't.

The product is the new view: teachers come for bespoke interactive experiences, not quiz content on stock views, so
everything optimises for making, running, versioning and reviewing new views. First users are teachers and students
in Germany ([[00_i18n|Languages]]).

## In the classroom

- **A QR code and a short code**: shown on the projector, short-lived (a lesson, a day), rate-limited, resolving only
  to the long link.
- **Rotating a link**: a teacher replaces it or lets it expire, beside switching it off (built).
- **An offline player**: the player as a PWA, so a lesson opened once survives the school wifi.
- **Changed gestalts between versions**: a new version that changes the lesson's gestalts must still read the old
  ymls on students' devices or start fresh and say so; publishing compares the two and warns.
- **Seeing what it built** for views: compile and typecheck say little about an interactive view. The agent gets
  screenshots and runtime errors of a view as it gets them of a viz (`worker/render.ts`), within the budget.
- Later, if forwarded links matter: a passphrase, or a key in the URL fragment with the lesson encrypted at rest.
  Real access control comes with student accounts or LMS logins (LTI 1.3 and the German school platforms).

## Lessons of several views, later

- Rules *repeat until* and *optional*; a free order for students; thresholds a teacher sets.
- A step that is a view with a deck of its own, so one view serves many lessons; steps from the public site.
- Steps on different runtimes.
- A cheaper model for the split, if an eval says it holds.
- The chat itself: rendering, tool calls folded together, scrolling, a transcript kept with the draft.
  assistant-ui over `AgentBackend` and Streamdown are the candidates.

## Security

- **`reads` and `writes` widen without a prompt** in the workshop. Fine for its author; not when a colleague runs a
  shared view against their own data. Opening someone else's view shows what it declares and asks.
- **Never for teacher code**: `same-origin` grants, `backend.py`, and `llm` in published lessons (our money, and
  minors talking to a model). The player refuses them.

## Schools and sharing

Every draft, lesson and publication has an owner and a school from the start, even before the UI uses it. Sharing
with a colleague is a copy that records its origin, like the workshop's remix; never live co-editing, which would
need permissions per yml. Later a school library is a read-only layer under a teacher's folder, as decks are now.
Sign-in through OIDC, so school logins can plug in.

## Offering a lesson for the public site

Built minimally ([[../architecture/publishing|Publishing]]). Still to do, before the human review:

1. deterministic gates: actual against declared network use, imports, bundle size, and a performance budget on a
   low-end device profile
2. an AI review of kit and gestalt usage, advisory only

And two things that are real work, not checks:

- **Concepts** a teacher made have to map onto the site's own, or what learners know splits in two.
- **Namespaces**: the lesson's gestalts move from the teacher's namespace into a canonical one, beyond the reviewer
  naming the package.

Updates come back as new submissions against the recorded origin hash, never as sync. Content made for a class isn't
automatically publishable: § 60a UrhG covers using textbook material in class, not publishing it, so the teacher
affirms the rights on submit and review looks for it.

## Footguns

- **Kit changes** break code we didn't write. Published lessons pin their runtime; a runtime bump should offer an
  agent turn that migrates a draft, with `check` as the judge.
- **Safari deletes script-written storage** after 7 days without a visit, so progress kept on the device is lost over
  a holiday: ask for persistent storage, offer an export, say so in the UI.
- **School hardware**: a three.js view that's smooth on a laptop can be unusable on an old class iPad. A device budget
  in the agent's contract and in the checks.
- **Personal data in content**: teachers paste names, class lists and screenshots, which go to the model provider.
  A processing agreement, a line in the terms, and retention for what the agent sees and what `runs/` keeps.

## Order

1. The classroom: QR and short codes, rotating, the offline player, screenshots of views for the agent.
2. Schools: owners and schools in the UI, sharing as copy, a school library, OIDC.
3. Submissions: the gates, the AI review, concept and namespace mapping.
4. Perhaps: results for teachers, with student accounts. Minors' data, a DPIA and school contracts: a separate,
   deliberate project, not a feature.
