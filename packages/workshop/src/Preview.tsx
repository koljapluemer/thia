import { useEffect, useMemo, useState } from 'react';
import { FrameView, type FrameRuntime, type RunnableView, type ViewEnv } from '@gestalts/host';
import { useHostQuery, type Repo } from '@gestalts/client';
import type { JsonMap, ViewError } from '@gestalts/view';
import { compile } from '@gestalts/view/compile';
import { WORDING, asWording, type Wording } from '@gestalts/view/wording';
import type { Draft } from './draft';

// a preview shows one view, and nothing else to open
const ENV: ViewEnv = { setState: () => {}, setTitle: () => {}, setParams: () => {}, openView: () => false };
const STATE: JsonMap = {};

/** Where each npm import of a view is loaded from, given the versions the draft pins. */
export type ResolveNpm = (imports: string[], versions: Record<string, string>) => Promise<Record<string, string>>;

/**
 * A draft's view, compiled in the browser and run the way any view runs, against `repo`. `css` and `tailwind` are what
 * the app's views are styled with. With `resolveNpm`, its npm imports come from where that says (else esm.sh); with
 * `csp`, the frame runs under that policy, as a published lesson does.
 */
export function Preview({ repo, draft, runtime, css, tailwind, onError, resolveNpm, csp, textLang, onPick }: {
  repo: Repo; draft: Draft; runtime: FrameRuntime; css: string; tailwind?: string; onError: (e: ViewError) => void;
  resolveNpm?: ResolveNpm; csp?: string;
  /** its text in this language, as its maker previews a translation; else the app's */
  textLang?: string;
  /** its maker is rewording it: an alt-click on its text names the keys showing there */
  onPick?: (keys: string[]) => void;
}) {
  const compiled = useMemo(() => compile(draft.source), [draft.source]);
  // its text, each layer, as its members have it (a draft has few)
  const wordingItems = useHostQuery({ gestalt: WORDING, ids: draft.members, limit: 50 });
  const wording = useMemo<Wording[]>(() => wordingItems.flatMap((i) => asWording(i.value) ?? []), [wordingItems]);
  const npmKey = compiled.ok ? JSON.stringify([compiled.npm, draft.npm]) : '';
  const [npm, setNpm] = useState<{ key: string; urls?: Record<string, string>; error?: string }>();
  useEffect(() => {
    if (!resolveNpm || !compiled.ok || compiled.npm.length === 0) return;
    let live = true;
    resolveNpm(compiled.npm, draft.npm).then(
      (urls) => { if (live) setNpm({ key: npmKey, urls }); },
      (e: unknown) => { if (live) setNpm({ key: npmKey, error: e instanceof Error ? e.message : String(e) }); },
    );
    return () => { live = false; };
  }, [resolveNpm, compiled, draft.npm, npmKey]);
  const npmError = npm?.key === npmKey ? npm.error : undefined;
  const failure = compiled.ok ? npmError && `npm: ${npmError}` : compiled.errors.map((e) => (e.line ? `line ${e.line}: ${e.message}` : e.message)).join('\n');
  useEffect(() => {
    if (failure) onError({ kind: 'compile', message: failure, at: new Date().toISOString() });
  }, [failure, onError]);
  const waiting = Boolean(resolveNpm && compiled.ok && compiled.npm.length > 0 && npm?.key !== npmKey);
  const npmUrls = npm?.key === npmKey ? npm.urls : undefined;
  const runnable = useMemo<RunnableView | undefined>(() => (compiled.ok
    ? { id: draft.id, title: draft.title, lang: draft.lang, js: compiled.js, npm: compiled.npm, npmUrls, scope: { reads: draft.reads, writes: draft.writes } }
    : undefined), [compiled, npmUrls, draft.id, draft.title, draft.lang, draft.reads, draft.writes]);
  if (failure) return <div role="alert" className="alert alert-error m-4 font-mono text-sm whitespace-pre-wrap">{failure}</div>;
  if (waiting || !runnable) return <div className="flex h-full items-center justify-center"><span className="loading loading-spinner" /></div>;
  return <FrameView key={runnable.js} repo={repo} view={runnable} runtime={runtime} css={css} tailwind={tailwind} params={{}} state={STATE} env={ENV} onError={onError} csp={csp} wording={wording} textLang={textLang} onPick={onPick} />;
}
