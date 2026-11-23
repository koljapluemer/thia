import { useEffect, useState } from 'react';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { registry } from 'virtual:gestalts-plugins';
import type { OutlineTree, OutlineTreeEntry } from '@gestalts/host';
import { BY_SOURCE, follow, ViewCard } from './Catalog';
import { Notice, Spinner } from './Run';
import { store, useStored } from './store';
import { GuestBanner, Toolbar } from './Toolbar';

/**
 * A curriculum or guide (`/o/<outline>`), as its issuer structured it: the whole tree, as a disclosure list (each
 * entry a full-width button that opens what's under it: its views as the catalog's cards, then its children), each
 * entry with how many views practise what it is about (its own and its descendants'), found by the build through
 * concepts. A view's card is at the deepest entries it fits only, so opening a chapter doesn't repeat its sections'. `/o/<outline>/<entry>` opens it at that entry, for links to share. Its few own words are in the outline's
 * language.
 */

const WORDS = {
  en: { back: 'Everything', views: (n: number) => (n === 1 ? '1 view' : `${n} views`), none: 'Nothing here yet', only: 'only with views', replaced: 'A newer edition:', unknown: 'No such outline' },
  de: { back: 'Alle Inhalte', views: (n: number) => (n === 1 ? '1 Inhalt' : `${n} Inhalte`), none: 'Noch nichts dazu', only: 'nur mit Inhalten', replaced: 'Neuere Fassung:', unknown: 'Diesen Lehrplan gibt es nicht' },
};
const ONLY = 'site:outline:only-with-views';
/** what an entry's id looks like in a link */
const ENTRY = 'outline-entry-';

export function outlineAt(path: string): { name: string; entry?: string } | undefined {
  const m = /^\/o\/([a-z0-9-]+)(?:\/([0-9a-f]+))?\/?$/.exec(path);
  return m ? { name: m[1], entry: m[2] && `${ENTRY}${m[2]}` } : undefined;
}

/** The entries from the top down to `id`. */
function pathTo(entries: OutlineTreeEntry[], id: string): OutlineTreeEntry[] | undefined {
  for (const e of entries) {
    if (e.id === id) return [e];
    const below = e.entries && pathTo(e.entries, id);
    if (below) return [e, ...below];
  }
  return undefined;
}

/** The tree of `/o/<name>`: what a page about it needs before it renders. */
export async function loadTree(name: string): Promise<OutlineTree> {
  const r = await fetch(`outlines/${name}.json`);
  if (!r.ok) throw new Error(`${r.status}`);
  return (await r.json()) as OutlineTree;
}

/** What's open at first: the tree down to the entry the link names. */
const trailOf = (tree: OutlineTree | undefined, entry: string | undefined) => new Set(tree && entry ? (pathTo(tree.entries, entry) ?? []).map((e) => e.id) : []);

/**
 * `tree`, when the page has it already (prerendered, or loaded before hydrating); else it's loaded here and handed
 * up (`onTree`), so going back to it doesn't load it again.
 */
export function Outline({ name, entry, open, tree, onTree }: {
  name: string; entry?: string; open: (path: string) => void; tree?: OutlineTree; onTree: (tree: OutlineTree) => void;
}) {
  const summary = registry.outlines?.find((o) => o.name === name);
  const [error, setError] = useState<string>();
  const only = useStored(ONLY) === '1';
  const [expanded, setExpanded] = useState(() => trailOf(tree, entry));
  // the entry the link names: from the path, then as the reader picks one (the link changes, the page doesn't)
  const [selected, setSelected] = useState(entry);
  const w = summary?.lang.startsWith('de') ? WORDS.de : WORDS.en;

  useEffect(() => {
    if (!summary || tree) return;
    let live = true;
    loadTree(name).then(
      (t) => {
        if (!live) return;
        // a link to an entry opens the tree down to it
        setExpanded(trailOf(t, entry));
        onTree(t);
      },
      (e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)); },
    );
    return () => { live = false; };
  }, [name, summary, entry, tree, onTree]);
  // and scrolls to it
  const loaded = !!tree;
  useEffect(() => {
    if (loaded && entry) requestAnimationFrame(() => document.getElementById(entry)?.scrollIntoView({ block: 'start' }));
  }, [loaded, entry]);
  useEffect(() => { document.title = summary?.title ?? 'thia'; }, [summary]);

  if (!summary) return <Notice title={WORDS.en.unknown}><a className="link" href="/">See everything there is</a>.</Notice>;
  if (error) return <Notice title={summary.title}>It didn’t load ({error}). Try again in a moment.</Notice>;
  if (!tree) return <Spinner />;

  const toggleOnly = (on: boolean) => store.set(ONLY, on ? '1' : '0');
  const select = (e: OutlineTreeEntry) => {
    const next = new Set(expanded);
    if (next.has(e.id) && e.id === selected) next.delete(e.id);
    else next.add(e.id);
    setExpanded(next);
    setSelected(e.id);
    history.replaceState(null, '', `/o/${name}/${e.id.slice(ENTRY.length)}`);
  };

  const shown = (es: OutlineTreeEntry[] | undefined) => (es ?? []).filter((e) => !only || e.count > 0);
  const item = (e: OutlineTreeEntry) => {
    const isOpen = expanded.has(e.id);
    const children = shown(e.entries);
    const empty = e.count === 0;
    const here = e.views.flatMap((v) => BY_SOURCE.get(v.source) ?? []);
    return (
      <li key={e.id} id={e.id} className="min-w-0">
        <button
          type="button"
          aria-expanded={isOpen}
          className={`flex w-full min-w-0 items-start gap-1.5 rounded-field px-2 py-1.5 text-left hover:bg-base-200 ${e.id === selected ? 'bg-base-200' : ''} ${empty ? 'text-base-content/45' : ''}`}
          onClick={() => select(e)}
        >
          <ChevronRight className={`mt-0.5 size-4 shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''} ${children.length || here.length ? '' : 'invisible'}`} />
          <span className="min-w-0 flex-1 wrap-break-word">
            {e.notation && <span className="mr-2 font-mono opacity-70">{e.notation}</span>}
            {e.label}
          </span>
          {!empty && <span className="badge badge-sm badge-primary shrink-0" title={w.views(e.count)}>{e.count}</span>}
        </button>
        {isOpen && here.length > 0 && (
          <div className="grid grid-cols-1 gap-3 py-2 pl-6 sm:grid-cols-2 lg:grid-cols-3">
            {here.map((v) => <ViewCard key={v.path} e={v} open={open} />)}
          </div>
        )}
        {isOpen && empty && children.length === 0 && <p className="py-1 pl-8 text-base-content/50">{w.none}</p>}
        {isOpen && children.length > 0 && <ul className="ml-3 min-w-0 border-l border-base-300 pl-1 sm:pl-2">{children.map(item)}</ul>}
      </li>
    );
  };

  const successor = summary.replacedBy && registry.outlines?.find((o) => o.name === summary.replacedBy);
  return (
    <div className="min-h-dvh bg-base-200">
      <GuestBanner />
      <header className="mx-auto flex max-w-5xl flex-col gap-2 px-4 pt-6 pb-4">
        <div className="flex items-center gap-2">
          <a href="/" onClick={(ev) => follow(ev, '/', open)} className="link link-hover flex flex-1 items-center gap-1 text-sm text-base-content/70">
            <ArrowLeft className="size-4" />{w.back}
          </a>
          <Toolbar />
        </div>
        <h1 className="text-2xl font-semibold">{tree.title}</h1>
        <p className="text-sm text-base-content/70">{[tree.issuer, tree.edition].filter(Boolean).join(' · ')}</p>
        {successor && (
          <p role="note" className="alert alert-info text-sm">
            {w.replaced} <a className="link" href={`/o/${successor.name}`} onClick={(ev) => follow(ev, `/o/${successor.name}`, open)}>{successor.title}</a>
          </p>
        )}
        <label className="flex w-fit cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" className="toggle toggle-sm" checked={only} onChange={(ev) => toggleOnly(ev.target.checked)} />
          {w.only}
        </label>
      </header>
      <main className="mx-auto max-w-5xl px-4 pb-12">
        <ul className="min-w-0 rounded-box bg-base-100 p-2 text-sm">{shown(tree.entries).map(item)}</ul>
      </main>
    </div>
  );
}
