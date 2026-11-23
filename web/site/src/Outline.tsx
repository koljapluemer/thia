import { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { registry } from 'virtual:gestalts-plugins';
import type { OutlineTree, OutlineTreeEntry } from '@gestalts/host';
import { BY_SOURCE, follow, ViewCard } from './Catalog';
import { Notice, Spinner, store } from './Run';

/**
 * A curriculum or guide (`/o/<outline>`), as its issuer structured it: the whole tree, each entry with how many views
 * practise what it is about (its own and its descendants'), found by the build through concepts. `/o/<outline>/<entry>`
 * opens it at that entry, for links to share. Its few own words are in the outline's language.
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

export function Outline({ name, entry, open }: { name: string; entry?: string; open: (path: string) => void }) {
  const summary = registry.outlines?.find((o) => o.name === name);
  const [tree, setTree] = useState<OutlineTree>();
  const [error, setError] = useState<string>();
  const [only, setOnly] = useState(() => store.get(ONLY) === '1');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // the entry the link names: from the path, then as the reader picks one (the link changes, the page doesn't)
  const [selected, setSelected] = useState(entry);
  const w = summary?.lang.startsWith('de') ? WORDS.de : WORDS.en;

  useEffect(() => {
    if (!summary) return;
    let live = true;
    fetch(`outlines/${name}.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((t: OutlineTree) => {
        if (!live) return;
        setTree(t);
        // a link to an entry opens the tree down to it
        const trail = entry ? pathTo(t.entries, entry) : undefined;
        if (trail) setExpanded(new Set(trail.map((e) => e.id)));
      })
      .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [name, summary, entry]);
  // and scrolls to it
  useEffect(() => {
    if (tree && entry) requestAnimationFrame(() => document.getElementById(entry)?.scrollIntoView({ block: 'start' }));
  }, [tree, entry]);
  useEffect(() => { document.title = summary?.title ?? 'thia'; }, [summary]);

  if (!summary) return <Notice title={WORDS.en.unknown}><a className="link" href="/">See everything there is</a>.</Notice>;
  if (error) return <Notice title={summary.title}>It didn’t load ({error}). Try again in a moment.</Notice>;
  if (!tree) return <Spinner />;

  const toggleOnly = (on: boolean) => { setOnly(on); store.set(ONLY, on ? '1' : '0'); };
  const select = (e: OutlineTreeEntry) => {
    const next = new Set(expanded);
    if (next.has(e.id) && e.id === selected) next.delete(e.id);
    else next.add(e.id);
    setExpanded(next);
    setSelected(e.id);
    history.replaceState(null, '', `/o/${name}/${e.id.slice(ENTRY.length)}`);
  };

  const shown = (es: OutlineTreeEntry[] | undefined) => (es ?? []).filter((e) => !only || e.views.length > 0);
  const item = (e: OutlineTreeEntry) => {
    const isOpen = expanded.has(e.id);
    const children = shown(e.entries);
    const empty = e.views.length === 0;
    return (
      <li key={e.id} id={e.id}>
        <button
          type="button"
          aria-expanded={children.length || !empty ? isOpen : undefined}
          className={`items-start text-left ${e.id === selected ? 'menu-active' : ''} ${empty ? 'text-base-content/45' : ''}`}
          onClick={() => select(e)}
        >
          <span className="flex-1">
            {e.notation && <span className="mr-2 font-mono text-xs opacity-70">{e.notation}</span>}
            {e.label}
          </span>
          {!empty && <span className="badge badge-sm badge-primary shrink-0" title={w.views(e.views.length)}>{e.views.length}</span>}
        </button>
        {isOpen && !empty && (
          <div className="grid gap-3 py-2 pl-4 sm:grid-cols-2 lg:grid-cols-3">
            {e.views.flatMap((v) => BY_SOURCE.get(v.source) ?? []).map((v) => <ViewCard key={v.path} e={v} open={open} />)}
          </div>
        )}
        {isOpen && empty && children.length === 0 && <p className="py-1 pl-4 text-sm text-base-content/50">{w.none}</p>}
        {isOpen && children.length > 0 && <ul>{children.map(item)}</ul>}
      </li>
    );
  };

  const successor = summary.replacedBy && registry.outlines?.find((o) => o.name === summary.replacedBy);
  return (
    <div className="min-h-dvh bg-base-200">
      <header className="mx-auto flex max-w-5xl flex-col gap-2 px-4 pt-6 pb-4">
        <a href="/" onClick={(ev) => follow(ev, '/', open)} className="link link-hover flex items-center gap-1 text-sm text-base-content/70">
          <ArrowLeft className="size-4" />{w.back}
        </a>
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
        <ul className="menu w-full rounded-box bg-base-100 p-2">{shown(tree.entries).map(item)}</ul>
      </main>
    </div>
  );
}
