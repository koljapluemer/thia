/**
 * What makes text work in every language, as rules both the linter (oxlint, `packages/check/lint/i18n.ts`, over this
 * repo) and the check of an agent's view (`checkView`, where no linter runs) apply. Only the judging lives here; each
 * walks its own syntax tree.
 */

/**
 * Text that's the same in every language: punctuation, symbols, the product's name. Anything else a person reads comes
 * from the messages (the app) or the wording (a view).
 */
export const ALLOWED_TEXT = ['thia', 'gestalts-node', '·', '–', '—', '/', '…', '×', '÷', ':', ',', '.', '(', ')', '+', '-', '=', '%', '?', '!', '→', '←', '↑', '↓', '✓', '✗', '#', '$', '≈', '|', '*', '&', '@'];

/** The attributes a person reads or hears. */
export const TEXT_ATTRIBUTES = ['aria-label', 'title', 'alt', 'placeholder', 'label', 'aria-description', 'aria-placeholder', 'aria-roledescription', 'aria-valuetext'];

/** Whether `text` (from JSX) is something a person reads in a language: not blank, not only what's allowed. */
export function isText(text: string): boolean {
  const t = text.trim();
  if (!t || ALLOWED_TEXT.includes(t)) return false;
  // digits, punctuation and symbols alone read the same everywhere
  return /\p{L}/u.test(t);
}

/**
 * Tailwind's physical left/right utilities and their logical ones, which turn around for right-to-left languages
 * (Arabic, Urdu). Variants (`md:`, `hover:`) and a negative (`-ml-2`) are kept.
 */
const PHYSICAL: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^(-?)(m|p|scroll-m|scroll-p)([lr])-(.+)$/, (m) => `${m[1]}${m[2]}${m[3] === 'l' ? 's' : 'e'}-${m[4]}`],
  [/^(-?)(left|right)-(.+)$/, (m) => `${m[1]}${m[2] === 'left' ? 'start' : 'end'}-${m[3]}`],
  [/^border-([lr])(-.+)?$/, (m) => `border-${m[1] === 'l' ? 's' : 'e'}${m[2] ?? ''}`],
  [/^rounded-([lr])(-.+)?$/, (m) => `rounded-${m[1] === 'l' ? 's' : 'e'}${m[2] ?? ''}`],
  [/^rounded-(tl|tr|bl|br)(-.+)?$/, (m) => `rounded-${({ tl: 'ss', tr: 'se', bl: 'es', br: 'ee' } as Record<string, string>)[m[1]]}${m[2] ?? ''}`],
  [/^(text|float|clear)-(left|right)$/, (m) => `${m[1]}-${m[2] === 'left' ? 'start' : 'end'}`],
];

/** In a `className`'s text, each physical utility and the logical one to use instead. */
export function physicalClasses(className: string): { found: string; use: string }[] {
  const out: { found: string; use: string }[] = [];
  for (const token of className.split(/\s+/)) {
    if (!token) continue;
    const at = token.lastIndexOf(':');
    const variants = token.slice(0, at + 1);
    const bang = token[at + 1] === '!' ? '!' : '';
    const base = token.slice(at + 1 + bang.length);
    for (const [re, logical] of PHYSICAL) {
      const m = base.match(re);
      if (m) { out.push({ found: token, use: `${variants}${bang}${logical(m)}` }); break; }
    }
  }
  return out;
}

/** A `style` prop's physical left/right properties and their logical ones. */
export const PHYSICAL_STYLE: Record<string, string> = {
  marginLeft: 'marginInlineStart', marginRight: 'marginInlineEnd', paddingLeft: 'paddingInlineStart', paddingRight: 'paddingInlineEnd',
  left: 'insetInlineStart', right: 'insetInlineEnd', borderLeft: 'borderInlineStart', borderRight: 'borderInlineEnd',
  borderLeftWidth: 'borderInlineStartWidth', borderRightWidth: 'borderInlineEndWidth', borderLeftColor: 'borderInlineStartColor', borderRightColor: 'borderInlineEndColor',
};

/** Formatting that takes the device's language unless told one: the app's text is in the app's language. */
export const LOCALE_METHODS = ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'];
export const INTL_FORMATS = ['NumberFormat', 'DateTimeFormat', 'RelativeTimeFormat', 'ListFormat', 'PluralRules', 'DisplayNames', 'Collator', 'Segmenter'];

export const MESSAGES = {
  text: (t: string) => `“${t.trim().slice(0, 40)}” is text a person reads: take it from the messages (the app) or t() (a view), in their language`,
  physical: (found: string, use: string) => `${found} is left or right whatever the language: use ${use}, which turns around for right-to-left text`,
  locale: (what: string) => `${what} without a locale formats in the device's language, not the page's: pass the language (useLang().lang, or useLocale().locale in a view)`,
};
