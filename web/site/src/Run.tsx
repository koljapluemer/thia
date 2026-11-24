import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowLeft, RotateCcw } from 'lucide-react';
import { registry } from 'virtual:gestalts-plugins';
import { useOpenRepo, type DeckSource, type Repo } from '@gestalts/client';
import { FrameView, type RunnableView, type ViewEnv } from '@gestalts/host';
import { useLang } from '@gestalts/i18n';
import type { JsonMap } from '@gestalts/view';
import type { Wording } from '@gestalts/view/wording';
import tailwind from '@tailwindcss/browser?raw';
import css from './app.css?inline';
import { forget } from './home';
import { store } from './store';

/** What a published lesson's page runs: one view on one deck, with what it did kept on this device under `dir`. */
export type Run = {
  title: string;
  /** names this device's own data for it: the OPFS folder, and the keys of its state and generation */
  dir: string;
  keys: { state: string; generation: string };
  /** the data it opens on, read-only */
  deck: DeckSource;
  view: RunnableView;
  /** where the view starts, when the link doesn't say */
  params?: Record<string, string>;
  csp?: string;
  /** a way back, where there's somewhere to go back to */
  back?: () => void;
  /** the view's own text, each layer */
  wording?: Wording[];
};

/**
 * One view on one deck: what a learner does stays on this device, in a folder of its own (OPFS), with the deck's ymls
 * mounted read-only under it, so a new version of the deck keeps it. "Start fresh" switches to a new folder, for the
 * next person on a shared device.
 */
export function RunPage({ run }: { run: Run }) {
  const { m } = useLang();
  const [generation, setGeneration] = useState(() => Number(store.get(run.keys.generation) ?? 0) || 0);
  const dir = generation ? `${run.dir}-${generation}` : run.dir;
  const source = useMemo(() => ({ dir, decks: [run.deck], gestalts: registry.gestalts }), [dir, run.deck]);
  const { repo, error } = useOpenRepo(source);
  useEffect(() => {
    document.title = run.title;
    // asked once: Safari deletes what a site stored after a week without a visit, unless it's persisted
    void navigator.storage?.persist?.().catch(() => false);
  }, [run.title]);

  const startFresh = () => {
    if (!confirm(m.run_start_fresh_confirm())) return;
    const old = { dir, repo };
    store.set(run.keys.generation, String(generation + 1));
    store.remove(run.keys.state);
    setGeneration(generation + 1);
    void forget(old.dir, old.repo);
  };

  return (
    <div className="flex h-dvh flex-col bg-base-200">
      <header className="flex min-h-0 items-center gap-2 border-b border-base-300 bg-base-100 px-3 py-1">
        {run.back && (
          <a href="/" className="btn btn-ghost btn-xs btn-square" title={m.back_everything()} aria-label={m.back_everything()} onClick={(e) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey) { e.preventDefault(); run.back?.(); } }}>
            <ArrowLeft className="size-4" />
          </a>
        )}
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{run.title}</h1>
        <button type="button" className="btn btn-ghost btn-xs" onClick={startFresh} title={m.run_start_fresh_title()}>
          <RotateCcw className="size-3.5" /> {m.run_start_fresh()}
        </button>
      </header>
      <main className="min-h-0 flex-1">
        {error && <Notice title={m.run_data_failed()}>{error}</Notice>}
        {!error && !repo && <Spinner />}
        {repo && <Frame key={dir} repo={repo} run={run} />}
      </main>
    </div>
  );
}

const paramsOfHash = (start: Record<string, string> = {}): Record<string, string> => (location.hash.length > 1 ? Object.fromEntries(new URLSearchParams(location.hash.slice(1))) : start);

/** The view, where it is (its params) in the URL's hash: a link opens it there, and going back goes back in it. */
function Frame({ repo, run }: { repo: Repo; run: Run }) {
  const [state] = useState<JsonMap>(() => { try { return JSON.parse(store.get(run.keys.state) ?? '{}') as JsonMap; } catch { return {}; } });
  const [params, setParams] = useState(() => paramsOfHash(run.params));
  useEffect(() => {
    const update = () => setParams(paramsOfHash(run.params));
    addEventListener('popstate', update);
    return () => removeEventListener('popstate', update);
  }, [run.params]);
  const env = useMemo<ViewEnv>(() => ({
    setState: (s) => store.set(run.keys.state, JSON.stringify(s)),
    setTitle: () => {},
    setParams: (p) => {
      const hash = new URLSearchParams(p).toString();
      if (hash !== location.hash.slice(1)) history.pushState(null, '', `${location.pathname}${hash ? `#${hash}` : ''}`);
      setParams(p);
    },
    openView: () => false,
  }), [run.keys.state]);
  return <FrameView repo={repo} view={run.view} runtime={registry.runtime} css={css} tailwind={tailwind} params={params} state={state} env={env} csp={run.csp} wording={run.wording} />;
}

export function Spinner() {
  return <div className="flex h-full min-h-dvh items-center justify-center"><span className="loading loading-spinner" /></div>;
}

export function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex h-dvh items-center justify-center bg-base-200 p-4">
      <div role="status" className="max-w-sm rounded-box bg-base-100 p-6 text-center shadow">
        <h1 className="mb-2 text-lg font-semibold">{title}</h1>
        <p className="text-base-content/70">{children}</p>
      </div>
    </div>
  );
}
