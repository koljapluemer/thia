import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { closeOpened, useOpenRepo, type Repo, type RepoSource, type YmlsIn } from '@gestalts/client';
import { deckSources, type Registry } from './registry';

const MOUNTED = (dir: string) => `gestalts-mounted-decks:${dir}`;

const listeners = new Set<() => void>();
/** what couldn't be kept in localStorage: this page's alone */
const memory = new Map<string, string>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => { listeners.delete(l); };
};

function readMounted(dir: string): string | null {
  const kept = memory.get(dir);
  if (kept !== undefined) return kept;
  try { return localStorage.getItem(MOUNTED(dir)); } catch { return null; }
}

function rememberMounted(dir: string, decks: string[]) {
  const text = JSON.stringify(decks);
  try { localStorage.setItem(MOUNTED(dir), text); memory.delete(dir); } catch { memory.set(dir, text); }
  listeners.forEach((l) => l());
}

/** The deck sources (`<plugin>/<deck>`) the store has mounted, of those the distribution has. */
function parseMounted(raw: string | null, registry: Registry): string[] {
  const known = new Set(registry.plugins.flatMap((p) => p.decks.map((d) => d.source)));
  try {
    const saved = JSON.parse(raw ?? '[]') as unknown;
    if (Array.isArray(saved)) return saved.filter((s): s is string => typeof s === 'string' && known.has(s)).sort();
  } catch { /* nothing usable kept: none yet */ }
  return [];
}

/**
 * The user's store: ymls in OPFS under `dir` or in the folder of the node at `node` (`where`; beside OPFS, `bridge` is
 * the node to ask for backends), with the gestalts of the distribution's model packages and every deck opened on it
 * so far, read-only under it. Opening a view on a deck it doesn't have yet (`deck`, `<plugin>/<deck>`) opens it again
 * with that deck too, and it's kept from then on (per browser): at most the distribution's decks.
 */
export function useHomeRepo(where: YmlsIn & { bridge?: string }, registry: Registry, deck?: string): { repo?: Repo; decks: string[]; error?: string } {
  const dir = where.dir ?? `node:${where.node}`;
  const raw = useSyncExternalStore(subscribe, () => readMounted(dir), () => null);
  const mounted = useMemo(() => parseMounted(raw, registry), [raw, registry]);
  const known = registry.plugins.some((p) => p.decks.some((d) => d.source === deck));
  const missing = deck !== undefined && known && !mounted.includes(deck);
  const whereKey = JSON.stringify(where);
  const source = useMemo<RepoSource>(() => ({
    ...(JSON.parse(whereKey) as YmlsIn & { bridge?: string }),
    decks: deckSources(registry.plugins.flatMap((p) => p.decks).filter((d) => mounted.includes(d.source))),
    gestalts: registry.gestalts,
  }), [whereKey, registry, mounted]);
  // a deck it doesn't have: nothing shows it yet, so it lets go of the repo without it (the same folder, opened once
  // at a time), and the one with it takes over
  useEffect(() => {
    if (!missing || deck === undefined) return;
    closeOpened(source);
    rememberMounted(dir, [...mounted, deck].sort());
  }, [missing, mounted, deck, dir, source]);
  const { repo, error } = useOpenRepo(missing ? undefined : source);
  return { repo, decks: mounted, error };
}
