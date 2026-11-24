# codex-bridge

`gestalts-codex-bridge` lets a website you allow run the locally signed-in Codex CLI with files and tools supplied by the page. The make app's workshop can select it as an AI backend.

- Install Codex and sign in once with `codex login`.
- Run headless for development with `mise run codex-bridge`.
- Build installers with `mise run codex-bridge:package`.
- Override discovery with `GESTALTS_CODEX=/path/to/codex`.

The bridge listens only on loopback (port 7739 by default), requires per-origin pairing outside development, runs Codex without personal project configuration, disables network access, and limits filesystem access to the generated workspace and Codex runtime files.
