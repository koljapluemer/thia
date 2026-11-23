# Agent runs: the record, and `/runs`

Every agent turn in the workshop is recorded, whichever backend runs it (the server's, Claude Code through the Claude
bridge, Ollama through the Ollama bridge, Gemini in the page), so the agents can be compared and improved from what
they actually did. The page records, since every turn passes through it (`runTurn`, `packages/workshop/src/turns.ts`);
the server keeps the record (`web/server/src/runs/`); admins read it in `/runs`.

## What a backend sends

A turn is a stream of `AgentEvent`s (`packages/workshop/src/agents/types.ts`). The conversation's events (`text`,
`tool`, `files`, `ask`, `done`, `error`) are what the chat shows. Four more are for the record alone, and each backend
sends what it can of them:

| event | what | sent by |
|---|---|---|
| `usage` | one model request: `model`, `input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`, `ms`, `billing` (`api`, `subscription`, `free`), `costUsd` only when the provider says what the request cost | the server (each Messages call), the Claude bridge (each assistant message, once: the stream repeats a message per block), the Ollama bridge (`prompt_eval_count`, `eval_count`, `total_duration`), Gemini (`usageMetadata`, `modelVersion`: the model of the chain that answered) |
| `tool_result` | how a tool call came out: `name`, `ok`, `ms`, `content` (texts, screenshots) | whoever runs the tool: the page for its own tools on the bridges (`timed`, `agents/tools.ts`), the server for all of its agent's, the Ollama bridge and Gemini for their file tools. Claude Code's own (Read, Edit…) are only in its raw stream |
| `throttle` | a request turned away for now: `model`, `status`, `waitMs`, `reason` | the server (each retry), Gemini (each model paused after a 429 or 503) |
| `trace` | the provider's answer as it came: `source`, `data` | the server (each response), the Claude bridge (every line of `claude -p`'s stream-json, and stderr), the Ollama bridge and Gemini (each reply) |

`done` may also say the backend's own `outcome` (`completed`, `failed`, `cancelled`) and the process's `exitCode`
(the Claude bridge). Every field is optional: a backend that knows less sends less, and a new one needs nothing here
but to send what it knows.

## The record

The recorder (`packages/workshop/src/runs/`) writes each run as events in an envelope,
`{v: 1, run, seq, at, ms, type, …}`: `seq` its place in the run, `at` the time, `ms` since the run began (an event's
own `ms`, a tool's or a request's duration, is kept as `took`). The page adds its own events around the backend's:

- `start`: `purpose` (`turn`, or `complete` for a one-off answer such as planning a lesson), `draft`, `kind`,
  `backend` {id, label}, `message`, `session`, `answer`, `diagnostics`, `gestalts`, and `inputs`: the draft's files,
  its binaries, its brief and the kind's template, the way it was sent
- `saved`: what saving refused of what came back; `settled`: what the kind's own check said after the turn
- `end`: `outcome` (`completed`, `failed`, `stopped`) and `waiting` (the turn ended on a question)
- `rating`: `score` 1–5 and `comment`, from the row after the turn in the chat ("How good was this?"); rating again
  adds a newer one, the latest counts

Contents go to blobs by sha256, `{$blob, bytes}` in place of the text: the files sent and changed, images, tool
results over 4 KB, and any text over 16 KB. A draft's files and the template barely change from turn to turn, so a
turn costs little more than what changed, and every run can be put together again (Export) and tried again later.
A run's raw stream is kept up to 32 MB, then a `trace` says the rest was left out.

Recording never gets in a turn's way: events are sent a second after they come, or sooner past 256 KB, the rest
when the turn ends or the page goes (`keepalive`); a send that fails is tried again, and after five failures in a row
what's waiting is dropped, with a warning in the console. Signed in, the workshop records to the server
(`web/app/src/workshop/runs.ts`, `recordRunsTo`); the Settings test of an agent isn't recorded.

## On the server

```
server-data/runs/
  <yyyy-mm-dd>/<run>.jsonl     each run's record: appended to, never rewritten
  blobs/<aa>/<sha256>
thia.db  runs                  the index: derived, made anew from the records whenever it's of another version
```

`POST /api/runs/{id}/events` takes a batch: only events of that run, of the page's own kinds, by the account that
started it, on a draft of its own. A `seq` already kept is dropped, so a batch sent again counts once, and one that
arrives out of order is kept. The server writes two kinds itself, with seqs below zero and `by`: `owner` (whose run
it is, the first line) and `note` (an admin's). Blobs: `POST /api/runs/blobs/missing`, then `PUT
/api/runs/blobs/{sha}`, which checks the hash.

The index (`runs/index.rs`) is one row per run, folded from its lines: times (wall, first output), outcome, models,
tokens, cost, tool calls and failures, the last check, files changed, errors, the latest rating, notes. Unknown event
types count as events and no more. Cost is derived, never recorded: tokens × Anthropic's list prices in
`runs/prices.rs` (dated), `api` billing what was paid, `subscription` what it would have cost (notional, shown as ≈),
`free` nothing, and a model without a price is counted as unpriced. Changing what the index derives, a price
included, is a change of `index::VERSION`: the server rebuilds the index from the records when it starts.
`thia-server admin reindex-runs` (`mise run server:admin reindex-runs`) does it by hand.

## `/runs`

An admin area (`web/app/src/runs/`). What's picked is kept in the address, so a view can be linked.

- **Filters:** period, backend, model, kind, purpose, outcome, rated, draft.
- **Summary**, by backend, model, kind, purpose, day or draft: runs, completed, the check passed, wall time (median,
  p90), first output, requests, tokens, cache, cost paid and notional, the mean rating and how many rated, tool
  failures.
- **The runs**, newest first, a page at a time.
- **One run:** its facts; what it was sent (message, brief, errors, the draft's and the template's files); the
  timeline, every event with when it came and the gap before it, tool results with their screenshots; what it changed,
  as a diff against what it was sent; the backend's raw stream, loaded when opened; notes, for writing down what went
  wrong (the start of finding what to improve); Export, a zip of its record and blobs.

Everything is loaded in pages or when opened: no list or record is read whole.
