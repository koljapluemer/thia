import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { LayoutGrid } from 'lucide-react';
import { me } from './teach/api';

/** The public site (web/site): what the workshops' accepted results, and the learning views, are published on. */
export const SITE: string = import.meta.env.VITE_SITE ?? 'http://127.0.0.1:5177';

/** The app's areas, by path, in the landing page's order; `/` is the landing page. */
export const AREAS = [
  { path: '/teach', title: 'Teacher portal', about: 'Make lessons with an agent and publish them.' },
  { path: '/make', title: 'Learning workshop', about: 'Make learning views with a local agent.' },
  { path: '/make-viz', title: 'vizint workshop', about: 'Make interactive visualizations with a local agent.' },
  { path: '/notes', title: 'Gestalter', about: 'Your notes, and the views you install, in tabs.' },
  { path: '/review', title: 'Review', about: 'What the workshops offered for the public site: accept or reject it.' },
] as const;
/** The areas only admins see. */
const ADMIN: readonly string[] = ['/review'];
export type AreaPath = '/' | (typeof AREAS)[number]['path'];
const HOME: AreaPath = '/';

const listeners = new Set<() => void>();
const areaOf = (pathname: string): AreaPath => AREAS.find((a) => pathname === a.path || pathname.startsWith(`${a.path}/`))?.path ?? HOME;

/** Goes to `path` (an area), keeping what follows it (a view's `#hash`) out: each area starts from its own. */
export function navigate(path: AreaPath) {
  if (location.pathname === path) return;
  history.pushState(null, '', path);
  listeners.forEach((l) => l());
}

/** The area shown: from the path, the landing page `/` for anything else (and the path made to say so). */
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

/** The other areas, from each area's header: at its start, or at its `end`. */
export function Areas({ end = false }: { end?: boolean }) {
  const here = useArea();
  const areas = useAreas();
  return (
    <details className={`dropdown ${end ? 'dropdown-end' : ''}`}>
      <summary className="btn btn-sm btn-ghost btn-square" title="Areas"><LayoutGrid className="size-4" /></summary>
      <ul className="dropdown-content menu z-50 mt-2 w-56 rounded-box border border-base-300 bg-base-100 p-2 shadow">
        <li><AreaLink path="/">All areas</AreaLink></li>
        {areas.map((a) => <li key={a.path}><AreaLink path={a.path} className={a.path === here ? 'menu-active' : ''}>{a.title}</AreaLink></li>)}
        <li><a href={SITE}>The public site</a></li>
      </ul>
    </details>
  );
}
