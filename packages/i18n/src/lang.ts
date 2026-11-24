/**
 * Which language: a person's choice, the URL's, the browser's, then English, each one followed down to a language the
 * app has. Fallbacks are per language, not straight to English: `de-AT` → `de`, `mfe` → `fr`. Tags are BCP 47 of any
 * length: nothing here assumes two letters.
 */

import { NEXT } from '@gestalts/view/locale';

/** `tag` in canonical form, or undefined if it isn't one. */
export function canonical(tag: string): string | undefined {
  try { return Intl.getCanonicalLocales(tag.trim())[0]; } catch { return undefined; }
}

/** What `tag` falls back to, most specific first, ending in `en`: `de-AT` → `de-AT, de, en`; `mfe` → `mfe, fr, en`. */
export function chain(tag: string): string[] {
  const out = own(tag);
  if (!out.includes('en')) out.push('en');
  return out;
}

/** `tag`'s chain without the English everything ends in. */
function own(tag: string): string[] {
  const out: string[] = [];
  const add = (t: string) => { if (!out.includes(t)) out.push(t); };
  let t = canonical(tag);
  while (t) {
    const parts = t.split('-');
    for (let n = parts.length; n > 0; n--) add(parts.slice(0, n).join('-'));
    t = NEXT[parts[0]];
  }
  return out;
}

/** The first language of `tag`'s chain that's `available`, matched without regard to case. */
export function pick(tag: string, available: readonly string[]): string | undefined {
  for (const t of chain(tag)) {
    const hit = available.find((a) => a.toLowerCase() === t.toLowerCase());
    if (hit) return hit;
  }
  return undefined;
}

/**
 * The app's language for a person: their explicit `choice` (kept on the device) > the URL's > the browser's
 * (`navigator.languages`, in order) > `en`. A tag that isn't available is followed down its chain before the next
 * source is asked, so a German speaker in Austria gets `de`, not the URL's English.
 */
export function resolve(sources: { choice?: string | null; url?: string | null; browser?: readonly string[] }, available: readonly string[]): string {
  const asked = [sources.choice, sources.url, ...(sources.browser ?? [])].filter((t): t is string => !!t);
  for (const t of asked) {
    for (const c of own(t)) {
      const hit = available.find((a) => a.toLowerCase() === c.toLowerCase());
      if (hit) return hit;
    }
  }
  return available.includes('en') ? 'en' : available[0];
}

/** A language's name in itself ("Deutsch"), or the tag. */
export function nativeName(tag: string): string {
  if (tag === 'en-XA') return 'Pseudo';
  try {
    const name = new Intl.DisplayNames([tag], { type: 'language' }).of(tag);
    return name ? name[0].toLocaleUpperCase(tag) + name.slice(1) : tag;
  } catch { return tag; }
}

/** `tag`'s name in `lang` ("German" in English), for saying which language content is in. */
export function nameIn(tag: string, lang: string): string {
  try { return new Intl.DisplayNames([lang], { type: 'language' }).of(tag) ?? tag; } catch { return tag; }
}

/** Whether two tags name the same language, whatever their regions: `de` and `de-AT` do. */
export function sameLanguage(a: string, b: string): boolean {
  return (canonical(a) ?? a).split('-')[0].toLowerCase() === (canonical(b) ?? b).split('-')[0].toLowerCase();
}

/**
 * A path's language prefix, as language versions meant to be found have one (`/de/`, `/de/v/<view>`), and the path
 * without it. English, the base, has none. Only `available` languages count: `/vi/…` is no prefix unless there is
 * a Vietnamese version of the app.
 */
export function splitPath(path: string, available: readonly string[]): { lang?: string; path: string } {
  const m = /^\/([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)(\/.*)?$/.exec(path);
  const lang = m && available.find((a) => a !== 'en' && a.toLowerCase() === m[1].toLowerCase());
  return lang ? { lang, path: m![2] || '/' } : { path };
}

/** `path` in `lang`'s version: `/` in German is `/de/`. */
export function langPath(path: string, lang: string): string {
  if (lang === 'en') return path;
  return `/${lang}${path === '/' ? '/' : path}`;
}

/**
 * The locale for numbers and dates of a person whose app is in `lang`: the browser's first locale in that language,
 * with its region (`de-AT`, `de-CH` group digits differently), else `lang`.
 */
export function localeFor(lang: string): string {
  const browser = typeof navigator === 'undefined' ? [] : navigator.languages ?? [];
  return browser.find((l) => sameLanguage(l, lang)) ?? lang;
}
