import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, RotateCcw, Sparkles } from 'lucide-react';
import { registry } from 'virtual:gestalts-plugins';
import { useOpenRepo, type Repo } from '@gestalts/client';
import { FrameView, closedCsp, type RunnableView, type ViewEnv } from '@gestalts/host';
import { useLang, type Messages } from '@gestalts/i18n';
import type { Belief, JsonMap } from '@gestalts/view';
import type { LessonManifest, SequenceManifest } from '@gestalts/workshop/lesson';
import { decide, type Step } from '@gestalts/workshop/sequence';
import tailwind from '@tailwindcss/browser?raw';
import css from './app.css?inline';
import { forget } from './home';
import { Notice, Spinner } from './Run';
import { store } from './store';

/** A lesson of several views as loaded: its manifest, and each view with where its deck is. */
export type LoadedSequence = { id: string; manifest: SequenceManifest; views: { manifest: LessonManifest; base: string; js: string }[] };

/**
 * Where a learner is: the step, whether its detour is playing, the steps skipped and those that got a detour, each
 * with the concept that decided it. Kept on this device, so a reload goes on where they were.
 */
type At = { step: number; detour: boolean; skipped: Record<number, string>; extra: Record<number, string> };
const START: At = { step: 0, detour: false, skipped: {}, extra: {} };

/**
 * A lesson of several views, under one link: played in order, a step skipped when its concept is known, a detour
 * played first when the learner struggles with one. One folder on this device for the whole lesson, so what one step
 * practises counts in the next. Going back is always allowed, and a skipped step can be done anyway.
 */
export function SequencePage({ lesson }: { lesson: LoadedSequence }) {
  const { m } = useLang();
  const { id, manifest } = lesson;
  const keys = useMemo(() => ({ generation: `player:generation:${id}`, at: `player:at:${id}`, state: (n: number) => `player:state:${id}:${n}` }), [id]);
  const [generation, setGeneration] = useState(() => Number(store.get(keys.generation) ?? 0) || 0);
  const dir = generation ? `lesson-${id}-${generation}` : `lesson-${id}`;
  const source = useMemo(() => ({
    dir,
    decks: lesson.views.map((v, n) => ({ source: `lesson/${id}/${n}`, url: new URL(v.base, location.origin).href.replace(/\/$/, '') })),
    gestalts: registry.gestalts,
  }), [dir, id, lesson.views]);
  const { repo, error } = useOpenRepo(source);
  useEffect(() => {
    document.title = manifest.title;
    void navigator.storage?.persist?.().catch(() => false);
  }, [manifest.title]);

  const startFresh = () => {
    if (!confirm(m.run_start_fresh_confirm())) return;
    const old = { dir, repo };
    store.set(keys.generation, String(generation + 1));
    store.remove(keys.at);
    lesson.views.forEach((_, n) => store.remove(keys.state(n)));
    setGeneration(generation + 1);
    void forget(old.dir, old.repo);
  };

  return (
    <div className="flex h-dvh flex-col bg-base-200">
      <header className="flex min-h-0 items-center gap-2 border-b border-base-300 bg-base-100 px-3 py-1">
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{manifest.title}</h1>
        <button type="button" className="btn btn-ghost btn-xs" onClick={startFresh} title={m.run_start_fresh_title()}>
          <RotateCcw className="size-3.5" /> {m.run_start_fresh()}
        </button>
      </header>
      {error && <Notice title={m.run_data_failed()}>{error}</Notice>}
      {!error && !repo && <Spinner />}
      {repo && <Player key={dir} repo={repo} lesson={lesson} keys={keys} />}
    </div>
  );
}

const steps = (m: SequenceManifest): Step[] => m.steps.map((s) => ({
  view: String(s.view), skipIfKnown: s.skipIfKnown, detour: s.detour && { concept: s.detour.concept, view: String(s.detour.view) },
}));

/** What's known about `concepts` now, once. */
async function beliefsNow(repo: Repo, concepts: string[]): Promise<Map<string, Belief>> {
  if (!concepts.length) return new Map();
  const live = await repo.liveBeliefs(concepts, () => {});
  live.stop();
  return new Map(live.beliefs.map((b) => [b.concept, b]));
}

/** Why a step was skipped, or got a detour: what's known of its concept, in the page's language. */
const known = (m: Messages, concept: string) => m.seq_known({ concept });
const struggling = (m: Messages, concept: string) => m.seq_struggling({ concept });

function Player({ repo, lesson, keys }: { repo: Repo; lesson: LoadedSequence; keys: { at: string; state: (n: number) => string } }) {
  const { m } = useLang();
  const { manifest, views } = lesson;
  const all = useMemo(() => steps(manifest), [manifest]);
  const [at, setAt] = useState<At>(() => { try { return { ...START, ...(JSON.parse(store.get(keys.at) ?? 'null') as At | null) }; } catch { return START; } });
  const [busy, setBusy] = useState(false);
  const keep = useCallback((a: At) => { setAt(a); store.set(keys.at, JSON.stringify(a)); }, [keys.at]);

  /** Arriving at `step` going forward: its rule decides whether it's played, skipped, or a detour comes first. */
  const arrive = useCallback(async (from: At, step: number) => {
    setBusy(true);
    try {
      const next: At = { ...from, skipped: { ...from.skipped }, extra: { ...from.extra } };
      for (let i = step; i < all.length; i++) {
        const s = all[i];
        const concept = s.skipIfKnown ?? s.detour?.concept;
        const beliefs = await beliefsNow(repo, concept ? [concept] : []);
        const d = decide(s, (c) => beliefs.get(c));
        delete next.skipped[i];
        if (d.kind === 'skip') { next.skipped[i] = d.concept; continue; }
        if (d.kind === 'detour') next.extra[i] = d.concept;
        else delete next.extra[i];
        keep({ ...next, step: i, detour: d.kind === 'detour' });
        return;
      }
      keep({ ...next, step: all.length, detour: false });
    } finally {
      setBusy(false);
    }
  }, [all, repo, keep]);

  const next = useCallback(() => {
    if (busy) return;
    if (at.detour) keep({ ...at, detour: false });
    else void arrive(at, at.step + 1);
  }, [at, busy, keep, arrive]);
  const back = () => {
    if (at.detour) return;
    // the step before, as it is, whatever its rule said
    const prev = Math.min(at.step, all.length) - 1;
    if (prev >= 0) keep({ ...at, step: prev, detour: false, skipped: Object.fromEntries(Object.entries(at.skipped).filter(([k]) => Number(k) !== prev)) });
  };
  const anyway = (step: number) => keep({ ...at, step, detour: false, skipped: Object.fromEntries(Object.entries(at.skipped).filter(([k]) => Number(k) !== step)) });

  const finished = at.step >= all.length;
  const viewIndex = finished ? -1 : Number(at.detour ? all[at.step].detour!.view : all[at.step].view);
  return (
    <>
      <nav className="flex flex-wrap items-center gap-1 border-b border-base-300 bg-base-100 px-3 py-1 text-xs" aria-label={m.seq_steps()}>
        <button type="button" className="btn btn-ghost btn-xs btn-square" disabled={at.detour || at.step === 0} onClick={back} title={m.seq_back()} aria-label={m.seq_back()}><ArrowLeft className="size-4" /></button>
        <ol className="flex flex-1 flex-wrap items-center gap-1">
          {all.map((_, i) => {
            const skipped = at.skipped[i];
            const here = i === at.step && !finished;
            return (
              <li key={i}>
                {skipped
                  ? <button type="button" className="badge badge-ghost badge-sm line-through" title={m.seq_skipped_title({ why: known(m, skipped) })} onClick={() => anyway(i)}>{i + 1}</button>
                  : <span className={`badge badge-sm ${here ? 'badge-primary' : i < at.step ? 'badge-success' : 'badge-outline'}`}>{i < at.step && !here ? <Check className="size-3" /> : i + 1}</span>}
              </li>
            );
          })}
        </ol>
        {!finished && <span className="text-base-content/60">{m.seq_step_of({ step: at.step + 1, count: all.length })}</span>}
        {!finished && <button type="button" className="btn btn-primary btn-xs" disabled={busy} onClick={next}>{m.seq_next()} <ArrowRight className="size-3.5" /></button>}
      </nav>
      {at.detour && <p role="status" className="flex items-center gap-1 bg-info/10 px-3 py-1 text-xs"><Sparkles className="size-3.5" /> {m.seq_detour({ why: struggling(m, at.extra[at.step]), step: at.step + 1 })}</p>}
      {!at.detour && Object.entries(at.skipped).filter(([k]) => Number(k) === at.step - 1).map(([k, why]) => (
        <p key={k} role="status" className="bg-base-100 px-3 py-1 text-xs text-base-content/70">{m.seq_was_skipped({ step: Number(k) + 1, why: known(m, why) })} <button type="button" className="link" onClick={() => anyway(Number(k))}>{m.seq_anyway()}</button></p>
      ))}
      <main className="min-h-0 flex-1">
        {busy && <Spinner />}
        {!busy && finished && (
          <Notice title={m.seq_done()}>
            {m.seq_done_text()}{Object.keys(at.skipped).length > 0 && <> {m.seq_done_skipped()}</>}{' '}
            <button type="button" className="link" onClick={() => anyway(0)}>{m.seq_restart()}</button>
          </Notice>
        )}
        {!busy && !finished && <StepFrame key={`${at.step}-${at.detour}`} repo={repo} n={viewIndex} view={views[viewIndex]} stateKey={keys.state(viewIndex)} onDone={next} />}
      </main>
    </>
  );
}

/** One step's view; its `done` goes on to the next step. */
function StepFrame({ repo, n, view, stateKey, onDone }: { repo: Repo; n: number; view: LoadedSequence['views'][number]; stateKey: string; onDone: () => void }) {
  const [state] = useState<JsonMap>(() => { try { return JSON.parse(store.get(stateKey) ?? '{}') as JsonMap; } catch { return {}; } });
  const [params, setParams] = useState<Record<string, string>>(() => view.manifest.params ?? {});
  // the frame keeps its env: what's done goes to the step as it is now
  const done = useRef(onDone);
  useEffect(() => { done.current = onDone; }, [onDone]);
  const runnable = useMemo<RunnableView>(() => ({
    id: `lesson-view-${n}`,
    title: view.manifest.title,
    lang: view.manifest.lang,
    js: view.js,
    npm: Object.keys(view.manifest.npm),
    npmUrls: Object.fromEntries(Object.entries(view.manifest.npm).map(([spec, path]) => [spec, new URL(path, location.origin).href])),
    scope: { reads: view.manifest.reads, writes: view.manifest.writes },
  }), [n, view]);
  const env = useMemo<ViewEnv>(() => ({
    setState: (s) => store.set(stateKey, JSON.stringify(s)),
    setTitle: () => {},
    setParams,
    openView: () => false,
    done: () => { done.current(); return true; },
  }), [stateKey]);
  const csp = useMemo(() => closedCsp({ scripts: [`${location.origin}/npm/`] }), []);
  return <FrameView repo={repo} view={runnable} runtime={registry.runtime} css={css} tailwind={tailwind} params={params} state={state} env={env} csp={csp} />;
}
