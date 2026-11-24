# MCP run records

The server records MCP activity under `runs/<day>/<run>.jsonl`. The derived SQLite `runs` index supports inspection in the [local CMS](../../../../doc/operations/cms.md). File contents and large tool results are stored in content-addressed blobs under `runs/blobs/`. Historical browser and server agent records remain readable.

Workshop lists the owner's recent MCP runs for a draft and lets the owner rate them. Run events record inputs, tool calls and results, file changes, diagnostics, and completion. Model usage is unavailable from the chat host.

Use `mise run server:admin runs list|summary|show|diff|stream` for terminal inspection on the machine holding the data. `mise run server:admin reindex-runs` rebuilds the derived index from the JSONL files. Local model jobs persist separately under `target/cms/jobs/`.
