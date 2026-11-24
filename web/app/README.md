# Workshop

The signed-in view workspace lives at `/workshop`. Authors connect Claude or ChatGPT through `/mcp` and authorize access at `/workshop/connect`. Workshop shows the draft preview, brief, MCP activity, and publishing controls. See the [MCP guide](../server/doc/mcp.md) and [catalog publishing](../../doc/architecture/publishing.md).

Use `mise run just dev` for the local stack or `mise run web:dev` for Workshop alone. The production build serves assets under `/make/` beside the public site.
