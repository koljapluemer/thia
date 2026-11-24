import { PersonalAccount } from './PersonalAccount';
import type { PersonalSync } from './personal-sync';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { registry } from 'virtual:gestalts-plugins';
import type { Repo } from '@gestalts/client';
import { useHomeRepo } from '@gestalts/host';
import { store, useStored } from './store';

/**
 * The gestalts-node on this computer (folder-sync), asked for plugin backends, `/net` and `/llm` beside the user's
 * store, which it doesn't hold unless the user syncs with it: the ymls stay in this browser.
 */
export const HOME_NODE: string = import.meta.env.VITE_GESTALTS_NODE ?? 'http://127.0.0.1:7717';

/** The user's own ymls, in this browser (OPFS): notes, what they practised, for every view alike. */
const HOME = 'home';
/** a guest's store, while there is one: `guest-<n>`, deleted when it ends */
const GUEST = 'thia:guest';

/** `decks`: the decks mounted on it (`<plugin>/<deck>`) */
type Home = { repo?: Repo; decks: string[]; error?: string };
type Value = {
  home: Home;
  syncStatus?: string;
  /** the folder the views are on: `home`, or a guest's */
  dir: string;
  guest: boolean;
  /** opens the store (with `deck` among its decks) if it isn't yet */
  want: (deck?: string) => void;
  startGuest: () => void;
  endGuest: () => void;
};
const Context = createContext<Value>({ home: { decks: [] }, dir: HOME, guest: false, want: () => {}, startGuest: () => {}, endGuest: () => {} });

/** What this device keeps of a store besides its folder: the decks mounted on it, its connector, the views' state. */
function forgetKeys(dir: string) {
  store.removeWhere((k) => k === `gestalts-mounted-decks:${dir}` || k === `gestalts-connector:${dir}` || k.startsWith(viewStatePrefix(dir)));
}

export const viewStatePrefix = (dir: string) => `thia:view-state:${dir}:`;

/** Lets go of a folder this device no longer uses. Best effort: a browser that won't is no worse off. */
export async function forget(dir: string, repo: Repo | undefined) {
  repo?.dispose();
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(dir, { recursive: true });
  } catch { /* still open somewhere, or no OPFS: it stays, unused */ }
}

/**
 * Holds the store for the whole site, opened the first time a page needs it and kept open from then on, so going
 * between pages doesn't read and index everything again. A guest (a shared device: the next person) gets a store of
 * their own, deleted when they end it.
 */
export function HomeProvider({ children }: { children: ReactNode }) {
  const [wanted, setWanted] = useState(false);
  const [deck, setDeck] = useState<string>();
  // this device's, once hydrated: the page is the same for everyone until then
  const guestDir = useStored(GUEST);
  const [home, setHome] = useState<Home>({ decks: [] });
  const [syncing, setSyncing] = useState<PersonalSync | null>(null);
  const [importLocal, setImportLocal] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string>();
  const dir = guestDir ?? (syncing ? `account-${syncing.account}` : HOME);
  const changeSync = useCallback((next: PersonalSync | null, includeLocal = false) => {
    syncing?.close();
    setHome({ decks: [] });
    setSyncStatus(undefined);
    setImportLocal(includeLocal);
    setSyncing(next);
    if (next) setWanted(true);
  }, [syncing]);

  useEffect(() => () => syncing?.close(), [syncing]);

  useEffect(() => {
    if (!syncing || !home.repo || guestDir) return;
    const repo = home.repo;
    let active = true;
    const run = () => {
      void syncing.sync(repo, importLocal).then((finished) => {
        if (!active || !finished) return;
        setImportLocal(false);
        setSyncStatus(`Last synced ${new Date().toLocaleTimeString()}`);
      }, (error: unknown) => {
        if (active) setSyncStatus(error instanceof Error ? error.message : String(error));
      });
    };
    run();
    const timer = window.setInterval(run, 10000);
    let debounce: number | undefined;
    const unsubscribe = repo.onWrite(() => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(run, 800);
    });
    window.addEventListener('online', run);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.clearTimeout(debounce);
      unsubscribe();
      window.removeEventListener('online', run);
    };
  }, [syncing, home.repo, importLocal, guestDir]);

  const want = useCallback((d?: string) => {
    setWanted(true);
    if (d) setDeck(d);
  }, []);
  const startGuest = useCallback(() => {
    changeSync(null);
    const next = `guest-${Date.now().toString(36)}`;
    setHome({ decks: [] });
    store.set(GUEST, next);
  }, [changeSync]);
  const endGuest = useCallback(() => {
    if (!guestDir) return;
    const old = { dir: guestDir, repo: home.repo };
    forgetKeys(old.dir);
    setHome({ decks: [] });
    store.remove(GUEST);
    void forget(old.dir, old.repo);
  }, [guestDir, home.repo]);

  const value = useMemo(() => ({ home, syncStatus, dir, guest: guestDir !== null, want, startGuest, endGuest }), [home, syncStatus, dir, guestDir, want, startGuest, endGuest]);
  return (
    <Context.Provider value={value}>
      {wanted && <Opener key={dir} dir={dir} deck={deck} onHome={setHome} />}
      {!guestDir && <PersonalAccount syncing={syncing} status={syncStatus} onSync={changeSync} />}
      {children}
    </Context.Provider>
  );
}

function Opener({ dir, deck, onHome }: { dir: string; deck?: string; onHome: (h: Home) => void }) {
  const where = useMemo(() => ({ dir, bridge: HOME_NODE }), [dir]);
  const { repo, decks, error } = useHomeRepo(where, registry, deck);
  useEffect(() => { onHome({ repo, decks, error }); }, [repo, decks, error, onHome]);
  return null;
}

/** The store, opening it (with `deck` mounted) if it isn't yet; its folder; guest mode. */
export function useHome(deck?: string): Value {
  const value = useContext(Context);
  const { want } = value;
  useEffect(() => want(deck), [want, deck]);
  return value;
}

/** Guest mode, without opening the store. */
export function useGuest(): Pick<Value, 'guest' | 'startGuest' | 'endGuest'> {
  return useContext(Context);
}


export function usePersonalSyncStatus() {
  return useContext(Context).syncStatus;
}
