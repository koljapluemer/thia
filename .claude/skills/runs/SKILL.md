---
name: runs
description: Investigate recorded workshop agent runs (Claude bridge, Ollama, Gemini, the server's agent) - find runs by backend, model, outcome, rating or time, and work out what went wrong or how backends compare. Use for "look at the bad runs", "why did claude fail on X", "compare backends this week", a run id, or /runs.
---

# Investigating agent runs

Every workshop turn is recorded (`web/app/doc/workshop/runs.md` says what each event means). Read it with
`thia-server admin runs`, never by opening the jsonl or blobs yourself: the raw stream runs to megabytes.

## Where

- **Production** (the default when the user means real use): `ssh "$THIA_HOST" sudo -u thia
  /opt/thia-server/current/bin/thia-server --data /var/lib/thia-server admin runs …`. If `THIA_HOST` isn't set, ask
  for it. The commands exist on the box only once a deploy with them went out; if `runs` is unknown there, say so.
- **Local** (dev runs): `mise run server:admin runs …`, or the built `target/debug/thia-server --data server-data admin runs …`.

Backend ids: `claude-cli` (Claude Code through the bridge), `ollama`, `gemini`, `server`.

## Commands

- `summary [filters] [--by backend|model|kind|purpose|day|draft|app-commit|server-commit|bridge-commit|provider-version]`:
  counts, outcomes, check, wall time, rating, cost
- `list [filters] [--limit N] [--json]`: one line a run, newest first
- filters: `--since 7d|2026-11-16 --until … --backend … --model … --kind … --purpose turn|complete --outcome
  completed|failed|stopped --rated yes|no --rating-min N --rating-max N --draft … --app-commit … --server-commit …
  --bridge-commit … --provider-version …`
- `show <id> [--full]`: facts, what it was sent (message, brief, file names), the timeline: texts, tool calls, tool
  results, usage, files written, errors, the rating and notes. No raw stream.
- `diff <id> [path]`: what it changed against what it was sent
- `stream <id> [--grep RE] [--full]`: the provider's raw stream. For Claude Code, its own tools (Read, Edit, Bash,
  permission decisions) are only here.
- `blob <sha>`: one content (a file, a screenshot: write it to the scratchpad, then look at it)
- `note <id> --by <admin email> "…"`: **writes**; only when the user asks

## How to go about it

1. `summary` over the period to see the shape, then `list` with the filters the question names.
2. `show` each run in question. Most causes are visible here: a failed tool result, a failed check, a turn that
   ended on a question, an error, a long gap, nothing written (`files` missing), the rating's comment.
   Compare its app/server/bridge commits and provider version with later runs before deciding an issue still exists.
3. `diff` when what it built is in question; `stream --grep` only for what `show` leaves open (a permission turned
   down, a stop reason, what Claude Code read).
4. Report by cause, not by run: each cause, the run ids it covers, the evidence (a quoted line), and where in the
   code it comes from when you can tell (the bridge `installables/claude-bridge/`, the page's tools
   `packages/workshop/src/agents/`, the template `packages/workshop/agent-template/`). Say how many runs you read
   and which you didn't.
5. Offer notes on the runs (the user decides), so what you found shows in `/runs`.
