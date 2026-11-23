import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();
/** what couldn't be kept (no localStorage): this page's alone */
const memory = new Map<string, string | null>();
const notify = () => listeners.forEach((l) => l());

/** localStorage, where there is one: a private window, blocked site data or the prerenderer has none, and that's fine. */
export const store = {
  get(k: string): string | null {
    if (memory.has(k)) return memory.get(k) ?? null;
    try { return localStorage.getItem(k); } catch { return null; }
  },
  set(k: string, v: string) {
    try { localStorage.setItem(k, v); memory.delete(k); } catch { memory.set(k, v); }
    notify();
  },
  remove(k: string) {
    try { localStorage.removeItem(k); memory.delete(k); } catch { memory.set(k, null); }
    notify();
  },
  /** removes every key `test` says yes to */
  removeWhere(test: (key: string) => boolean) {
    try {
      const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter((k): k is string => k !== null && test(k));
      for (const k of keys) localStorage.removeItem(k);
    } catch { /* nothing kept */ }
    for (const k of memory.keys()) if (test(k)) memory.delete(k);
    notify();
  },
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => { listeners.delete(l); };
};

/**
 * `key`'s value, kept current. Null while rendering on the server and hydrating: the page is everyone's until it's
 * this device's.
 */
export function useStored(key: string): string | null {
  return useSyncExternalStore(subscribe, () => store.get(key), () => null);
}
