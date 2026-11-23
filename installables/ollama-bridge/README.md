# ollama-bridge (experimental)

`gestalts-ollama-bridge` lets a website you allow run a local [Ollama](https://ollama.com) model with the website's own
tools. To the page it is the [Claude bridge](../claude-bridge/README.md): the same `/status`, `/pair` and `/runs`
protocol, the same `start`, `tool_call`, `files` and `done`, on `127.0.0.1:7738`. The web app's workshop offers it in
Settings as "Ollama on this computer".

Inside, it's naive. It keeps the files the page sent in memory and asks Ollama's `/api/chat` with tools in a loop
(at most 40 rounds). The tools are its own file tools (`list_files`, `read_file`, `write_file`, `edit_file`,
`delete_file`, `search`, ported from the server's agent) and the page's (`check`, `ask`, handed to the page).
Writes go only to paths matching `keep`. The model is told the page's `system`, how the tools work, and the
template's `CLAUDE.md`. When it answers without a tool, the changed draft files go back. Conversations are kept in
memory, so a restart forgets them and the next turn starts a new one.

For the page's record of the turn ([`web/app/doc/workshop/runs.md`](../../web/app/doc/workshop/runs.md)), each
answer also goes back as `usage` (Ollama's token counts and time) and `trace` (the answer as it came), and each of
its own file tools' calls as `tool_result`.

```sh
mise run ollama-bridge                  # development: headless, dev profile, localhost pages allowed
gestalts-ollama-bridge serve [--dev] [--port 7738] [--profile NAME]
```

| env | default | |
| --- | --- | --- |
| `GESTALTS_OLLAMA_HOST` | `http://127.0.0.1:11434` | where Ollama answers |
| `GESTALTS_OLLAMA_MODEL` | `qwen3.5:9b` | needs tool calling; `ollama pull` it first. A `start`'s `model` overrides it |
| `GESTALTS_OLLAMA_CTX` | `32768` | `num_ctx`; one tool result is cut at 16k bytes |

`/status` returns `{app, version, ollama: {found, host, model, hasModel}, paired}`. Unlike the Claude bridge, there's
no tray, no installer and no run log yet. It sends text only: the page tools' images are left out, and a page tool
waits on its answer as long as the socket is open.
