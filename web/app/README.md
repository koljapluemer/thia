# web

The make app, behind an account; each area is a path: `/workshop` (views and visualizations made with an agent, kept
on the server; any other path), `/review` (admins: what the workshop offered for the public site), `/runs` (admins:
every agent turn, [`doc/workshop/runs.md`](doc/workshop/runs.md)). Using views, and the user's notes, is the use app,
[`../site`](../site) (`VITE_SITE`), on the same origin when deployed.

- each workshop draft is its own store, synced with the server under `/api` (`VITE_THIA_API` in dev, default
  :7740), previewed in the context it goes out in (`distributions/lessons.yml` for a lesson,
  `distributions/workshop.yml` for the public site). The agent is the server's, or Claude Code through the Claude
  bridge (`VITE_AGENT_NODE`, default :7737, `mise run claude-bridge`), Codex CLI through its bridge
  (`VITE_CODEX_NODE`, default :7739, `mise run codex-bridge`), or, experimental, a local Ollama model through
  the Ollama bridge (`VITE_OLLAMA_NODE`, default :7738, `mise run ollama-bridge`), or Gemini's free tier on the
  person's own key, from the page; tried in the order Settings gives them, with the page's tools: the `check` is
  `@gestalts/check`, run here. See [`doc/workshop`](doc/workshop)
- a draft is published to a class, or offered for the public site (`src/workshop/submit.tsx`) and reviewed in
  `/review`: see [`doc/architecture/publishing.md`](../../doc/architecture/publishing.md)

From the repo root: `mise run just dev` (this, the Claude, Codex and Ollama bridges, folder-sync and the server), `mise run web:dev` (this alone),
`mise run web:build` (a static site in `dist/`, its files under `/make/`: deployed beside the use app, its
`index.html` answering `/workshop`, `/review` and `/runs`; `web/server/deploy/Caddyfile`).
