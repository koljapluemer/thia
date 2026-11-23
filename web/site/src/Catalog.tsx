import { useMemo, useState, type MouseEvent } from 'react';
import { BookOpen, History, Search } from 'lucide-react';
import { registry } from 'virtual:gestalts-plugins';
import type { DeckEntry, PluginEntry } from '@gestalts/host';
import { GuestBanner, Toolbar } from './Toolbar';
import { useRecent } from './recent';

/**
 * Everything on the site: each view opened on one of its decks (a learning loop, a lesson from a workshop, a
 * visualization, all alike), and the views without decks (notes, flashcards, sources), on the user's own data alone.
 */
export type Entry = { plugin: PluginEntry; deck?: DeckEntry; path: string; title: string; about: string; tags: string[] };

export const ENTRIES: Entry[] = registry.plugins.flatMap((plugin): Entry[] => {
  const about = plugin.manifest.description ?? plugin.manifest.title;
  const tags = plugin.manifest.tags ?? [];
  if (!plugin.decks.length) return [{ plugin, path: `/v/${plugin.manifest.id}`, title: plugin.manifest.title, about, tags }];
  return plugin.decks.map((deck) => ({ plugin, deck, path: `/v/${plugin.manifest.id}/${deck.id}`, title: deck.title, about, tags }));
});

export function entryAt(path: string): Entry | undefined {
  return ENTRIES.find((e) => e.path === path.replace(/\/$/, ''));
}

/** By `<plugin>/<deck>`, as outlines name them. */
export const BY_SOURCE = new Map(ENTRIES.flatMap((e) => (e.deck ? [[e.deck.source, e] as const] : [])));

/** A link that the page follows itself, leaving modifier-clicks to the browser. */
export function follow(e: MouseEvent, path: string, open: (path: string) => void) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  open(path);
}

export function ViewCard({ e, open }: { e: Entry; open: (path: string) => void }) {
  return (
    <a href={e.path} onClick={(ev) => follow(ev, e.path, open)} className="card bg-base-100 shadow-sm transition hover:shadow-md">
      <div className="card-body gap-1 p-4">
        <h2 className="card-title text-base">{e.title}</h2>
        <p className="text-xs text-base-content/50">{e.plugin.manifest.title}</p>
        <p className="line-clamp-3 text-sm text-base-content/70">{e.about}</p>
      </div>
    </a>
  );
}

/** Curricula and guides, current editions only: each with how many of its entries have views. */
function Outlines({ open }: { open: (path: string) => void }) {
  const outlines = (registry.outlines ?? []).filter((o) => !o.replacedBy);
  if (!outlines.length) return null;
  return (
    <section className="mx-auto max-w-5xl px-4 pb-6">
      <h2 className="mb-2 text-sm font-medium text-base-content/70">Curricula and guides</h2>
      <ul className="grid gap-3 sm:grid-cols-2">
        {outlines.map((o) => (
          <li key={o.name}>
            <a href={`/o/${o.name}`} onClick={(ev) => follow(ev, `/o/${o.name}`, open)} className="flex items-start gap-3 rounded-box bg-base-100 p-4 shadow-sm transition hover:shadow-md">
              <BookOpen className="mt-0.5 size-5 shrink-0 opacity-60" />
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">{o.title}</span>
                <span className="text-xs text-base-content/60">{[o.region ? 'Curriculum' : 'Guide', o.issuer, o.edition].filter(Boolean).join(' · ')}</span>
                <span className="text-xs text-base-content/60">{o.leavesWithViews} of {o.leaves} entries with views</span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

const words = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');

/** What was opened on this device lately. */
function RecentBar({ open }: { open: (path: string) => void }) {
  const recent = useRecent();
  if (!recent.length) return null;
  return (
    <nav aria-label="Recent" className="mt-4 flex flex-wrap items-center gap-1 text-sm">
      <History className="size-4 opacity-50" />
      {recent.map((r) => <a key={r.path} href={r.path} onClick={(ev) => follow(ev, r.path, open)} className="btn btn-xs btn-ghost">{r.title}</a>)}
    </nav>
  );
}

export function Catalog({ open }: { open: (path: string) => void }) {
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const terms = words(q).split(/\s+/).filter(Boolean);
    return ENTRIES.filter((e) => {
      const text = words([e.title, e.plugin.manifest.title, e.about, ...e.tags].join(' '));
      return terms.every((t) => text.includes(t));
    });
  }, [q]);
  const views = shown.filter((e) => e.deck);
  const own = shown.filter((e) => !e.deck);
  return (
    <div className="min-h-dvh bg-base-200">
      <GuestBanner />
      <header className="mx-auto max-w-5xl px-4 pt-6 pb-6">
        <div className="flex items-center gap-2">
          <h1 className="flex-1 text-3xl font-semibold">thia</h1>
          <Toolbar />
        </div>
        <p className="mt-1 text-base-content/70">Interactive exercises and visualizations. Free, nothing to sign up for; what you do stays in this browser.</p>
        <label className="input mt-6 w-full max-w-md">
          <Search className="size-4 opacity-50" />
          <input type="search" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        </label>
        <RecentBar open={open} />
      </header>
      {!q && <Outlines open={open} />}
      <main className="mx-auto flex max-w-5xl flex-col gap-6 px-4 pb-12">
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {views.map((e) => <ViewCard key={e.path} e={e} open={open} />)}
        </section>
        {own.length > 0 && (
          <section>
            <h2 className="mb-2 text-sm font-medium text-base-content/70">Your notes and cards</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{own.map((e) => <ViewCard key={e.path} e={e} open={open} />)}</div>
          </section>
        )}
        {shown.length === 0 && <p className="text-base-content/60">Nothing here matches “{q}”.</p>}
      </main>
    </div>
  );
}
