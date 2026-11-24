/**
 * Numbers as the person reads and writes them: German `3,5` is three and a half, `3.500` three thousand five hundred.
 * Parsing an answer the wrong way marks a right student wrong, so a view never uses `parseFloat` on what was typed:
 * `parseNumber` reads the person's own way, and refuses what it can't read for sure rather than guessing.
 */
import { supportedLocale } from './locale.ts';

type Separators = { decimal: string; group: string; digits: string[] };
const cache = new Map<string, Separators>();

function separators(locale: string): Separators {
  let s = cache.get(locale);
  if (s) return s;
  const at = supportedLocale(locale, 'number');
  const parts = new Intl.NumberFormat(at, { useGrouping: true }).formatToParts(12345.6);
  const of = (t: string, d: string) => parts.find((p) => p.type === t)?.value ?? d;
  // the locale's own digits (Arabic-Indic, Devanagari, …), as its numbering system writes 0 to 9
  const one = new Intl.NumberFormat(at, { useGrouping: false });
  s = { decimal: of('decimal', '.'), group: of('group', ','), digits: Array.from({ length: 10 }, (_, d) => one.format(d)) };
  cache.set(locale, s);
  return s;
}

/** `n` as `locale` writes it (`3,5`, `1.234`); `options` as `Intl.NumberFormat` takes them. */
export function formatNumber(n: number, locale: string, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(supportedLocale(locale, 'number'), options).format(n);
}

const SPACE = /[\s\u00a0\u202f\u2009]/u;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * What `text` says as a number, written as `locale` writes them: its decimal mark, its digit groups (in threes, or
 * none), its own digits; a leading `-`, `−` or `+`. Undefined when it isn't one, or could be read two ways: in German
 * `3.5` is neither three and a half nor a group of thousands, so it isn't read at all.
 */
export function parseNumber(text: string, locale: string): number | undefined {
  const s = separators(locale);
  // direction marks right-to-left locales put around a sign go; the locale's own digits become 0-9; spaces are one
  let t = text.replace(/[\u200e\u200f\u061c]/gu, '').trim()
    .replace(/./gu, (c) => { const d = s.digits.indexOf(c); return d >= 0 ? String(d) : SPACE.test(c) ? ' ' : c; });
  let sign = 1;
  if (/^[-−‐]/u.test(t)) { sign = -1; t = t.slice(1).trim(); } else if (t.startsWith('+')) t = t.slice(1).trim();
  if (!t) return undefined;
  const group = SPACE.test(s.group) ? ' ' : s.group;
  const [whole, ...rest] = t.split(s.decimal);
  if (rest.length > 1) return undefined;
  const fraction = rest[0];
  if (fraction !== undefined && !/^\d+$/.test(fraction)) return undefined;
  let digits: string;
  if (/^\d+$/.test(whole)) digits = whole;
  else if (new RegExp(`^\\d{1,3}(${escape(group)}\\d{3})+$`).test(whole)) digits = whole.split(group).join('');
  else if (whole === '' && fraction !== undefined) digits = '0';
  else return undefined;
  const n = Number(`${digits}${fraction !== undefined ? `.${fraction}` : ''}`);
  return Number.isFinite(n) ? sign * n : undefined;
}

/**
 * The signs for multiplying and dividing as `locale`'s schools write them: `·` and `:` in German, `×` and `÷` in
 * English. A region's or school's own convention may differ; this is the common one.
 */
export function operators(locale: string): { times: string; divide: string } {
  const lang = locale.split('-')[0].toLowerCase();
  if (['de', 'nl', 'da', 'no', 'nb', 'nn', 'sv', 'fi', 'pl', 'cs', 'sk', 'hu', 'ru', 'uk', 'fr'].includes(lang)) return { times: '·', divide: ':' };
  return { times: '×', divide: '÷' };
}
