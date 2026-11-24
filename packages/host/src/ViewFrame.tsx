import { useCallback, useMemo, useState } from 'react';
import { useHostRepo, type Repo } from '@gestalts/client';
import { useLang } from '@gestalts/i18n';
import type { JsonMap } from '@gestalts/view';
import { FrameView, type RunnableView } from './frame/FrameView';
import type { ViewEnv } from './frame/bridge';
import { findPlugin, npmUrlsOf, type PluginEntry, type Registry } from './registry';

function readState(key: string): JsonMap {
  try { return JSON.parse(localStorage.getItem(key) ?? '{}') as JsonMap; } catch { return {}; }
}

/** A plugin's view as a frame runs it. */
export function runnable(p: PluginEntry): RunnableView {
  return { id: p.manifest.id, title: p.manifest.title, lang: p.manifest.lang ?? 'en', js: p.js, npm: p.npm, npmUrls: npmUrlsOf(p), scope: { reads: p.manifest.reads ?? [], writes: p.manifest.writes ?? [], network: p.manifest.network ?? [], llm: p.manifest.llm ?? false, microphone: p.granted.includes('microphone') }, granted: p.granted };
}

/** The view's own backend, through the node. */
function serviceFor(repo: Repo, plugin: string): ViewEnv['service'] {
  return async (path, method, body, contentType) => {
    const r = await repo.service(plugin, path, { method, body: body as BodyInit | undefined, headers: contentType ? { 'content-type': contentType } : undefined });
    if (!r) return { status: 503, contentType: 'text/plain', body: new TextEncoder().encode('no node here') };
    return { status: r.status, contentType: r.headers.get('content-type') ?? '', body: new Uint8Array(await r.arrayBuffer()) };
  };
}

/** A view asking to show `view` at `params` (in a new browser tab, if `newTab`); false if it can't be shown. */
export type Navigate = (view: string, params?: Record<string, string>, newTab?: boolean) => boolean;

/**
 * A plugin's view on the repo in context, with its backend, `/net` and `/llm` through the node, and what it last kept
 * (`setState`) in localStorage under `stateKey`.
 */
export function ViewFrame({ registry, css, tailwind, view: id, params, stateKey, csp, hidden = false, navigate, setTitle, setParams }: {
  registry: Registry; css: string; tailwind?: string; view: string; params: Record<string, string>; stateKey: string; csp?: string;
  hidden?: boolean; navigate: Navigate; setTitle: (title: string) => void; setParams: (params: Record<string, string>) => void;
}) {
  const { m } = useLang();
  const repo = useHostRepo();
  const plugin = findPlugin(registry, id);
  const [state] = useState(() => readState(stateKey));
  const env = useMemo<ViewEnv>(() => ({
    service: plugin?.backend ? serviceFor(repo, plugin.manifest.id) : undefined,
    // these ask the node at call time, so connecting later is enough
    net: (r) => repo.net(r),
    llm: (r) => repo.llm(r),
    capabilities: async () => {
      if (!repo.hasNode()) return { net: false, llm: false, backend: false };
      const pid = plugin?.manifest.id;
      const [llm, backend] = await Promise.all([
        repo.llmSettings().then((s) => !!s?.providers.some((p) => p.configured), () => false),
        plugin?.backend ? repo.services().then((list) => !!list?.some((s) => s.id === pid && s.available), () => false) : false,
      ]);
      return { net: true, llm, backend };
    },
    setState: (s) => { try { localStorage.setItem(stateKey, JSON.stringify(s)); } catch { /* not remembered */ } },
    setTitle,
    setParams,
    openView: navigate,
  }), [repo, plugin, stateKey, setTitle, setParams, navigate]);
  const view = useMemo(() => (plugin ? runnable(plugin) : undefined), [plugin]);
  if (!view) return <p className="p-8 text-center text-base-content/60">{m.view_missing({ id })}</p>;
  return <FrameView repo={repo} view={view} runtime={registry.runtime} css={css} tailwind={tailwind} params={params} state={state} env={env} hidden={hidden} csp={csp} wording={plugin?.wording} />;
}

/**
 * One view and nothing else. Its params are its own, or, with `params` and `onParams`, the app's to keep (in the URL,
 * so a link shows the same place).
 */
export function SingleView({ registry, css, view, params: given, onParams }: {
  registry: Registry; css: string; view: string; params?: Record<string, string>; onParams?: (params: Record<string, string>) => void;
}) {
  const [own, setOwn] = useState<Record<string, string>>({});
  const params = given ?? own;
  const noop = useCallback(() => {}, []);
  // there's nowhere else to show
  const navigate = useCallback(() => false, []);
  const move = useCallback((p: Record<string, string>) => (onParams ?? setOwn)(p), [onParams]);
  return <ViewFrame key={view} registry={registry} css={css} view={view} params={params} stateKey={`gestalts-view-state:${registry.distribution.id}:single-${view}`}
                    navigate={navigate} setTitle={noop} setParams={move} />;
}
