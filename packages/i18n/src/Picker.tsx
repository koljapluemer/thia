import { Check, Languages } from 'lucide-react';
import { nativeName } from './lang';
import { AVAILABLE, useLang } from './react';

/**
 * The app's language, for a person to choose: each language named in itself, and "as this device" to follow the
 * browser again. The choice is kept on the device.
 */
export function LangPicker({ className = '' }: { className?: string }) {
  const { lang, m, choice, setLang } = useLang();
  const item = (value: string | null, label: string, active: boolean) => (
    <li key={value ?? ''}>
      <button type="button" lang={value ?? undefined} onClick={() => setLang(value)}>
        <Check className={`size-4 ${active ? '' : 'invisible'}`} />{label}
      </button>
    </li>
  );
  return (
    <div className={`dropdown dropdown-end ${className}`}>
      <button type="button" tabIndex={0} className="btn btn-ghost btn-sm btn-square" title={m.lang_picker()} aria-label={m.lang_picker()}>
        <Languages className="size-4" />
      </button>
      <ul tabIndex={0} className="dropdown-content menu bg-base-100 rounded-box z-10 w-52 p-2 shadow">
        {item(null, m.lang_device(), choice === null)}
        {AVAILABLE.map((l) => item(l, nativeName(l), choice !== null && l === lang))}
      </ul>
    </div>
  );
}
