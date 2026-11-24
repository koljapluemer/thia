/**
 * A view's own text: its buttons, headings, help and generic feedback, as data (`wording@1` ymls) rather than in its
 * code, so it can be reworded and translated without touching the code. Questions, answers and vocabulary are content
 * and live in its ymls, never here.
 *
 * Each wording is one layer in one language. The view's author writes the `source` (in the view's own `lang`, each
 * key with a `description` saying where it shows); a `machine` translation is made from it, a person marks one
 * `reviewed`, and the maker's rewording is an `override`. Which text a key shows: override > reviewed > machine >
 * source. Every entry but the source's records the hash of the source text it was written against (`source`); when
 * the source changes, it's stale and not used until someone looks at it again.
 */
import { formatMessage, type Values } from './icu.ts';
import { formatNumber as formatIn, operators as operatorsIn, parseNumber as parseIn } from './numbers.ts';

export const WORDING = 'wording@1';
export const LAYERS = ['source', 'machine', 'reviewed', 'override'] as const;
export type Layer = (typeof LAYERS)[number];
export type Entry = { text: string; description?: string; source?: string };
export type Wording = { lang: string; layer: Layer; catalog?: string; messages: Record<string, Entry> };

/** 64 bits of FNV-1a over `text`, as hex: what an entry records of the source text it was written against. */
export function textHash(text: string): string {
  let a = 0xcbf29ce4, b = 0x84222325;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ (c >>> 4) ^ a, 0x01000193) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** The hash of a source catalog as a whole (its keys and texts): what a translation of all of it was made from. */
export const catalogHash = (source: Wording) => textHash(Object.keys(source.messages).sort().map((k) => `${k}\u0000${source.messages[k].text}`).join('\u0001'));

/** A yml's value as a wording, or undefined if it isn't one. */
export function asWording(v: Record<string, unknown>): Wording | undefined {
  const { lang, layer, catalog, messages } = v;
  if (typeof lang !== 'string' || !LAYERS.includes(layer as Layer) || typeof messages !== 'object' || messages === null) return undefined;
  const out: Record<string, Entry> = {};
  for (const [k, e] of Object.entries(messages as Record<string, unknown>)) {
    if (typeof e !== 'object' || e === null || typeof (e as Entry).text !== 'string') continue;
    const { text, description, source } = e as Entry;
    out[k] = { text, ...(typeof description === 'string' ? { description } : {}), ...(typeof source === 'string' ? { source } : {}) };
  }
  return { lang, layer: layer as Layer, ...(typeof catalog === 'string' ? { catalog } : {}), messages: out };
}

const RANK: Record<Layer, number> = { override: 3, reviewed: 2, machine: 1, source: 0 };

export type Resolved = {
  /** the language it's shown in: the first of `wanted` it has any wording in, else its source's */
  lang: string;
  /** each key's text, as shown */
  messages: Record<string, string>;
  /** where each key's text came from */
  from: Record<string, Layer>;
  /** entries not used because their source text changed since: `<lang>/<layer>/<key>` */
  stale: string[];
};

/**
 * The text a view shows to someone who reads `wanted` (most wanted first: their language's chain), from its wordings.
 * A key the chosen language has no fresh text for shows the source's.
 */
export function resolveWording(wordings: Wording[], wanted: string[]): Resolved {
  const source = wordings.find((w) => w.layer === 'source');
  if (!source) return { lang: wanted[0] ?? 'en', messages: {}, from: {}, stale: [] };
  // the first language wanted that it has any wording in (its source's own, reworded or not, among them)
  const has = (l: string) => wordings.some((w) => w.lang.toLowerCase() === l.toLowerCase());
  const lang = wanted.find(has) ?? source.lang;
  const layers = wordings.filter((w) => w.lang.toLowerCase() === lang.toLowerCase() && w.layer !== 'source').sort((a, b) => RANK[b.layer] - RANK[a.layer]);
  const messages: Record<string, string> = {};
  const from: Record<string, Layer> = {};
  const stale: string[] = [];
  for (const [key, entry] of Object.entries(source.messages)) {
    const hash = textHash(entry.text);
    let chosen: { text: string; layer: Layer } | undefined;
    for (const w of layers) {
      const e = w.messages[key];
      if (!e) continue;
      if (e.source !== hash) { stale.push(`${w.lang}/${w.layer}/${key}`); continue; }
      chosen = { text: e.text, layer: w.layer };
      break;
    }
    messages[key] = chosen?.text ?? entry.text;
    from[key] = chosen?.layer ?? 'source';
  }
  return { lang, messages, from, stale };
}

// --- in the frame: the text it shows now, and numbers as the person writes them ---

type Current = { messages: Record<string, string>; locale: string; lang: string; picking?: Map<string, Set<string>> };
let current: Current = { messages: {}, locale: 'en', lang: 'en' };
const listeners = new Set<() => void>();

/** The runtime (or a test) sets what the view's text is now; the view renders again. */
export function setWording(next: { messages: Record<string, string>; locale: string; lang: string; picking?: boolean }) {
  current = { messages: next.messages, locale: next.locale, lang: next.lang, ...(next.picking ? { picking: current.picking ?? new Map() } : {}) };
  listeners.forEach((l) => l());
}
export const onWording = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const wordingVersion = () => current;

/**
 * The keys whose text, as shown now, is `text`, or is a part of it: what someone clicked in the running view, while
 * its maker rewords it.
 */
export function keysShowing(text: string): string[] {
  if (!current.picking) return [];
  const t = text.trim();
  const exact = current.picking.get(t);
  if (exact) return [...exact];
  return [...current.picking.entries()].filter(([shown]) => shown.length > 1 && t.includes(shown)).sort((a, b) => b[0].length - a[0].length).flatMap(([, keys]) => [...keys]);
}

/**
 * The view's text for `key`, in the person's language where there is a wording in it, with `values` filled in (ICU:
 * `{name}`, `{n, plural, one {# card} other {# cards}}`). Keys and their source text are in the view's wording
 * (`data/wording.yml`); a key it hasn't shows as itself.
 */
export function t(key: string, values?: Values): string {
  const text = formatMessage(current.messages[key] ?? key, values, current.locale);
  if (current.picking) {
    const keys = current.picking.get(text) ?? new Set<string>();
    keys.add(key);
    current.picking.set(text, keys);
  }
  return text;
}

/** `n` as the person writes numbers (`3,5` in German); `options` as `Intl.NumberFormat` takes them. */
export const formatNumber = (n: number, options?: Intl.NumberFormatOptions) => formatIn(n, current.locale, options);

/**
 * What the person typed, as a number, read their way (`3,5` in German is 3.5); undefined when it isn't one or could
 * be read two ways. Never `parseFloat` an answer.
 */
export const parseNumber = (text: string) => parseIn(text, current.locale);

/** The signs for multiplying and dividing as the person's schools write them (`·` and `:` in German). */
export const operators = () => operatorsIn(current.locale);
