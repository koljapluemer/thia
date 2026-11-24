import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Download, RefreshCw, X } from 'lucide-react';
import { lineDiff } from '@gestalts/workshop';
import { AreaLink, Areas } from '../router';
import * as workshop from '../workshop/api';
import * as api from './api';

/**
 * Agent runs, for admins: every turn any backend took, as the workshop page recorded it (`doc/workshop/runs.md`):
 * the runs summed by backend, model, kind or day; a page of them, filtered; one of them as it went, with what it was
 * sent, what it did, what it changed, its raw stream, and notes. What's picked is kept in the address, so a view of
 * it can be linked.
 */
export function Runs() {
  const [me, setMe] = useState<workshop.Me | null>();
  useEffect(() => { workshop.me().then(setMe, () => setMe(null)); }, []);
  return (
    <div className="flex h-dvh flex-col bg-base-200 text-sm">
      <header className="navbar min-h-0 gap-3 border-b border-base-300 bg-base-100 px-4 py-1">
        <Areas />
        <span className="font-semibold">Agent runs</span>
      </header>
      {me === undefined && <div className="flex justify-center p-8"><span className="loading loading-spinner" /></div>}
      {me === null && <p className="p-8">Sign in at the <AreaLink path="/workshop" className="link">workshop</AreaLink> first.</p>}
      {me && !me.admin && <p className="p-8">Only admins read the agents’ runs.</p>}
      {me?.admin && <Explorer />}
    </div>
  );
}

// --- what's picked, in the address ---

type Picked = api.Filter & { period?: string; by?: string; run?: string };
const PERIODS: Record<string, number | undefined> = { '24h': 1, '7d': 7, '30d': 30, all: undefined };

function readHash(): Picked {
  const p = new URLSearchParams(location.hash.slice(1));
  return Object.fromEntries(p.entries()) as Picked;
}

function useHash(): [Picked, (patch: Partial<Picked>) => void] {
  const [picked, setPicked] = useState(readHash);
  useEffect(() => {
    const on = () => setPicked(readHash());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  const set = useCallback((patch: Partial<Picked>) => {
    const next = { ...readHash(), ...patch };
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (v) q.set(k, v);
    history.replaceState(null, '', `${location.pathname}#${q}`);
    setPicked(next);
  }, []);
  return [picked, set];
}

function filterOf(p: Picked & { stamp?: number }): api.Filter {
  const days = PERIODS[p.period ?? '7d'];
  const since = days === undefined ? undefined : new Date(Date.now() - days * 86_400_000).toISOString();
  return { since, backend: p.backend, model: p.model, kind: p.kind, purpose: p.purpose, outcome: p.outcome, rated: p.rated, draft: p.draft };
}

// --- formatting ---

const ms = (v?: number) => (v === undefined || v === null ? '—' : v < 1000 ? `${v} ms` : v < 60_000 ? `${(v / 1000).toFixed(1)} s` : `${(v / 60_000).toFixed(1)} min`);
const tokens = (v?: number) => (!v ? '0' : v < 1000 ? String(v) : v < 1_000_000 ? `${(v / 1000).toFixed(1)}k` : `${(v / 1_000_000).toFixed(2)}M`);
const dollars = (v?: number) => (v === undefined || v === null ? '—' : `$${v < 0.01 && v > 0 ? v.toFixed(4) : v.toFixed(2)}`);
const pct = (n: number, of: number) => (of ? `${Math.round((100 * n) / of)}%` : '—');
const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const build = (commit?: string, tag?: string) => [commit?.slice(0, 12), tag].filter(Boolean).join(' · ') || '—';

/** A run's cost: paid (API), a subscription's (notional, ≈), or nothing. */
function Cost({ row }: { row: api.RunRow }) {
  if (row.costUsd === undefined || row.costUsd === null) return <span className="text-base-content/50">{row.requests ? '?' : '—'}</span>;
  const notional = !row.billing?.includes('api') && row.billing?.includes('subscription');
  return <span title={notional ? 'notional: what the tokens would cost on the API; the subscription paid' : row.billing}>{notional ? '≈' : ''}{dollars(row.costUsd)}</span>;
}

const OUTCOME: Record<string, string> = { completed: 'badge-success', failed: 'badge-error', stopped: 'badge-warning', cancelled: 'badge-warning' };

// --- the explorer ---

function Explorer() {
  const [picked, set] = useHash();
  const [facets, setFacets] = useState<api.Facets>();
  const [stamp, setStamp] = useState(0);
  const { period, backend, model, kind, purpose, outcome, rated, draft } = picked;
  // made anew on Refresh too: "the last 7 days" moves on
  const filter = useMemo(() => filterOf({ period, backend, model, kind, purpose, outcome, rated, draft, stamp }),
    [period, backend, model, kind, purpose, outcome, rated, draft, stamp]);
  useEffect(() => { api.facets().then(setFacets, () => {}); }, [stamp]);

  const select = (key: keyof Picked, label: string, options: string[] | undefined, all = 'any') => (
    <label className="flex flex-col gap-1">
      <span className="text-base-content/60">{label}</span>
      <select className="select select-sm w-full" value={picked[key] ?? ''} onChange={(e) => set({ [key]: e.target.value || undefined, run: undefined })}>
        <option value="">{all}</option>
        {(options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      <div className="grid grid-cols-2 items-end gap-3 md:grid-cols-4 xl:grid-cols-9">
        <label className="flex flex-col gap-1">
          <span className="text-base-content/60">Period</span>
          <select className="select select-sm w-full" value={picked.period ?? '7d'} onChange={(e) => set({ period: e.target.value })}>
            {Object.keys(PERIODS).map((p) => <option key={p} value={p}>{p === 'all' ? 'all time' : `last ${p}`}</option>)}
          </select>
        </label>
        {select('backend', 'Backend', facets?.backends)}
        {select('model', 'Model', facets?.models)}
        {select('kind', 'Kind', facets?.kinds)}
        {select('purpose', 'Purpose', facets?.purposes)}
        {select('outcome', 'Outcome', facets?.outcomes)}
        {select('rated', 'Rated', ['yes', 'no'])}
        <label className="flex flex-col gap-1">
          <span className="text-base-content/60">Draft</span>
          <input type="text" className="input input-sm w-full" placeholder="its id" defaultValue={picked.draft ?? ''}
                 onKeyDown={(e) => { if (e.key === 'Enter') set({ draft: e.currentTarget.value.trim() || undefined, run: undefined }); }}
                 onBlur={(e) => set({ draft: e.currentTarget.value.trim() || undefined })} />
        </label>
        <button type="button" className="btn btn-sm" onClick={() => setStamp((n) => n + 1)}><RefreshCw className="size-4" />Refresh</button>
      </div>
      <Summary filter={filter} by={picked.by ?? 'backend'} onBy={(by) => set({ by })} stamp={stamp} />
      <div className={`grid min-h-0 grid-cols-1 gap-3 ${picked.run ? 'xl:grid-cols-2' : ''}`}>
        <List filter={filter} selected={picked.run} onSelect={(run) => set({ run })} stamp={stamp} />
        {picked.run && <Detail key={picked.run} id={picked.run} onClose={() => set({ run: undefined })} onDraft={(draft) => set({ draft, run: undefined })} />}
      </div>
    </div>
  );
}

function Problem({ error }: { error?: string }) {
  return error ? <div role="alert" className="alert alert-error">{error}</div> : null;
}

function Summary({ filter, by, onBy, stamp }: { filter: api.Filter; by: string; onBy: (by: string) => void; stamp: number }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.summary>>>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    api.summary(filter, by).then((d) => { if (live) { setData(d); setError(undefined); } }, (e: unknown) => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [filter, by, stamp]);
  return (
    <section className="rounded-box border border-base-300 bg-base-100 p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-semibold">Summary by</span>
        <select className="select select-sm w-auto" value={by} onChange={(e) => onBy(e.target.value)}>
          {['backend', 'model', 'kind', 'purpose', 'day', 'draft', 'session', 'app-commit', 'server-commit', 'bridge-commit', 'provider-version']
            .map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        {data && <span className="text-base-content/60">{data.rows} run(s){data.capped ? ', the newest only' : ''}; prices as of {data.pricesAsOf}</span>}
      </div>
      <Problem error={error} />
      {data && (
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr><th>{by}</th><th>runs</th><th>completed</th><th>check passed</th><th>wall (median · p90)</th><th>first output</th><th>requests</th><th>tokens in · out</th><th>cache read · write</th><th>cost API</th><th>≈ subscription</th><th>rating</th><th>tool failures</th></tr>
            </thead>
            <tbody>
              {data.groups.map((g) => (
                <tr key={g.key}>
                  <td className="font-mono">{g.key}</td>
                  <td>{g.runs}</td>
                  <td>{pct(g.completed, g.runs)}{g.failed ? <span className="text-error"> · {g.failed} failed</span> : null}</td>
                  <td>{g.checked ? `${pct(g.checkPassed, g.checked)} of ${g.checked}` : '—'}</td>
                  <td>{ms(g.wallMedian)} · {ms(g.wallP90)}</td>
                  <td>{ms(g.firstOutputMedian)}</td>
                  <td>{g.requests}</td>
                  <td>{tokens(g.input)} · {tokens(g.output)}</td>
                  <td>{tokens(g.cacheRead)} · {tokens(g.cacheWrite)}</td>
                  <td>{dollars(g.costApi)}</td>
                  <td>{g.costSubscription ? `≈${dollars(g.costSubscription)}` : '—'}</td>
                  <td>{g.ratingMean === undefined || g.ratingMean === null ? '—' : `${g.ratingMean.toFixed(1)} (${g.rated})`}</td>
                  <td>{g.toolFailures}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function List({ filter, selected, onSelect, stamp }: { filter: api.Filter; selected?: string; onSelect: (id: string) => void; stamp: number }) {
  const [rows, setRows] = useState<api.RunRow[]>();
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    api.list(filter).then((d) => { if (live) { setRows(d.runs); setNext(d.next); setError(undefined); } }, (e: unknown) => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [filter, stamp]);
  const more = async () => {
    if (!next) return;
    try {
      const d = await api.list(filter, next);
      setRows((r) => [...(r ?? []), ...d.runs]);
      setNext(d.next);
    } catch (e) { setError(String(e)); }
  };
  return (
    <section className="min-w-0 rounded-box border border-base-300 bg-base-100 p-3">
      <Problem error={error} />
      {rows?.length === 0 && !error && <p className="p-2 text-base-content/60">No runs here: make one in the workshop, or widen the period.</p>}
      {rows && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr><th>when</th><th>draft</th><th>kind</th><th>backend · model</th><th>outcome</th><th>wall</th><th>tokens in · out</th><th>cost</th><th>check</th><th>rating</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={`cursor-pointer hover:bg-base-200 ${r.id === selected ? 'bg-base-200' : ''}`} onClick={() => onSelect(r.id)}>
                  <td className="whitespace-nowrap">{when(r.started)}</td>
                  <td className="max-w-40 truncate font-mono">{r.draft ?? '—'}</td>
                  <td>{r.kind ?? '—'}{r.purpose && r.purpose !== 'turn' ? ` · ${r.purpose}` : ''}</td>
                  <td className="max-w-56 truncate">{r.backend ?? '—'}{r.models ? <span className="text-base-content/60"> · {r.models}</span> : null}</td>
                  <td>{r.outcome ? <span className={`badge badge-sm ${OUTCOME[r.outcome] ?? 'badge-ghost'}`}>{r.outcome}{r.waiting ? ', asks' : ''}</span> : <span className="text-base-content/50">running?</span>}</td>
                  <td>{ms(r.wallMs)}</td>
                  <td>{tokens(r.input)} · {tokens(r.output)}</td>
                  <td><Cost row={r} /></td>
                  <td>{r.checkOk === undefined || r.checkOk === null ? '—' : r.checkOk ? <span className="text-success">passed</span> : <span className="text-error">failed</span>}</td>
                  <td>{r.rating ?? '—'}{r.comment ? ' 💬' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next && <button type="button" className="btn btn-sm mt-2" onClick={() => void more()}>More</button>}
    </section>
  );
}

// --- one run ---

/** A blob's text, fetched when it's opened. */
function BlobText({ blob, label }: { blob: api.BlobRef; label?: string }) {
  const [text, setText] = useState<string>();
  const [error, setError] = useState<string>();
  const load = () => { if (text === undefined) api.blobText(blob.$blob).then(setText, (e: unknown) => setError(String(e))); };
  return (
    <details onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open) load(); }}>
      <summary className="cursor-pointer text-base-content/60">{label ?? 'show'}{blob.bytes !== undefined ? ` (${tokens(blob.bytes)} bytes)` : ''}</summary>
      {error && <p className="text-error">{error}</p>}
      {text !== undefined && <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded bg-base-200 p-2 font-mono">{text}</pre>}
    </details>
  );
}

function BlobImage({ blob, mime }: { blob: api.BlobRef; mime?: string }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let made: string | undefined;
    api.blob(blob.$blob).then((b) => { made = URL.createObjectURL(new Blob([b as BlobPart], { type: mime ?? 'image/png' })); setUrl(made); }, () => {});
    return () => { if (made) URL.revokeObjectURL(made); };
  }, [blob.$blob, mime]);
  return url ? <img src={url} alt="what the check rendered" className="max-h-64 rounded border border-base-300" /> : <span className="loading loading-dots loading-sm" />;
}

/** Any value of an event: a blob opened on demand, a text as it is, the rest as JSON. */
function Shown({ v, label }: { v: unknown; label?: string }) {
  if (api.isBlob(v)) return <BlobText blob={v} label={label} />;
  if (typeof v === 'string') return <pre className="max-h-96 overflow-auto whitespace-pre-wrap font-mono">{v}</pre>;
  return <pre className="max-h-96 overflow-auto whitespace-pre-wrap font-mono">{JSON.stringify(v, null, 2)}</pre>;
}

function ToolContent({ content }: { content: unknown }) {
  if (!Array.isArray(content)) return null;
  return (
    <div className="flex flex-col gap-1">
      {content.map((c: Record<string, unknown>, i) => (c?.type === 'image'
        ? (api.isBlob(c) ? <BlobImage key={i} blob={c} mime={typeof c.mimeType === 'string' ? c.mimeType : undefined} /> : null)
        : c?.type === 'text'
        ? (api.isBlob(c) ? <BlobText key={i} blob={c} label="the result" /> : <Shown key={i} v={c.text} />)
        : <Shown key={i} v={c} />))}
    </div>
  );
}

/** What one event says, by its type; one this page doesn't know is shown as it is. */
function What({ e }: { e: api.RunEvent }) {
  const s = (k: string) => (typeof e[k] === 'string' ? (e[k] as string) : undefined);
  switch (e.type) {
    case 'start': return <span>sent: {s('message')?.slice(0, 200) || '(no message)'}</span>;
    case 'text': return <p className="whitespace-pre-wrap">{s('text')}</p>;
    case 'tool': return <span className="font-mono">{s('name')} {s('summary')}</span>;
    case 'tool_result': return (
      <details>
        <summary className="cursor-pointer"><span className={e.ok === false ? 'text-error' : 'text-success'}>{s('name')} {e.ok === false ? 'failed' : 'ok'}</span>{typeof e.took === 'number' ? <span className="text-base-content/60">, took {ms(e.took)}</span> : null}</summary>
        <ToolContent content={e.content} />
      </details>
    );
    case 'usage': return (
      <span className="text-base-content/70">
        {s('model') ?? 'a model'}: {tokens(e.input as number)} in · {tokens(e.output as number)} out
        {e.cacheRead ? ` · ${tokens(e.cacheRead as number)} cache read` : ''}{e.cacheWrite ? ` · ${tokens(e.cacheWrite as number)} cache write` : ''}
        {e.reasoning ? ` · ${tokens(e.reasoning as number)} thinking` : ''}{typeof e.took === 'number' ? ` · took ${ms(e.took)}` : ''}
        {s('billing') ? ` · ${s('billing')}` : ''}
      </span>
    );
    case 'throttle': return <span className="text-warning">{s('model') ?? 'the provider'} turned it away{e.status ? ` (${e.status as number})` : ''}, waited {ms(e.waitMs as number)}{s('reason') ? `: ${s('reason')!.slice(0, 200)}` : ''}</span>;
    case 'provenance': return <span className="font-mono">software {JSON.stringify(e.provenance)}</span>;
    case 'files': return <span>changed {Object.entries((e.files ?? {}) as Record<string, unknown>).map(([p, v]) => (v === null ? `${p} (deleted)` : p)).join(', ')}</span>;
    case 'ask': return <span>asks: {((e.questions ?? []) as { question?: string }[]).map((q) => q.question).join(' / ')}</span>;
    case 'saved': return <span className="text-error">not saved: {((e.problems ?? []) as string[]).join('; ')}</span>;
    case 'settled': return <div><span className={e.ok ? 'text-success' : 'text-error'}>{s('text')}</span>{e.detail !== undefined && <Shown v={e.detail} label="the check" />}</div>;
    case 'error': return <span className="text-error">{s('message')}</span>;
    case 'done': return <span className="text-base-content/70">the backend’s run ended{s('outcome') ? `: ${s('outcome')}` : ''}{e.waiting ? ', on a question' : ''}{typeof e.exitCode === 'number' ? ` (exit ${e.exitCode})` : ''}</span>;
    case 'end': return <span className="font-semibold">{s('outcome')}{e.waiting ? ', waiting on a question' : ''}</span>;
    case 'rating': return <span>rated {e.score as number} of 5{s('comment') ? `: ${s('comment')}` : ''}</span>;
    default: return <Shown v={Object.fromEntries(Object.entries(e).filter(([k]) => !['v', 'run', 'seq', 'at', 'ms', 'type', 'by'].includes(k)))} />;
  }
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex flex-col"><span className="text-base-content/60">{label}</span><span>{children}</span></div>;
}

function Detail({ id, onClose, onDraft }: { id: string; onClose: () => void; onDraft: (draft: string) => void }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.detail>>>();
  const [events, setEvents] = useState<api.RunEvent[]>([]);
  const [error, setError] = useState<string>();
  const [stamp, setStamp] = useState(0);
  useEffect(() => {
    let live = true;
    api.detail(id).then((d) => { if (live) { setData(d); setEvents(d.events); setError(undefined); } }, (e: unknown) => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [id, stamp]);
  const more = async () => {
    if (data?.next === null || data?.next === undefined) return;
    const d = await api.detail(id, data.next);
    setData({ ...d, events: [] });
    setEvents((es) => [...es, ...d.events]);
  };
  if (error) return <section className="rounded-box border border-base-300 bg-base-100 p-3"><Problem error={error} /></section>;
  if (!data) return <section className="flex justify-center rounded-box border border-base-300 bg-base-100 p-8"><span className="loading loading-spinner" /></section>;
  const r = data.run;
  const page = events.filter((e) => e.seq >= 0);
  const notes = events.filter((e) => e.type === 'note');
  const start = page.find((e) => e.type === 'start');
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-box border border-base-300 bg-base-100 p-3">
      <div className="flex items-center gap-2">
        <span className="font-semibold">Run</span>
        <span className="font-mono text-base-content/60">{r.id}</span>
        <span className="flex-1" />
        <a className="btn btn-ghost btn-sm" href={api.exportUrl(r.id)}><Download className="size-4" />Export</a>
        <button type="button" className="btn btn-ghost btn-sm btn-square" title="Close" onClick={onClose}><X className="size-4" /></button>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 md:grid-cols-4">
        <Fact label="started">{new Date(r.started).toLocaleString()}</Fact>
        <Fact label="draft">{r.draft ? <button type="button" className="link font-mono" onClick={() => onDraft(r.draft!)}>{r.draft}</button> : '—'} {r.kind ? `(${r.kind})` : ''}</Fact>
        <Fact label="backend">{data.backendLabel ?? r.backend ?? '—'}</Fact>
        <Fact label="session">{r.session ? <span className="font-mono">{r.session}</span> : '—'}</Fact>
        <Fact label="models">{r.models ?? '—'}</Fact>
        <Fact label="app build">{build(r.appCommit, r.appBuild)}</Fact>
        <Fact label="server build">{build(r.serverCommit, r.serverBuild)}</Fact>
        <Fact label="bridge">{build(r.bridgeCommit, r.bridgeVersion)}</Fact>
        <Fact label="provider version">{r.providerVersion ?? '—'}</Fact>
        <Fact label="outcome">{r.outcome ?? 'not ended (yet)'}{r.waiting ? ', waiting on a question' : ''}</Fact>
        <Fact label="wall · first output">{ms(r.wallMs)} · {ms(r.firstOutputMs)}</Fact>
        <Fact label="requests · throttled">{r.requests} · {data.throttles}</Fact>
        <Fact label="cost"><Cost row={r} />{data.unpriced ? <span className="text-base-content/60"> ({data.unpriced} unpriced)</span> : null}</Fact>
        <Fact label="tokens in · out">{tokens(r.input)} · {tokens(r.output)}{data.reasoning ? ` (${tokens(data.reasoning)} thinking)` : ''}</Fact>
        <Fact label="cache read · write">{tokens(r.cacheRead)} · {tokens(r.cacheWrite)}</Fact>
        <Fact label="tool calls · failed">{r.tools} · {r.toolFailures}</Fact>
        <Fact label="check">{r.checkOk === undefined || r.checkOk === null ? '—' : r.checkOk ? 'passed' : 'failed'}</Fact>
        <Fact label="rating">{r.rating ? `${r.rating} of 5` : '—'}{r.comment ? `: ${r.comment}` : ''}</Fact>
        <Fact label="account">{r.account}</Fact>
      </div>
      {start && <Inputs start={start} />}
      <Timeline events={page} />
      {data.next !== null && <button type="button" className="btn btn-sm" onClick={() => void more()}>More events</button>}
      <Files events={page} start={start} />
      <Trace id={id} />
      <Notes id={id} notes={notes} onAdded={() => setStamp((n) => n + 1)} />
    </section>
  );
}

function Inputs({ start }: { start: api.RunEvent }) {
  const inputs = (start.inputs ?? {}) as Record<string, unknown>;
  const files = Object.entries((inputs.files ?? {}) as Record<string, unknown>);
  const template = Object.entries((inputs.template ?? {}) as Record<string, unknown>);
  const diagnostics = (start.diagnostics ?? []) as unknown[];
  return (
    <details className="rounded border border-base-300 p-2">
      <summary className="cursor-pointer font-semibold">What it was sent</summary>
      <div className="mt-2 flex flex-col gap-2">
        <Fact label="message"><Shown v={start.message ?? ''} /></Fact>
        {start.answer !== undefined && <Fact label="the answer to its question"><Shown v={start.answer} /></Fact>}
        {inputs.spec !== undefined && <Fact label="the brief (SPEC.md)"><Shown v={inputs.spec} label="show the brief" /></Fact>}
        {inputs.system !== undefined && <Fact label="instructions"><Shown v={inputs.system} label="show the instructions" /></Fact>}
        {diagnostics.length > 0 && <Fact label={`${diagnostics.length} error(s) sent along`}><Shown v={diagnostics} /></Fact>}
        {files.length > 0 && (
          <Fact label={`the draft’s files (${files.length})`}>
            {files.map(([p, v]) => <Shown key={p} v={v} label={p} />)}
          </Fact>
        )}
        {template.length > 0 && (
          <details>
            <summary className="cursor-pointer text-base-content/60">the template’s files ({template.length})</summary>
            {template.map(([p, v]) => <Shown key={p} v={v} label={p} />)}
          </details>
        )}
        {start.session !== undefined && <Fact label="session">{String(start.session)}</Fact>}
        {(start.client as { ua?: string } | undefined)?.ua && <Fact label="browser">{(start.client as { ua: string }).ua}</Fact>}
      </div>
    </details>
  );
}

function Timeline({ events }: { events: api.RunEvent[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="table table-sm">
        <thead><tr><th>at</th><th>after</th><th>event</th><th>what</th></tr></thead>
        <tbody>
          {events.map((e, i) => {
            const gap = i && typeof e.ms === 'number' && typeof events[i - 1].ms === 'number' ? e.ms - (events[i - 1].ms as number) : undefined;
            return (
              <tr key={e.seq} className="align-top">
                <td className="whitespace-nowrap font-mono">+{ms(e.ms)}</td>
                <td className={`whitespace-nowrap font-mono ${gap !== undefined && gap > 30_000 ? 'text-warning' : 'text-base-content/50'}`}>{gap === undefined ? '' : ms(gap)}</td>
                <td className="whitespace-nowrap font-mono text-base-content/60">{e.type}</td>
                <td className="min-w-0 max-w-xl"><What e={e} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Every file a run changed, against what it was sent. */
function Files({ events, start }: { events: api.RunEvent[]; start?: api.RunEvent }) {
  const before = ((start?.inputs as Record<string, unknown> | undefined)?.files ?? {}) as Record<string, unknown>;
  const after = new Map<string, unknown>();
  for (const e of events) if (e.type === 'files') for (const [p, v] of Object.entries((e.files ?? {}) as Record<string, unknown>)) after.set(p, v);
  if (!after.size) return null;
  return (
    <details className="rounded border border-base-300 p-2">
      <summary className="cursor-pointer font-semibold">What it changed ({after.size})</summary>
      <div className="mt-2 flex flex-col gap-2">
        {[...after].map(([p, v]) => <FileDiff key={p} path={p} before={before[p]} after={v} />)}
      </div>
    </details>
  );
}

function FileDiff({ path, before, after }: { path: string; before: unknown; after: unknown }) {
  const [lines, setLines] = useState<ReturnType<typeof lineDiff> | 'too long'>();
  const [error, setError] = useState<string>();
  const text = (v: unknown) => (api.isBlob(v) ? api.blobText(v.$blob) : Promise.resolve(typeof v === 'string' ? v : ''));
  const load = () => {
    if (lines !== undefined) return;
    Promise.all([text(before), text(after)]).then(([a, b]) => setLines(lineDiff(a, b) ?? 'too long'), (e: unknown) => setError(String(e)));
  };
  const state = after === null ? 'deleted' : before === undefined ? 'new' : 'changed';
  return (
    <details onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open) load(); }}>
      <summary className="cursor-pointer font-mono">{path} <span className="text-base-content/60">({state})</span></summary>
      {error && <p className="text-error">{error}</p>}
      {lines === 'too long' && <p className="text-base-content/60">Too long to compare here: export the run.</p>}
      {Array.isArray(lines) && (
        <pre className="max-h-96 overflow-auto rounded bg-base-200 p-2 font-mono">
          {lines.map((l, i) => <div key={i} className={l.op === '+' ? 'bg-success/15' : l.op === '-' ? 'bg-error/15' : ''}>{l.op} {l.text}</div>)}
        </pre>
      )}
    </details>
  );
}

/** The backend's raw stream, loaded when opened, a page at a time. */
function Trace({ id }: { id: string }) {
  const [lines, setLines] = useState<api.RunEvent[]>();
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState<string>();
  const load = async (after?: number) => {
    try {
      const d = await api.detail(id, after, true);
      setLines((l) => [...(after === undefined ? [] : l ?? []), ...d.events.filter((e) => e.seq >= 0)]);
      setNext(d.next);
    } catch (e) { setError(String(e)); }
  };
  return (
    <details className="rounded border border-base-300 p-2" onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open && !lines) void load(); }}>
      <summary className="cursor-pointer font-semibold">The backend’s raw stream</summary>
      <Problem error={error} />
      {lines && !lines.length && <p className="text-base-content/60">This backend sent none.</p>}
      {lines && lines.length > 0 && (
        <div className="mt-2 flex flex-col gap-1">
          {lines.map((l) => (
            <div key={l.seq} className="border-b border-base-200 pb-1">
              <span className="font-mono text-base-content/60">+{ms(l.ms)} {String(l.source ?? '')}{l.truncated ? ' (the rest left out: too long)' : ''}</span>
              {l.data !== undefined && <Shown v={l.data} label="show" />}
            </div>
          ))}
        </div>
      )}
      {next !== null && <button type="button" className="btn btn-sm mt-2" onClick={() => void load(next)}>More</button>}
    </details>
  );
}

/** Notes on a run: what was seen in it, in an admin's words (the first step of finding what goes wrong). */
function Notes({ id, notes, onAdded }: { id: string; notes: api.RunEvent[]; onAdded: () => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const add = async () => {
    if (!text.trim()) return;
    try {
      await api.addNote(id, text);
      setText('');
      onAdded();
    } catch (e) { setError(String(e)); }
  };
  return (
    <div className="flex flex-col gap-2 rounded border border-base-300 p-2">
      <span className="font-semibold">Notes</span>
      {notes.map((n) => <p key={`${n.seq}`} className="whitespace-pre-wrap"><span className="text-base-content/60">{when(n.at)}: </span>{String(n.text ?? '')}</p>)}
      <Problem error={error} />
      <textarea className="textarea textarea-sm w-full" rows={2} placeholder="What went wrong, or right, in this run?" value={text} onChange={(e) => setText(e.target.value)} />
      <button type="button" className="btn btn-sm self-start" disabled={!text.trim()} onClick={() => void add()}>Add</button>
    </div>
  );
}
