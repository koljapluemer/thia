/** What was opened on this device lately (`/v/…` pages), at most a few, for the catalog's recent bar. */
import { ENTRIES, type Entry } from './Catalog';
import { useMemo } from 'react';
import { store, useStored } from './store';

const RECENT = 'thia:recent';
const RECENT_MAX = 8;
export type Recent = { path: string; title: string };

function parse(raw: string | null): Recent[] {
  try {
    const saved = JSON.parse(raw ?? '[]') as unknown;
    if (!Array.isArray(saved)) return [];
    const known = new Set(ENTRIES.map((e) => e.path));
    return saved.filter((r): r is Recent => typeof r?.path === 'string' && typeof r?.title === 'string' && known.has(r.path));
  } catch { return []; }
}

/** What was opened on this device, most recent first: none while rendering on the server and hydrating. */
export function useRecent(): Recent[] {
  const raw = useStored(RECENT);
  return useMemo(() => parse(raw), [raw]);
}

/** `e` as the most recent. */
export function rememberRecent(e: Entry) {
  store.set(RECENT, JSON.stringify([{ path: e.path, title: e.title }, ...parse(store.get(RECENT)).filter((r) => r.path !== e.path)].slice(0, RECENT_MAX)));
}
