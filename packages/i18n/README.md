# @gestalts/i18n

The app's own text in every language it has (web/site, web/app, the host, the workshop, folder-sync's page), and
which language a page is in. A view's text is its own (its wording), not this.

- `messages/<area>/<locale>.json`: the text, in [inlang's message format](https://inlang.com/m/reootnfj) (plurals as
  variants). `pnpm install` compiles it with Paraglide into `src/paraglide/` (not committed), and makes the
  pseudo-locale `en-XA` from `en`, offered in development only.
- `useLang()` gives `{ lang, m }`: `m.catalog_search()`, `m.outline_views({ count })`, always in `lang`, never
  Paraglide's global locale. `messages(lang)` is the same outside React.
- `LangProvider`: the language for everything inside. Without a person (the prerender, and hydrating it) it is the
  URL's (`/de/`), else the content's, else English; once hydrated, the person's choice (kept on the device), the
  URL's, the browser's, English, each followed down to a language the app has (`de-AT` → `de`, `mfe` → `fr`).
- `LangPicker`: the choice, in every app's header.

Text written into JSX is refused by the linter (`oxlint.config.ts`, `packages/check/lint/i18n.ts`).
