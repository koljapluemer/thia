import { LayoutGrid } from 'lucide-react';
import { LangPicker, useLang } from '@gestalts/i18n';

export const SITE: string = import.meta.env.VITE_SITE ?? '/';

export function Areas() {
  const { m } = useLang();
  return (
    <span className="flex items-center">
      <a href={SITE} className="btn btn-sm btn-ghost" aria-label={m.areas_site()} title={m.areas_site()}><LayoutGrid className="size-4" /></a>
      <LangPicker />
    </span>
  );
}
