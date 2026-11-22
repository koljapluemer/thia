import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { registry } from 'virtual:gestalts-plugins/teacher';
import { useHostQuery, type Repo } from '@gestalts/client';
import type { Belief } from '@gestalts/view';
import { SEQUENCE, asSequence, ruleConcepts, sequenceYml, walk, type Sequence, type Step } from '@gestalts/workshop';
import * as api from './api';
import { DeleteButton, ExportButton, PublishMenu, SyncState } from './DraftPane';
import { OpenDraft } from './open';

/** A lesson goes out as lessons do: the core's gestalts and the lesson models, which `sequence@1` is among. */
const SOURCE = { gestalts: registry.gestalts };
const SAVE_AFTER_MS = 500;

/**
 * A lesson of several views (`sequence@1`): its steps in order, each one of the account's view drafts with at most
 * one rule, checked as a whole by the server, and played through for a pretend student before it goes out.
 */
export function SequencePane({ info, onChanged, onDeleted }: { info: api.DraftInfo; onChanged: () => void; onDeleted: () => void }) {
  const init = useCallback(async (repo: Repo) => { await repo.put(sequenceYml({ id: info.id, title: info.title, steps: [] })); }, [info]);
  return (
    <OpenDraft info={info} source={SOURCE} init={init}>
      {(repo) => <Editor repo={repo} info={info} onChanged={onChanged} onDeleted={onDeleted} />}
    </OpenDraft>
  );
}

function Editor({ repo, info, onChanged, onDeleted }: { repo: Repo; info: api.DraftInfo; onChanged: () => void; onDeleted: () => void }) {
  const item = useHostQuery({ gestalt: SEQUENCE, ids: [info.id], limit: 1 })[0];
  const [edited, setSeq] = useState<Sequence>();
  // the draft as typed: what comes back from the repo only seeds it
  const seq = edited ?? (item ? asSequence(item) : undefined);
  const [report, setReport] = useState<api.SequenceReport>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const refresh = useCallback(() => { void api.sequenceReport(info.id).then(setReport, () => undefined); }, [info.id]);
  useEffect(refresh, [refresh]);

  const change = (next: Sequence) => {
    setSeq(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void (async () => {
        await repo.put(sequenceYml(next));
        await repo.connect(api.draftUrl(info.id));
        refresh();
        if (next.title !== info.title) onChanged();
      })();
    }, SAVE_AFTER_MS);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  if (!seq) return <div className="flex h-full items-center justify-center"><span className="loading loading-spinner" /></div>;
  const setStep = (i: number, s: Step) => change({ ...seq, steps: seq.steps.map((x, j) => (j === i ? s : x)) });
  const move = (i: number, by: number) => {
    const steps = [...seq.steps];
    const [s] = steps.splice(i, 1);
    steps.splice(i + by, 0, s);
    change({ ...seq, steps });
  };
  const views = report?.views ?? [];
  const nameOf = (c: string) => report?.concepts[c] ?? c;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-base-300 bg-base-100 px-3 py-1">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{seq.title}</span>
        <SyncState />
        <PublishMenu repo={repo} id={info.id} agent={false} />
        <ExportButton id={info.id} />
        <DeleteButton id={info.id} title={seq.title} onDeleted={onDeleted} />
      </div>
      <div className="grid min-h-0 flex-1 overflow-y-auto md:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex flex-col gap-3 p-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-base-content/60">Title</span>
            <input className="input input-sm w-full" value={seq.title} onChange={(e) => change({ ...seq, title: e.target.value })} />
          </label>
          <p className="text-xs text-base-content/60">
            Each step is one of your views, played in order. A step may be skipped when the student already knows
            something, or get an extra view first when they struggle with it. Make the views first, as drafts of their
            own.
          </p>
          <ol className="flex flex-col gap-2">
            {seq.steps.map((s, i) => (
              <StepRow key={i} n={i} step={s} views={views} concepts={conceptsBefore(seq.steps, i, views)} nameOf={nameOf} last={i === seq.steps.length - 1}
                       onChange={(x) => setStep(i, x)} onMove={(by) => move(i, by)} onRemove={() => change({ ...seq, steps: seq.steps.filter((_, j) => j !== i) })} />
            ))}
          </ol>
          <button type="button" className="btn btn-sm self-start" disabled={!views.length} onClick={() => change({ ...seq, steps: [...seq.steps, { view: views[0]?.id ?? '' }] })}>
            <Plus className="size-4" /> Add a step
          </button>
          {!views.length && report && <p className="text-xs text-warning">You have no views yet: make one with New → View first.</p>}
          {report && (report.problems.length > 0 || report.warnings.length > 0) && (
            <ul className="flex flex-col gap-1 text-xs">
              {report.problems.map((p) => <li key={p} className="text-error">{p}</li>)}
              {report.warnings.map((w) => <li key={w} className="text-warning">{w}</li>)}
            </ul>
          )}
        </div>
        <PlayThrough steps={seq.steps} views={views} nameOf={nameOf} />
      </div>
    </div>
  );
}

/** The concepts a rule of step `i` may name: what the views practise (earlier ones first, as those make it apply). */
function conceptsBefore(steps: Step[], i: number, views: api.SequenceReport['views']): string[] {
  const of = (id: string) => views.find((v) => v.id === id)?.practises ?? [];
  const earlier = steps.slice(0, i).flatMap((s) => of(s.view));
  return [...new Set([...earlier, ...views.flatMap((v) => v.practises)])];
}

type Rule = 'none' | 'skip' | 'detour';

function StepRow({ n, step, views, concepts, nameOf, last, onChange, onMove, onRemove }: {
  n: number; step: Step; views: api.SequenceReport['views']; concepts: string[]; nameOf: (c: string) => string; last: boolean;
  onChange: (s: Step) => void; onMove: (by: number) => void; onRemove: () => void;
}) {
  const rule: Rule = step.skipIfKnown ? 'skip' : step.detour ? 'detour' : 'none';
  const concept = step.skipIfKnown ?? step.detour?.concept ?? concepts[0] ?? '';
  const setRule = (r: Rule) => onChange({
    view: step.view,
    ...(r === 'skip' ? { skipIfKnown: concept } : {}),
    ...(r === 'detour' ? { detour: { concept, view: step.detour?.view ?? views.find((v) => v.id !== step.view)?.id ?? step.view } } : {}),
  });
  const setConcept = (c: string) => onChange(rule === 'skip' ? { ...step, skipIfKnown: c } : { ...step, detour: { concept: c, view: step.detour!.view } });
  const viewSelect = (value: string, set: (v: string) => void, label: string) => (
    <select className="select select-sm min-w-0 flex-1" aria-label={label} value={value} onChange={(e) => set(e.target.value)}>
      {!views.some((v) => v.id === value) && <option value={value}>{value || 'Pick a view'}</option>}
      {views.map((v) => <option key={v.id} value={v.id}>{v.title || v.id}</option>)}
    </select>
  );
  return (
    <li className="flex flex-col gap-2 rounded-box border border-base-300 bg-base-100 p-2">
      <div className="flex items-center gap-1">
        <span className="badge badge-sm">{n + 1}</span>
        {viewSelect(step.view, (v) => onChange({ ...step, view: v }), `Step ${n + 1}'s view`)}
        <button type="button" className="btn btn-ghost btn-xs btn-square" disabled={n === 0} title="Earlier" onClick={() => onMove(-1)}><ArrowUp className="size-3.5" /></button>
        <button type="button" className="btn btn-ghost btn-xs btn-square" disabled={last} title="Later" onClick={() => onMove(1)}><ArrowDown className="size-3.5" /></button>
        <button type="button" className="btn btn-ghost btn-xs btn-square" title="Remove the step" onClick={onRemove}><X className="size-3.5" /></button>
      </div>
      <div className="flex flex-wrap items-center gap-1 text-xs">
        <select className="select select-xs" aria-label="Rule" value={rule} onChange={(e) => setRule(e.target.value as Rule)}>
          <option value="none">Always</option>
          <option value="skip">Skip if they know</option>
          <option value="detour">Extra view first if they struggle with</option>
        </select>
        {rule !== 'none' && (
          <select className="select select-xs min-w-0" aria-label="Concept" value={concept} onChange={(e) => setConcept(e.target.value)}>
            {!concepts.includes(concept) && <option value={concept}>{concept || 'No concept yet'}</option>}
            {concepts.map((c) => <option key={c} value={c}>{nameOf(c)}</option>)}
          </select>
        )}
        {rule === 'detour' && step.detour && <span className="flex min-w-40 flex-1 items-center gap-1">: {viewSelect(step.detour.view, (v) => onChange({ ...step, detour: { concept: step.detour!.concept, view: v } }), 'The extra view')}</span>}
      </div>
    </li>
  );
}

type Pretend = 'new' | 'knows' | 'struggles';

/**
 * The lesson as a pretend student meets it: one who knows nothing yet, or who knows a concept, or struggles with it.
 * Their beliefs stay as chosen; a real student's change as they go.
 */
function PlayThrough({ steps, views, nameOf }: { steps: Step[]; views: api.SequenceReport['views']; nameOf: (c: string) => string }) {
  const concepts = useMemo(() => ruleConcepts(steps), [steps]);
  const [who, setWho] = useState<Pretend>('new');
  const [concept, setConcept] = useState('');
  const c = concepts.includes(concept) ? concept : concepts[0] ?? '';
  const belief = (p: number): Belief => ({ concept: c, mean: 0, sd: 1, p, evidence: 5 });
  const beliefOf = (x: string) => (who === 'new' || x !== c ? undefined : belief(who === 'knows' ? 0.95 : 0.2));
  const title = (id: string) => views.find((v) => v.id === id)?.title ?? id;
  const path = walk(steps, beliefOf);
  return (
    <aside className="flex flex-col gap-2 border-t border-base-300 bg-base-100 p-3 text-sm md:border-t-0 md:border-l">
      <h2 className="font-medium">Play it through</h2>
      <div className="flex flex-wrap items-center gap-1 text-xs">
        <span>A student who</span>
        <select className="select select-xs" aria-label="Who" value={who} onChange={(e) => setWho(e.target.value as Pretend)}>
          <option value="new">is new to all of it</option>
          <option value="knows" disabled={!concepts.length}>knows</option>
          <option value="struggles" disabled={!concepts.length}>struggles with</option>
        </select>
        {who !== 'new' && (
          <select className="select select-xs min-w-0" aria-label="Concept" value={c} onChange={(e) => setConcept(e.target.value)}>
            {concepts.map((x) => <option key={x} value={x}>{nameOf(x)}</option>)}
          </select>
        )}
      </div>
      <ol className="flex flex-col gap-1">
        {path.map(({ step, decision }) => (
          <li key={step} className={decision.kind === 'skip' ? 'text-base-content/50 line-through' : ''}>
            {decision.kind === 'detour' && <span className="block text-info">+ extra: {title(decision.view)}</span>}
            {step + 1}. {title(steps[step].view)}
            {decision.kind === 'skip' && <span className="ml-1 text-xs no-underline">(skipped)</span>}
          </li>
        ))}
      </ol>
      {!steps.length && <p className="text-xs text-base-content/60">No steps yet.</p>}
    </aside>
  );
}
