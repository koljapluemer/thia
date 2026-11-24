import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { m as all } from './paraglide/messages.js';
import { LOCALES } from './locales';
import { resolve } from './lang';

/** Where a person's choice is kept, on this device: the use app and the make app share it (one origin). */
export const LANG_KEY = 'thia:lang';

/** The languages offered: the pseudo-locale only in development. */
export const AVAILABLE: readonly string[] = (import.meta as { env?: { DEV?: boolean } }).env?.DEV ? LOCALES : LOCALES.filter((l) => l !== 'en-XA');

type All = typeof all;
/** Every message, in one language: `m.catalog_search()`, `m.outline_views({ count })`. */
export type Messages = { [K in keyof All]: All[K] extends (inputs: infer I, ...rest: never[]) => string ? ({} extends I ? (inputs?: I) => string : (inputs: I) => string) : never };

const bound = new Map<string, Messages>();
/** The messages in `lang`, for code outside React (a page's head, the prerender). */
export function messages(lang: string): Messages {
  let m = bound.get(lang);
  if (!m) {
    const locale = LOCALES.includes(lang) ? lang : 'en';
    m = new Proxy({} as Messages, {
      get: (_, k: string) => (inputs?: object) => (all as unknown as Record<string, (i: object, o: { locale: string }) => string>)[k](inputs ?? {}, { locale }),
    });
    bound.set(lang, m);
  }
  return m;
}

const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  const storage = (e: StorageEvent) => { if (e.key === LANG_KEY) l(); };
  addEventListener('storage', storage);
  addEventListener('languagechange', l);
  return () => { listeners.delete(l); removeEventListener('storage', storage); removeEventListener('languagechange', l); };
};
const stored = () => { try { return localStorage.getItem(LANG_KEY); } catch { return null; } };
const browser = () => navigator.languages.join(',');

type Lang = { lang: string; m: Messages; choice: string | null; setLang: (lang: string | null) => void };
const Ctx = createContext<Lang | null>(null);

/**
 * The app's language for everything inside. Without a person (the prerender, and hydrating it) it is the URL's
 * (`/de/…`), else the `content`'s (a German curriculum's page is a German page), else English; once hydrated it is
 * the person's (`resolve`), and `<html lang>` follows. Content keeps its own `lang` on its own element.
 */
export function LangProvider({ url, content, children }: { url?: string; content?: string; children: ReactNode }) {
  const choice = useSyncExternalStore(subscribe, stored, () => null);
  const langs = useSyncExternalStore(subscribe, browser, () => '');
  const lang = langs
    ? resolve({ choice, url, browser: langs.split(',') }, AVAILABLE)
    : resolve({ url: url ?? content }, AVAILABLE);
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  const value = useMemo<Lang>(() => ({
    lang,
    m: messages(lang),
    choice,
    setLang: (next) => {
      try { if (next) localStorage.setItem(LANG_KEY, next); else localStorage.removeItem(LANG_KEY); } catch { /* kept nowhere: this page only */ }
      listeners.forEach((l) => l());
    },
  }), [lang, choice]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The app's language and its messages. Outside a `LangProvider`: English. */
export function useLang(): Lang {
  return useContext(Ctx) ?? { lang: 'en', m: messages('en'), choice: null, setLang: () => {} };
}
