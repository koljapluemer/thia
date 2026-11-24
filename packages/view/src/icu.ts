/**
 * The part of ICU MessageFormat a view's text needs, small enough to ship in every frame: `{name}`, `{n, number}`,
 * `{n, plural, one {# item} other {# items}}` (with `=0` and `offset:`), `{n, selectordinal, …}`,
 * `{x, select, a {…} other {…}}`, and apostrophe quoting (`'{'`, `''`). Plurals follow `Intl.PluralRules`, so they are
 * right in every language CLDR knows; one it doesn't (Mauritian Creole) gets those of the language its speakers read
 * next (French: `supportedLocale`), never the device's.
 *
 * Formatting gives text, never markup: what a message says is shown as text wherever it ends up.
 */

export type Part =
  | string
  | { arg: string; type?: 'number' }
  | { arg: string; type: 'plural' | 'selectordinal' | 'select'; offset: number; options: Record<string, Part[]> }
  | { pound: true };

/** What's wrong with a message, and where (an index into its text). */
export class MessageError extends Error {
  readonly at: number;
  constructor(message: string, at: number) {
    super(`${message} (at ${at})`);
    this.at = at;
  }
}

import { supportedLocale } from './locale.ts';

const ARG = /^[A-Za-z_][\w.-]*$/;

/** A message's parts, or a `MessageError` saying what's wrong with it. */
export function parseMessage(text: string): Part[] {
  let i = 0;
  const parts = (inPlural: boolean, depth: number): Part[] => {
    const out: Part[] = [];
    let lit = '';
    const flush = () => { if (lit) out.push(lit); lit = ''; };
    while (i < text.length) {
      const c = text[i];
      if (c === "'") {
        const next = text[i + 1];
        if (next === "'") { lit += "'"; i += 2; continue; }
        if (next === '{' || next === '}' || (inPlural && next === '#')) {
          const end = text.indexOf("'", i + 1);
          if (end < 0) throw new MessageError('a quote is never closed', i);
          lit += text.slice(i + 1, end).replaceAll("''", "'");
          i = end + 1;
          continue;
        }
        lit += c; i++; continue;
      }
      if (c === '}') {
        if (depth === 0) throw new MessageError('a } without its {', i);
        flush();
        return out;
      }
      if (c === '#' && inPlural) { flush(); out.push({ pound: true }); i++; continue; }
      if (c === '{') { flush(); out.push(argument()); continue; }
      lit += c; i++;
    }
    if (depth > 0) throw new MessageError('a { is never closed', text.length);
    flush();
    return out;
  };
  const word = () => {
    const m = /^\s*([^\s,{}]*)\s*/.exec(text.slice(i))!;
    i += m[0].length;
    return m[1];
  };
  const argument = (): Part => {
    const start = i;
    i++; // {
    const arg = word();
    if (!ARG.test(arg)) throw new MessageError(`{${arg}} isn't a name (letters, digits, _)`, start);
    if (i >= text.length) throw new MessageError('a { is never closed', start);
    if (text[i] === '}') { i++; return { arg }; }
    if (text[i] !== ',') throw new MessageError(`{${arg} needs a } or a type`, i);
    i++;
    const type = word();
    if (type === 'number') {
      if (text[i] !== '}') throw new MessageError(`{${arg}, number} takes no style here`, i);
      i++;
      return { arg, type: 'number' };
    }
    if (type !== 'plural' && type !== 'selectordinal' && type !== 'select') throw new MessageError(`{${arg}, ${type}}: the types are number, plural, selectordinal and select`, i);
    if (text[i] !== ',') throw new MessageError(`{${arg}, ${type}} needs its options after a comma`, i);
    i++;
    let offset = 0;
    const options: Record<string, Part[]> = {};
    for (;;) {
      const key = word();
      if (!key) {
        if (text[i] === '}') break;
        throw new MessageError(`{${arg}, ${type}}: an option without a name`, i);
      }
      if (key.startsWith('offset:') && type !== 'select') { offset = Number(key.slice('offset:'.length)); continue; }
      if (text[i] !== '{') throw new MessageError(`{${arg}, ${type}}: option ${key} needs its text in { }`, i);
      if (options[key]) throw new MessageError(`{${arg}, ${type}}: option ${key} twice`, i);
      i++;
      options[key] = parts(type !== 'select', 1);
      i++; // }
    }
    if (!options.other) throw new MessageError(`{${arg}, ${type}} needs an \`other\` option`, start);
    i++; // }
    return { arg, type, offset, options };
  };
  return parts(false, 0);
}

/** The names a message takes, each with what it's used as (`plural` and `number` need numbers). */
export function argsOf(parts: Part[], out = new Map<string, 'text' | 'number' | 'select'>()): Map<string, 'text' | 'number' | 'select'> {
  for (const p of parts) {
    if (typeof p === 'string' || 'pound' in p) continue;
    const kind = p.type === 'select' ? 'select' : p.type ? 'number' : 'text';
    if (!out.has(p.arg) || out.get(p.arg) === 'text') out.set(p.arg, kind);
    if ('options' in p) for (const o of Object.values(p.options)) argsOf(o, out);
  }
  return out;
}

export type Values = Record<string, string | number | boolean | null | undefined>;

const rules = new Map<string, Intl.PluralRules>();
const pluralRules = (locale: string, type: Intl.PluralRuleType) => {
  const key = `${locale}|${type}`;
  let r = rules.get(key);
  if (!r) {
    r = new Intl.PluralRules(supportedLocale(locale, 'plural'), { type });
    rules.set(key, r);
  }
  return r;
};
const numbers = new Map<string, Intl.NumberFormat>();
const numberFormat = (locale: string) => {
  let f = numbers.get(locale);
  if (!f) {
    f = new Intl.NumberFormat(supportedLocale(locale, 'number'));
    numbers.set(locale, f);
  }
  return f;
};

/** `parts` with `values` filled in, numbers and plurals as `locale` has them. A value not given is shown as its name. */
export function formatParts(parts: Part[], values: Values, locale: string, pound?: number): string {
  let out = '';
  for (const p of parts) {
    if (typeof p === 'string') { out += p; continue; }
    if ('pound' in p) { out += pound === undefined ? '#' : numberFormat(locale).format(pound); continue; }
    const v = values[p.arg];
    if (v === undefined || v === null) { out += `{${p.arg}}`; continue; }
    if (!('options' in p)) {
      out += typeof v === 'number' ? numberFormat(locale).format(v) : String(v);
      continue;
    }
    if (p.type === 'select') {
      out += formatParts(p.options[String(v)] ?? p.options.other, values, locale, pound);
      continue;
    }
    const n = Number(v);
    const exact = p.options[`=${n}`];
    const shown = n - p.offset;
    const branch = exact ?? p.options[pluralRules(locale, p.type === 'selectordinal' ? 'ordinal' : 'cardinal').select(shown)] ?? p.options.other;
    out += formatParts(branch, values, locale, shown);
  }
  return out;
}

const parsed = new Map<string, Part[] | MessageError>();

/** `text`, a message, with `values` filled in for `locale`. One that doesn't parse is shown as it is. */
export function formatMessage(text: string, values: Values = {}, locale = 'en'): string {
  let p = parsed.get(text);
  if (!p) {
    try { p = parseMessage(text); } catch (e) { p = e as MessageError; }
    parsed.set(text, p);
  }
  return p instanceof MessageError ? text : formatParts(p, values, locale);
}
