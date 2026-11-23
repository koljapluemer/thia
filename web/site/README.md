# site

The use app: every view in `distribution.yml`, each opened on one of its decks (`/v/<view>/<deck>`), or on the user's
data alone if it has none (`/v/<view>`: notes, flashcards, sources), listed and searchable at `/` with what was
opened lately on this device, and its curricula and guides (`outlines:`), each a tree whose entries list the views
that practise what they're about (`/o/<outline>`, `/o/<outline>/<entry>` opened at one entry). The learning views,
the visualizations and the workshops' accepted results are all the same kind of thing here. No sign-in: every view
runs on one store in this browser (OPFS `home`), with each deck opened so far mounted read-only, optionally synced
with folder-sync on this computer (`VITE_GESTALTS_NODE`, default :7717, also asked for backends, `/net`, `/llm`);
"Guest" gives a shared device's next person a store of their own, deleted when they end it. Views run under
`closedCsp` unless granted the site's origin, and their npm packages are pinned and bundled into the build
(`pinned_npm`). The header links to the workshop (`VITE_MAKE`, default `/workshop`). See
[`doc/architecture/publishing.md`](../../doc/architecture/publishing.md).

Every page is prerendered at build time (`scripts/prerender.ts`, from `src/entry-server.tsx` built for Node): each view,
outline and outline entry has its own `dist/<path>/index.html`, with its content, title, description, language and
schema.org `LearningResource` (what a view practises, and the outline entries it fits, as `educationalAlignment`),
so it shows without JavaScript and search engines find it; the browser takes the page over (`src/entry-client.tsx`,
`hydrateRoot`) and from then on goes between pages itself. What's this device's (the store, guest mode, what was
opened lately) only shows once it has. Serve a path from `<path>/index.html`, else `404.html` with a 404.

The same build plays an unlisted published lesson from its link (`/l/<lesson>`), from the bare `player.html`, never
indexed. For that, the server installs
it under `/runtime/<version>/` on the lesson domain (`dist/gestalts-runtime.json` says which version), and answers
each link with the build its lesson was made against. The lesson format is in `packages/workshop/src/lesson.ts`.

```sh
mise run site:dev      # :5177; lesson links from the server on :7741 (VITE_LESSONS)
mise run site:build    # dist/: static files, every page prerendered; VITE_PUBLIC_URL=https://… adds canonical links, sitemap.xml
```

Its `models:` include the lessons' (web/app/distributions/lessons.yml), as lessons need them.
