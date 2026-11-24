import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { registry } from 'virtual:gestalts-plugins';
import { RepoProvider } from '@gestalts/client';
import { ViewFrame, closedCsp, type Navigate } from '@gestalts/host';
import { useLang } from '@gestalts/i18n';
import tailwind from '@tailwindcss/browser?raw';
import css from './app.css?inline';
import { ENTRIES, type Entry } from './Catalog';
import { useHome, viewStatePrefix } from './home';
import { Notice, Spinner } from './Run';
import { rememberRecent } from './recent';
import { GuestBanner, Toolbar } from './Toolbar';

const paramsOfHash = (): Record<string, string> => (location.hash.length > 1 ? Object.fromEntries(new URLSearchParams(location.hash.slice(1))) : {});

/** Where a view asked to go is: its deck's page if it has decks (this one's, if it's the same view), else its own. */
function pathOf(view: string, from: Entry): string | undefined {
  if (view === from.plugin.manifest.id) return from.path;
  return ENTRIES.find((e) => e.plugin.manifest.id === view)?.path;
}

/**
 * One view (`/v/<view>[/<deck>]`) on the user's store, with the deck it's opened on mounted read-only, so what they do
 * is kept with everything else they did: one store for every view. Where the view is (its params) is the URL's hash,
 * so a link opens it there and going back goes back in it.
 */
export function ViewPage({ entry, back, open }: { entry: Entry; back?: () => void; open: (path: string) => void }) {
  const { m } = useLang();
  const { home, dir } = useHome(entry.deck?.source);
  const [title, setTitle] = useState(entry.title);
  useEffect(() => {
    rememberRecent(entry);
    // asked once: Safari deletes what a site stored after a week without a visit, unless it's persisted
    void navigator.storage?.persist?.().catch(() => false);
  }, [entry]);
  useEffect(() => { document.title = title; }, [title]);
  const ready = home.repo && (!entry.deck || home.decks.includes(entry.deck.source));

  return (
    <div className="flex h-dvh flex-col bg-base-200">
      <GuestBanner />
      <header className="flex min-h-0 items-center gap-2 border-b border-base-300 bg-base-100 px-3 py-1">
        {back && (
          <a href="/" className="btn btn-ghost btn-xs btn-square" title={m.back_everything()} aria-label={m.back_everything()} onClick={(e) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey) { e.preventDefault(); back(); } }}>
            <ArrowLeft className="size-4" />
          </a>
        )}
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h1>
        <Toolbar />
      </header>
      <main className="min-h-0 flex-1">
        {home.error && <Notice title={m.data_failed()}>{home.error}</Notice>}
        {!home.error && !ready && <Spinner />}
        {ready && home.repo && (
          <RepoProvider repo={home.repo}>
            <Frame key={`${dir}:${entry.path}`} entry={entry} dir={dir} setTitle={setTitle} open={open} />
          </RepoProvider>
        )}
      </main>
    </div>
  );
}

function Frame({ entry, dir, setTitle, open }: { entry: Entry; dir: string; setTitle: (t: string) => void; open: (path: string) => void }) {
  const [params, setParamsState] = useState(paramsOfHash);
  useEffect(() => {
    const update = () => setParamsState(paramsOfHash());
    addEventListener('popstate', update);
    return () => removeEventListener('popstate', update);
  }, []);
  const setParams = useCallback((p: Record<string, string>) => {
    const hash = new URLSearchParams(p).toString();
    if (hash !== location.hash.slice(1)) history.pushState(history.state, '', `${location.pathname}${hash ? `#${hash}` : ''}`);
    setParamsState(p);
  }, []);
  const navigate = useCallback<Navigate>((view, p, newTab) => {
    const path = pathOf(view, entry);
    if (!path) return false;
    const hash = p && Object.keys(p).length ? `#${new URLSearchParams(p).toString()}` : '';
    if (newTab) {
      const w = window.open(`${path}${hash}`, '_blank');
      if (w) { w.opener = null; return true; }
    }
    if (path === entry.path) { setParams(p ?? {}); return true; }
    open(`${path}${hash}`);
    return true;
  }, [entry, open, setParams]);
  // our own views (granted the site's origin) aside, a view loads nothing but what the build bundled
  const csp = useMemo(() => (entry.plugin.granted.includes('same-origin') ? undefined : closedCsp({ scripts: [new URL('npm/', document.baseURI).href] })), [entry]);
  return (
    <ViewFrame registry={registry} css={css} tailwind={tailwind} view={entry.plugin.manifest.id} params={params} csp={csp}
               stateKey={`${viewStatePrefix(dir)}${entry.path}`} navigate={navigate} setTitle={setTitle} setParams={setParams} />
  );
}
