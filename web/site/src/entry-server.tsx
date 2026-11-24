/**
 * What the build prerenders the site with (scripts/prerender.ts): every page it knows, as markup, with what search
 * engines and link previews read in its head. Built for Node (`vite build --ssr`); the browser takes each page over
 * (entry-client.tsx).
 */
import { renderToString } from 'react-dom/server';
import { registry } from 'virtual:gestalts-plugins';
import type { OutlineTree, OutlineTreeEntry } from '@gestalts/host';
import { AVAILABLE, langPath, LangProvider, messages, splitPath } from '@gestalts/i18n';
import { ENTRIES, entryAt, type Entry } from './Catalog';
import { outlineAt } from './Outline';
import { NotFound, Site } from './Site';

export type Head = {
  title: string;
  description: string;
  lang: string;
  /** the page's own path, for its canonical URL */
  path: string;
  /** schema.org JSON-LD */
  jsonLd?: object;
  /** nothing of its own to find: a view on the user's data alone (notes, cards) */
  noindex?: boolean;
  /** the page in each language it has, by language (`x-default` the one for everyone else) */
  alternates?: Record<string, string>;
};

/** The app's languages besides English, for the pages that have a version in each: everything (`/de/`). */
const OTHER = AVAILABLE.filter((l) => l !== 'en' && l !== 'en-XA');
const ENTRY = 'outline-entry-';

const walk = (entries: OutlineTreeEntry[]): OutlineTreeEntry[] => entries.flatMap((e) => [e, ...walk(e.entries ?? [])]);
const entryPath = (outline: string, e: OutlineTreeEntry) => `/o/${outline}/${e.id.slice(ENTRY.length)}`;

/** Every page the site has: everything (in each language of the app), each view, each outline and each of its entries. */
export function routes(trees: OutlineTree[]): string[] {
  return ['/', ...OTHER.map((l) => langPath('/', l)), ...ENTRIES.map((e) => e.path), ...trees.flatMap((t) => [`/o/${t.name}`, ...walk(t.entries).map((e) => entryPath(t.name, e))])];
}

/** The page at `path`, as markup; `tree` for an outline's. */
export function render(path: string, tree?: OutlineTree): string {
  return renderToString(<Site path={path} data={{ tree }} />);
}

/** What a path the site doesn't have shows (the server answers it with a 404). */
export function renderNotFound(): string {
  return renderToString(<LangProvider><NotFound /></LangProvider>);
}

/** The entries of an outline that list `source`: where it fits most closely. */
const closest = (entries: OutlineTreeEntry[], source: string) => walk(entries).filter((e) => e.views.some((v) => v.source === source));

function describe(e: Entry): string {
  const practises = e.deck?.practises ?? [];
  const what = practises.length ? ` ${messages('en').view_practises({ concepts: practises.slice(0, 6).join(', ') })}` : '';
  return `${e.title}: ${e.about}${what}`.slice(0, 300);
}

function viewHead(e: Entry, trees: OutlineTree[], base: string): Head {
  if (!e.deck) return { title: `${e.title} · thia`, description: describe(e), lang: 'en', path: e.path, noindex: true };
  const alignments = e.deck ? trees.flatMap((t) => closest(t.entries, e.deck!.source).map((x) => ({
    '@type': 'AlignmentObject',
    alignmentType: 'teaches',
    educationalFramework: [t.title, t.edition].filter(Boolean).join(', '),
    targetName: [x.notation, x.label].filter(Boolean).join(' '),
    ...(base ? { targetUrl: `${base}${entryPath(t.name, x)}` } : {}),
  }))) : [];
  return {
    title: `${e.title} · thia`,
    description: describe(e),
    lang: 'en',
    path: e.path,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'LearningResource',
      name: e.title,
      description: describe(e),
      ...(base ? { url: `${base}${e.path}` } : {}),
      isAccessibleForFree: true,
      learningResourceType: 'interactive exercise',
      ...(e.deck?.practises.length ? { teaches: e.deck.practises } : {}),
      ...(alignments.length ? { educationalAlignment: alignments } : {}),
    },
  };
}

/** What `path`'s page says about itself; `base` (the site's URL, no trailing slash; empty if not known) makes its links absolute. */
export function head(path: string, trees: OutlineTree[], base: string): Head {
  const { lang: urlLang, path: route } = splitPath(path, AVAILABLE);
  if (urlLang && route === '/') return homeHead(urlLang);
  const entry = entryAt(route);
  if (entry) return viewHead(entry, trees, base);
  const outline = outlineAt(path);
  const tree = outline && trees.find((t) => t.name === outline.name);
  if (outline && tree) {
    const lang = tree.lang;
    const m = messages(lang);
    const at = outline.entry && walk(tree.entries).find((e) => e.id === outline.entry);
    const edition = [tree.issuer, tree.edition].filter(Boolean).join(', ');
    if (at) {
      const label = [at.notation, at.label].filter(Boolean).join(' ');
      const n = at.count;
      return {
        title: `${label} · ${tree.title}`,
        description: m.outline_entry_description({ count: n, label, title: tree.title, edition }),
        lang,
        path,
      };
    }
    return {
      title: `${tree.title} · thia`,
      description: m.outline_description({ title: tree.title, edition }),
      lang,
      path,
    };
  }
  return homeHead('en');
}

/** Everything, in `lang`: one page in each language of the app, each naming the others. */
function homeHead(lang: string): Head {
  const alternates = Object.fromEntries([['en', '/'], ...OTHER.map((l) => [l, langPath('/', l)]), ['x-default', '/']]);
  return { title: 'thia', description: messages(lang).site_description(), lang, path: langPath('/', lang), alternates };
}

/** The outlines the site has, current and replaced: their trees are what the prerenderer reads. */
export const outlineNames = (registry.outlines ?? []).map((o) => o.name);

/** What a path the site doesn't have says about itself: for anyone, so in English, and found by nothing. */
export function notFoundHead(): Head {
  const m = messages('en');
  return { title: `${m.not_found()} · thia`, description: m.not_found_description(), lang: 'en', path: '/' };
}
