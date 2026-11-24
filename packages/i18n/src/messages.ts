/**
 * The messages themselves, for code that should carry only those it uses (the kit, in every view's frame): call each
 * with the language, `m.kit_close({}, inLang(lang))`. Apps use `useLang().m` instead.
 */
import { pick } from './lang';
import { LOCALES } from './locales';

export { m } from './paraglide/messages.js';

type Locale = 'en' | 'de' | 'en-XA';

/** The options that put a message in `lang`, or the nearest language the app has (English at last). */
export function inLang(lang: string): { locale: Locale } {
  return { locale: (pick(lang, LOCALES) ?? 'en') as Locale };
}
