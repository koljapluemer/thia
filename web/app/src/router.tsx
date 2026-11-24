import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { LayoutGrid } from 'lucide-react';
import { LangPicker, useLang, type Messages } from '@gestalts/i18n';
import { me } from './workshop/api';

/** The use app (web/site): every view, the user's notes, what the workshops' accepted results are published on. The
 * same origin when deployed. */
export const SITE: string = import.meta.env.VITE_SITE ?? '/';

/** The app's areas, by path; any other path is the workshop. */
export const AREAS = [{ path: '/workshop' }, { path: '/review' }, { path: '/runs' }] as const;
/** An area's name and what it's for, in the app's language. */
export const areaText = (m: Messages, path: AreaPath) => ({
  '/workshop': { title: m.area_workshop(), about: m.area_workshop_about() },
  '/review': { title: m.area_review(), about: m.area_review_about() },
  '/runs': { title: m.area_runs(), about: m.area_runs_about() },
})[path];
/** The areas only admins see. */
const ADMIN: readonly string[] = ['/review', '/runs'];
export type AreaPath = (typeof AREAS)[number]['path'];
const HOME: AreaPath = '/workshop';

const listeners = new Set<() => void>();
const areaOf = (pathname: string): AreaPath => AREAS.find((a) => pathname === a.path || pathname.startsWith(`${a.path}/`))?.path ?? HOME;

/** Goes to `path` (an area), keeping what follows it (a view's `#hash`) out: each area starts from its own. */
export function navigate(path: AreaPath) {
  if (location.pathname === path) return;
  history.pushState(null, '', path);
  listeners.forEach((l) => l());
}

/** The area shown: from the path, the workshop for anything else (and the path made to say so). */
export function useArea(): AreaPath {
  const [area, setArea] = useState(() => areaOf(location.pathname));
  useEffect(() => {
    const update = () => setArea(areaOf(location.pathname));
    listeners.add(update);
    addEventListener('popstate', update);
    if (location.pathname !== areaOf(location.pathname)) history.replaceState(null, '', `${areaOf(location.pathname)}${location.hash}`);
    return () => { listeners.delete(update); removeEventListener('popstate', update); };
  }, []);
  return area;
}

/** A link to an area; a plain link for a new tab and the like. */
export function AreaLink({ path, className, children }: { path: AreaPath; className?: string; children: ReactNode }) {
  const go = (e: MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    (e.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open');
    navigate(path);
  };
  return <a href={path} className={className} onClick={go}>{children}</a>;
}

let admin: Promise<boolean> | undefined;

/** The areas this person sees: the admin's only to an admin (asked once). */
export function useAreas(): (typeof AREAS)[number][] {
  const [isAdmin, setAdmin] = useState(false);
  useEffect(() => {
    admin ??= me().then((m) => m.admin, () => { admin = undefined; return false; });
    void admin.then(setAdmin);
  }, []);
  return AREAS.filter((a) => isAdmin || !ADMIN.includes(a.path));
}

/** The other areas, from each area's header: at its start, or at its `end`; and the app's language. */
export function Areas({ end = false }: { end?: boolean }) {
  const { m } = useLang();
  const here = useArea();
  const areas = useAreas();
  return (
    <span className="flex items-center">
      {end && <LangPicker />}
      <details className={`dropdown ${end ? 'dropdown-end' : ''}`}>
        <summary className="btn btn-sm btn-ghost btn-square" title={m.areas()} aria-label={m.areas()}><LayoutGrid className="size-4" /></summary>
        <ul className="dropdown-content menu z-50 mt-2 w-56 rounded-box border border-base-300 bg-base-100 p-2 shadow">
          {areas.map((a) => <li key={a.path}><AreaLink path={a.path} className={a.path === here ? 'menu-active' : ''}>{areaText(m, a.path).title}</AreaLink></li>)}
          <li><a href={SITE}>{m.areas_site()}</a></li>
        </ul>
      </details>
      {!end && <LangPicker />}
    </span>
  );
}
