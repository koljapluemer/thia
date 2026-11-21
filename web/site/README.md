# site

The public site: every view in `distribution.yml`, each opened on one of its decks (`/v/<view>/<deck>`), listed and
searchable at `/`. The learning views, the visualizations and the workshops' accepted results are all the same kind
of thing here. No sign-in: what a learner does stays on the device, in one OPFS folder per entry, with the deck
mounted read-only, and "Start fresh" for shared devices. Views run under `closedCsp`, and their npm packages are
pinned and bundled into the build (`pinned_npm`). See
[`doc/architecture/publishing.md`](../../doc/architecture/publishing.md).

The same build plays a teacher's unlisted lesson from its link (`/l/<lesson>`). For that, the teacher server installs
it under `/runtime/<version>/` on the lesson domain (`dist/gestalts-runtime.json` says which version), and answers
each link with the build its lesson was made against. The lesson format is in `packages/workshop/src/lesson.ts`.

```sh
mise run site:dev      # :5177; lesson links from the teacher server on :7741 (VITE_LESSONS)
mise run site:build    # dist/: static files, every path served as index.html
```

Its `models:` include the teacher app's, as lessons need them.
