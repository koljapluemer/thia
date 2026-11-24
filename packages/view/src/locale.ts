/**
 * Where a language's speakers read next when there's nothing in theirs, beyond dropping subtags (`de-AT` → `de`):
 * Mauritian Creole speakers read French. The app's text follows it (`@gestalts/i18n`), and so do plurals and numbers
 * in a view, where CLDR lacks the language.
 */
export const NEXT: Record<string, string> = { mfe: 'fr', rcf: 'fr', crs: 'fr', ht: 'fr', lb: 'de', gsw: 'de', bar: 'de', nds: 'de' };

const nearest = new Map<string, string>();

/**
 * `locale`, or the nearest one `Intl` has data for (`Intl.PluralRules`'s or `Intl.NumberFormat`'s): its subtags
 * dropped, then the language it falls back to (`NEXT`), then English. `Intl` itself would fall back to the device's
 * language, which may be any.
 */
export function supportedLocale(locale: string, kind: 'plural' | 'number'): string {
  const key = `${kind}|${locale}`;
  const hit = nearest.get(key);
  if (hit) return hit;
  const supported = (l: string) => {
    try { return (kind === 'plural' ? Intl.PluralRules : Intl.NumberFormat).supportedLocalesOf([l]).length > 0; } catch { return false; }
  };
  let found = 'en';
  let tag: string | undefined = locale;
  search: while (tag) {
    const parts: string[] = tag.split('-');
    for (let n = parts.length; n > 0; n--) {
      const t = parts.slice(0, n).join('-');
      if (supported(t)) { found = t; break search; }
    }
    tag = NEXT[parts[0].toLowerCase()];
  }
  nearest.set(key, found);
  return found;
}
