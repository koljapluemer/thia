# thia

Views on top-of semantic yml to represent a wide range of interactive learning experiences.

```
crates/       the core (Rust, also in the page as wasm), merge, fs, peer sync, the node
packages/     what apps and views build with: client, host, view (the view contract), kit, learning, sources, vite, viz,
              check (what an agent's work is checked with), workshop
gestalts/     gestalt definitions: the core's, and model packages (gestalts/<package>/<name>/)
plugins/      the views (and their decks, workers), one folder each, usable by any app
sdk/python/   what plugin workers import
web/
  site/                 the use app: every view (on its decks), the user's notes, curricula; data in the browser;
                        also plays published lessons' links on the lesson domain
  app/                  the make app: the workshop, the review, agent runs; behind an account
  server/               the server (thia-server), its worker, docs and deploy/
installables/           optional, on the user's computer
  folder-sync/          gestalts-node: a folder synced with the app; desktop/ (tray), settings/
  claude-bridge/        lets a site you allow run Claude Code here, with the site's tools (the web app's agents)
  ollama-bridge/        the same with a local Ollama model, experimental
scripts/      shared by the tasks
```

from `plugins/` and their models from `gestalts/`, by `scripts/check-distributions.ts`. Both run in `mise run check`.

## Developing

Needs [mise](https://mise.jdx.dev) and [rustup](https://rustup.rs). mise installs Node, pnpm, uv, wasm-pack and the
packaging tools as pinned in `mise.toml`; rustup picks up the Rust version (and the wasm target) from
`rust-toolchain.toml`.

```sh
mise run just setup   # a new machine: the pinned tools and Rust, dependencies, the core in wasm, a local
                      # account; again after pulling
mise run just dev     # the web app, the public site, the claude and ollama bridges, folder-sync and the server with hot reload:
                      # where each is, their output in target/dev/<name>.log
```

The rest is hidden from `mise tasks` (`mise tasks --hidden` lists it), for one-offs and agents:

```sh
mise run check                                    # tests, lints, typechecks, deck health
mise run web:dev                                  # the web app alone, hot reload
mise run site:dev                                 # the public site alone, hot reload (site:build: static files)
mise run claude-bridge                            # the Claude bridge alone, headless; localhost pages may use it
mise run ollama-bridge                            # the Ollama bridge (experimental) alone, the same way
mise run node                                     # folder-sync headless: plugin backends, /net, /llm
mise run node:dev                                 # the desktop node and its settings page, hot reload
mise run publish-data plugins/<id>/decks/<deck>   # after editing a plugin's deck
mise run health-data ~/some-folder                # which ymls can't be used, and why
mise run serve ~/some-folder                      # the node headless with the repo's plugins
mise run server:deploy                           # the server and app to its box (web/server/deploy/README.md)
mise run claude-bridge:install                    # the Claude bridge installed here, as a user gets it
```
