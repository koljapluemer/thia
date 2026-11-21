import { useMemo, useState, type MouseEvent } from 'react';
import { Search } from 'lucide-react';
import { registry } from 'virtual:gestalts-plugins';
import { closedCsp, deckSources, npmUrlsOf, type DeckEntry, type PluginEntry } from '@gestalts/host';
import type { Run } from './Run';

/**
 * Everything on the site, each a view opened on one of its decks: a learning loop, a lesson from a workshop, a
 * visualization, all alike. A view without a deck has nothing to show here, so it isn't one.
 */
export type Entry = { plugin: PluginEntry; deck: DeckEntry; path: string; title: string; about: string; tags: string[] };

export const ENTRIES: Entry[] = registry.plugins.flatMap((plugin) => plugin.decks.map((deck) => ({
  plugin,
  deck,
  path: `/v/${plugin.manifest.id}/${deck.id}`,
  title: deck.title,
  about: plugin.manifest.description ?? plugin.manifest.title,
  tags: plugin.manifest.tags ?? [],
})));

export function entryAt(path: string): Entry | undefined {
  return ENTRIES.find((e) => e.path === path.replace(/\/$/, ''));
}

/** How one entry runs: under the closed CSP, unless the site granted it its own origin (our own views only). */
export function runOf(e: Entry, back: () => void): Run {
  const p = e.plugin;
  const sameOrigin = p.granted.includes('same-origin');
  return {
    title: e.title,
    dir: `view-${p.manifest.id}-${e.deck.id}`,
    keys: { state: `site:state:${p.manifest.id}/${e.deck.id}`, generation: `site:generation:${p.manifest.id}/${e.deck.id}` },
    deck: deckSources([e.deck])[0],
    view: {
      id: p.manifest.id,
      title: e.title,
      js: p.js,
      npm: p.npm,
      npmUrls: npmUrlsOf(p),
      scope: { reads: p.manifest.reads ?? [], writes: p.manifest.writes ?? [], microphone: p.granted.includes('microphone') },
      granted: p.granted,
    },
    csp: sameOrigin ? undefined : closedCsp({ scripts: [new URL('npm/', document.baseURI).href] }),
    back,
  };
}

const words = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');

export function Catalog({ open }: { open: (path: string) => void }) {
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const terms = words(q).split(/\s+/).filter(Boolean);
    return ENTRIES.filter((e) => {
      const text = words([e.title, e.plugin.manifest.title, e.about, ...e.tags].join(' '));
      return terms.every((t) => text.includes(t));
    });
  }, [q]);
  const go = (e: MouseEvent, path: string) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    open(path);
  };
  return (
    <div className="min-h-dvh bg-base-200">
      <header className="mx-auto max-w-5xl px-4 pt-10 pb-6">
        <h1 className="text-3xl font-semibold">thia</h1>
        <p className="mt-1 text-base-content/70">Interactive exercises and visualizations. Free, nothing to sign up for; what you do stays in this browser.</p>
        <label className="input mt-6 w-full max-w-md">
          <Search className="size-4 opacity-50" />
          <input type="search" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        </label>
      </header>
      <main className="mx-auto grid max-w-5xl gap-3 px-4 pb-12 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((e) => (
          <a key={e.path} href={e.path} onClick={(ev) => go(ev, e.path)} className="card bg-base-100 shadow-sm transition hover:shadow-md">
            <div className="card-body gap-1 p-4">
              <h2 className="card-title text-base">{e.title}</h2>
              <p className="text-xs text-base-content/50">{e.plugin.manifest.title}</p>
              <p className="line-clamp-3 text-sm text-base-content/70">{e.about}</p>
            </div>
          </a>
        ))}
        {shown.length === 0 && <p className="text-base-content/60">Nothing here matches “{q}”.</p>}
      </main>
    </div>
  );
}
