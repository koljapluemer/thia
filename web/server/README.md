# Thia server

The server handles accounts, draft sync and validation, MCP, submission snapshots, and lesson links. The [public site](../site) supplies the player. The [local CMS](../../doc/operations/cms.md) handles submission decisions and run inspection through direct file and SQLite access.

Use `mise run just dev` for the whole stack or `mise run server:serve` for the API on port 7740 and lessons on port 7741. Sign up in the browser with the beta code. The full dev stack defaults to `local-beta`. See [MCP](doc/mcp.md) and [deployment](deploy/README.md).
