# Workshop architecture

Workshop is the signed-in preview and publishing surface for view drafts. The [MCP connector](../../../server/doc/mcp.md) supplies authoring tools to Claude and ChatGPT. The OAuth consent page is at `/workshop/connect`.

Each draft opens its own OPFS store and syncs with its account's server folder. The preview compiles its source into a sandboxed frame and reports diagnostics to the server. The brief is kept on the view. The activity pane shows recent MCP runs and lets the author rate them.

The publish menu builds a versioned lesson on the lesson origin. The public-site menu submits the server's checked copy for [catalog review](../../../../doc/architecture/publishing.md). The [local CMS](../../../../doc/operations/cms.md) owns review, source edits, and local model jobs.

Existing visualization decks and lessons use the public player. The [viz roadmap](../../../../doc/roadmap/README.md#viz-authoring-over-mcp) tracks authoring.
