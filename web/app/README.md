# web

The one web app. `/` is a landing page with a card per area; each area is a path: `/notes` (the gestalter: notes and
installable views in tabs), `/workshop` (views and visualizations made with an agent, behind an account, kept on the
server), `/review` (admins: what the workshop offered for the public site). Notes need no node: they are in the
browser (OPFS). The learning views and visualizations, for anyone, are the public site, [`../site`](../site).

- notes are the home store and `distributions/home.yml`; the desktop node, when one
  runs (`VITE_GESTALTS_NODE`, default :7717), is asked for plugin backends, `/net` and `/llm`, and the user may sync
  with it (settings)
- each workshop draft is its own store, synced with the server under `/api` (`VITE_TEACHER_API` in dev, default
  :7740), previewed in the context it goes out in (`distributions/teacher.yml` for a lesson,
  `distributions/workshop.yml` for the public site). The agent is the server's, or Claude Code through the Claude
  bridge (`VITE_AGENT_NODE`, default :7737, `mise run claude-bridge`), or, experimental, a local Ollama model through
  the Ollama bridge (`VITE_OLLAMA_NODE`, default :7738, `mise run ollama-bridge`), or Gemini's free tier on the
  teacher's own key, from the page; tried in the order Settings gives them, with the page's tools: the `check` is
  `@gestalts/check`, run here. See [`doc/workshop`](doc/workshop)
- a draft is published to a class, or offered for the public site (`src/workshop/submit.tsx`) and reviewed in
  `/review`: see [`doc/architecture/publishing.md`](../../doc/architecture/publishing.md)

From the repo root: `mise run just dev` (this, the claude and ollama bridges, folder-sync and the teacher server), `mise run web:dev` (this alone),
`mise run web:build` (a static site in `dist/`; serve every path as `index.html`).
