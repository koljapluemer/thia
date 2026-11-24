import { useMemo } from 'react';
import { useLocale } from '@gestalts/view';
import { inLang } from '@gestalts/i18n/messages';

export { m } from '@gestalts/i18n/messages';

/** What puts the kit's own text in the view's language: `m.kit_close({}, at)`. */
export function useAt() {
  const { lang } = useLocale();
  return useMemo(() => inLang(lang), [lang]);
}
