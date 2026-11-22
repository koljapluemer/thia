# A visualization's draft

A viz is a draft of the workshop ([`architecture.md`](architecture.md)) of kind `viz`: one `viz@1` yml, with the
draft's id, and its blobs, synced with the server.

```
src/workshop/VizPane.tsx        the editor beside the vizint view showing the viz
src/workshop/viz/Editor.tsx     a viz's title, intro, spec, outro and files; Build
src/workshop/viz/agent.ts       a build: Claude Code through the Claude bridge, then the page's own check
src/workshop/viz/template.ts    what the agent works against: packages/viz/agent/CLAUDE.md, the examples, viz-sources/
src/workshop/viz/viz.ts         a viz as a `viz@1` yml; blobs named by content
```

Only the bridge's agent builds one: its check renders the viz in the page, with screenshots, which the server can't do
yet. Without the bridge, the editor says so and offers to connect.

## A build

The spec is authoritative: a build always starts from it, with the previous `viz.ts` (if any) to keep what works.
There is no chat; to change a viz, change its spec and build again.

1. The browser saves the texts. It sends the bridge the template, `SPEC.md`, the previous `viz.ts`, a `package.json`
   with the viz's packages, and `files/` as bytes. Only `viz.ts` and `package.json` are the draft (`keep`).
2. `claude -p` reads and edits the workspace. Its one tool is `check` (`vizCheckTool`), which the page runs with
   `@gestalts/check`:
   - typecheck (TypeScript in a worker)
   - the viz's `checks` (in a sandboxed frame)
   - the build into one offline page (esbuild-wasm, the runtime's recorded sources, npm packages from esm.sh)
   - a render at 360 and 1000 px, light and dark, in sandboxed frames that reach nothing, with a screenshot of each
     for the agent
3. When the turn ends, the page checks what came back itself. Only if that passes does it store the page and the still
   (800 px wide) as blobs named by their content, with `generator`. A failed check keeps the source and the last page
   that passed. The agent never touches data.

`mise run check` runs the same check on `@gestalts/viz`'s examples in Node, without the render
(`packages/check/src/check.test.ts`).

## The public site

Once a viz is built, the **Public site** menu offers it for review: the viz yml with its page, still and files
(`src/workshop/submit.tsx`), from the server's copy. Accepted, it becomes a deck of `vizint` and an entry on the public
site ([`doc/architecture/publishing.md`](../../../../doc/architecture/publishing.md)).
