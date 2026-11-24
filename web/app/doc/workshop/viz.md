# A visualization's draft

This document describes an earlier Workshop design. See [current Workshop architecture](architecture.md).

A viz is a draft of the workshop ([`architecture.md`](architecture.md)) of kind `viz`: one `viz@1` yml, with the
draft's id, and its blobs, synced with the server. It's made like a view: its brief and a chat, with either agent.

```
src/workshop/VizPane.tsx           the vizint view showing the viz, beside it the brief, the texts and files, the chat
src/workshop/viz/Editor.tsx        a viz's title, the texts before and after it (Markdown), the files its brief can name
packages/workshop/src/viz.ts       a viz as a `viz@1` yml; blobs named by content
packages/workshop/src/work.ts      `vizWork`: what a turn sends and writes back, and the page's own build after it
packages/workshop/src/agents/      the viz's contract (kinds.ts, agent-template/kinds/viz.json) and template (template.ts:
                                   packages/viz/agent/CLAUDE.md, the examples, viz-sources/)
```

## A turn

The brief (`spec`) is authoritative: the agent reads it as `SPEC.md`, with the previous `viz.ts` (if any) to keep what
works. *Build from the brief* sends that as a message; anything else is a message like a view's, and the agent may ask.

1. The page sends the agent the brief, `viz.ts`, a `package.json` with the viz's packages, and `files/` as bytes. Only
   `viz.ts` and `package.json` are the draft.
2. The agent reads and edits them. Its `check` (`vizCheckTool`) runs `@gestalts/check`:
   - typecheck (TypeScript)
   - the viz's `checks`, where it can't reach anything
   - the build into one offline page (esbuild-wasm, the runtime's recorded sources, npm packages from esm.sh)
   - a render at 360 and 1000 px, light and dark, offline, with a screenshot of each for the agent
   With Claude Code through the bridge, it runs in this page. With the server's agent, where `GESTALTS_VIZ_RENDER`
   says: handed to this page too (`page`, the default: keep it open while it works), or in headless Chromium on the
   server (`worker`).
3. When the turn changed it, the page checks what came back itself. Only if that passes does it store the page and the
   still (800 px wide) as blobs named by their content, with `generator` (the agent that made it). A failed check keeps
   the source and the last page that passed. The agent never touches data.

`mise run check` runs the same check on `@gestalts/viz`'s examples in Node, without the render
(`packages/check/src/check.test.ts`).

## Where it goes

**Publish** makes it a lesson for a class: the vizint view started on it, with the viz and its page, still and files
(`build_viz` in `web/server/src/publish.rs`); only once it's built. It can be a step of a lesson of several views,
too, where it practises nothing. The **Public site** menu offers it for review: the viz yml with its page, still and
files (`src/workshop/submit.tsx`), from the server's copy. Accepted, it becomes a deck of `vizint` and an entry on the
public site ([`doc/architecture/publishing.md`](../../../../doc/architecture/publishing.md)).
