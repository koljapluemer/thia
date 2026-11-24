# thia from a chat app (MCP)

A person can make and fix views from a conversation in Claude (claude.ai, the desktop and mobile apps) instead of
the workshop's chat. They add thia as a **custom connector** (Claude: Settings → Connectors → Add custom connector,
with `https://<app domain>/mcp`; free plans allow one) and allow it once in the workshop. Then Claude works on their
drafts with the same tools and the same contract as the server's own agent. The person watches the draft in the
workshop, which syncs every few seconds while Claude works on it, and rates each request there. Claude runs the
model, the loop and the questions to the person, on the person's own plan, so the agent budget isn't used.

For now only **views** can be worked on: a viz's built page and still are made in the page after each change, which
a chat app has no page for.

## Endpoints (`src/mcp/`)

| | |
|---|---|
| `POST /mcp` | JSON-RPC over Streamable HTTP, always answered as JSON (no streams): `initialize` (opens a session, `Mcp-Session-Id`), `ping`, `tools/list`, `tools/call`; a notification gets 202. Protocol versions `2025-11-25`, `2025-06-18`, `2025-03-26`. An unknown session gets 404, and the host initializes again (sessions are in memory: a restart ends them) |
| `DELETE /mcp` | ends the session, and the run it was on |
| `GET /mcp` | 405: the server sends nothing unasked |
| `/.well-known/oauth-protected-resource[/mcp]`, `/.well-known/oauth-authorization-server` | where to sign in (RFC 9728, RFC 8414), named after the origin the proxy says (`X-Forwarded-Host`/`-Proto`) |
| `POST /oauth/register` | dynamic client registration: a public client (`none`, PKCE only) or one with a secret; https redirect URIs, or http on localhost; at most 200 an hour, and clients that never got a token go after a day |
| `GET /oauth/authorize` | checks the client and its redirect, then sends the browser to `/workshop/connect?<the same query>` |
| `POST /oauth/token` | `authorization_code` (with `code_verifier`, S256; a code is used once, a wrong verifier spends it) or `refresh_token` (rotated); an access token lasts an hour, a refresh token 30 days |
| `/api/oauth/client`, `approve`, `deny` | the consent page's (signed in with the cookie): the app's name, then a code back to the app, or `access_denied` |
| `/api/oauth/connections`, `DELETE …/{client}` | the apps allowed, for Settings, and disconnecting one: its tokens go at once. A new password does the same for every app |
| `POST /api/drafts/{id}/diagnostics` | what the workshop's preview reports for the draft's current source (nothing: it runs fine) |
| `GET /api/drafts/{id}/mcp` | whether a chat app works on the draft now (a call in the last two minutes), and its last ten requests there, to rate |

`/mcp`, `/oauth/*` and `/.well-known/oauth-*` are at the root of the app's domain (the Caddyfile routes them) and allow
any origin (CORS), since they take bearer tokens, never cookies. A token only ever reaches `/mcp`, and through it only
the account's own drafts: nothing publishes, submits or administers. Tokens and codes are kept as sha256, like
sessions. Tool calls are limited to 120 a minute per account (the check runs in the worker).

## Tools (`src/mcp/tools.rs`)

The drafting tools every agent has (`list_files`, `read_file`, `write_file`, `edit_file`, `delete_file`, `search`,
`check`, from `crate::drafting`), each with a `draft` argument, and the host's own:

- `list_drafts`, `new_draft {title, lang}`: a new view draft, made as the workshop makes one (`createDraft`, in the
  worker)
- `open_draft {draft, request, have_contract?}`: at the start of each request. It gives the contract (the brief, the
  tools' paragraph and the kind's `CLAUDE.md`, as `KindRef::system` makes it for this driver), unless the conversation
  has it already. It also gives the draft's files, its brief and what the preview reports
- `set_brief {draft, brief}`: the draft's `spec`
- `finish {draft, note}`: the request is done

The server keeps ymls; the agent sees files. The worker maps one to the other as the page does (`files-of`,
`apply-files`, `new-view`, `set-spec` in `worker/worker.ts`, over `filesOf`, `applyFiles`, `saveDraft`, `createDraft`,
`saveSpec`). Each write is applied at once through the draft's one way in (`AppState::write_ymls`: the global write
lock and `validate::check`), all or nothing. A refused write is the tool's error, with why, and nothing of it is
written. An open workshop tab gets the change through its sync, merged like any other.

`check` is the worker's check of the files, followed by what the workshop's preview reported. That report is left out
when it's older than the last change, or when no tab has the draft open, and the result says which.

## Who runs the loop: `crate::drafting`

The draft's tools and the contract are shared (`drafting/contract.rs`, `drafting/workbench.rs`). What differs by who
runs the agent's loop is one `Driver`, read by the code that runs it:

| | server's agent (`SERVER_AGENT`) | chat app (`MCP`) |
|---|---|---|
| loop, model, conversation | thia's, on its API key (`agent.rs`) | the app's |
| asking the person | the `ask` tool; the answer is the next turn's | in the app's own conversation: no `ask` tool |
| files | sent by the page with the turn; changes saved by the page at its end | the server's ymls; each write saved as it's made |
| tokens | known, within the account's budget | unknown, not budgeted |
| the run's record | written by the page | written by the server (`runs::server_run`) |

Another chat app, or a page-driven agent the server records, is another `Driver`, not another code path.

## Runs

Each request is a run in `runs/`, of backend `mcp`, recorded by the server (`runs/server_run.rs`) in the page's own
format, so `/runs`, `admin runs` and the `runs` skill read it like any other.

- A run starts at `open_draft`, or at the first call on a draft when the app didn't open it (`implicit`). It ends with
  `finish` (`ended: finish`), the next `open_draft` (`next`), a call on another draft (`other-draft`), the session's end
  (`closed`) or 15 minutes without a call (`idle`, the sweeper in `main.rs` and before each request).
- Its `start` says what was asked (`message`), the session (`session`, also an index column: one conversation spans
  several runs), `newDraft`, the preview's report, the app (`backend.label`, `provider.name/version` from
  `clientInfo`), and `inputs`: the files, the brief, and the contract as the app got it (`system`).
- Then `tool` and `tool_result` for each drafting call, `files` for each write saved, `saved` for each refused,
  `spec` for a new brief, the `finish` note as `text`, and `end`.
- There's no `usage`: the app doesn't say what the model used. Tokens and cost stay empty, and runs are compared by
  check passed, tool failures, refused writes, wall time and rating.
- The person rates a run in the workshop (`POST /api/runs/{id}/rating`): the server gives it the run's next seq.

## Trying it locally

claude.ai reaches thia only over public https, so a tunnel goes in front of the make app's dev server, which passes
`/mcp`, `/oauth` and `/.well-known/oauth-*` on to the server, as it does `/api`. Nothing runs twice:
`mise run just dev` already starts the server and the make app.

1. `mise run just dev`. Note the make app's port in the overview: 5173, unless that was taken.
2. In another terminal, `cloudflared tunnel --url http://localhost:5173` (or the port it got). It prints a host,
   `<name>.trycloudflare.com`. The dev server answers those hosts. For another tunnel, start step 1 with
   `THIA_DEV_HOST=<its host>`.
3. Check that the tunnel reaches the server: `https://<name>.trycloudflare.com/.well-known/oauth-authorization-server`
   shows JSON in which every URL starts with `https://<name>.trycloudflare.com`. If so, go on. If they name
   `localhost` or `127.0.0.1`, Claude can't sign in through them. If there's no JSON, the tunnel points at the wrong
   port (step 1).
4. In Claude: Settings → Connectors → Add custom connector, `https://<name>.trycloudflare.com/mcp`, then Connect.
   After a failed try, remove the connector and add it again.
5. Claude opens thia's consent page on the tunnel's host. Sign in there (the cookie from `localhost` doesn't count
   there; the dev account is in `server-data/dev-login.txt`) and allow it.
6. Ask Claude for a view, with the draft open in the workshop (`localhost:5173/workshop` is fine): the preview follows
   within seconds, and Claude's requests are listed above the brief to rate.
7. `mise run server:admin runs list --backend mcp`, then `runs show <id>`.

A quick tunnel gets a new host each time it starts: then the connector in Claude needs the new address.

Without Claude and without a tunnel, the MCP Inspector (`npx @modelcontextprotocol/inspector`) connects to
`http://localhost:5173/mcp`.
