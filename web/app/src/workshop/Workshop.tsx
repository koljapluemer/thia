import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ChartSpline, LayoutTemplate, ListOrdered, LogOut, Plus, Settings as SettingsIcon } from 'lucide-react';
import { useLang, type Messages } from '@gestalts/i18n';
import { recordRunsTo, useRunning } from '@gestalts/workshop';
import * as api from './api';
import { loadChoice, saveChoice, type AgentChoice } from './agent';
import { DraftPane } from './DraftPane';
import { MoveOffer } from './move';
import { SequencePane } from './SequencePane';
import { Settings } from './Settings';
import { VizPane } from './VizPane';
import { serverRuns } from './runs';
import { Areas } from '../router';

/**
 * The workshop: everything made with an agent, behind the account. One list of drafts, each of a kind (a learning
 * view, a visualization), kept on the server; each kind has its own pane. Signed out: the sign-in.
 */
export function Workshop() {
  const [me, setMe] = useState<api.Me | null>();
  useEffect(() => { api.me().then(setMe, () => setMe(null)); }, []);
  // signed in, every agent run is recorded as this account's (admins read them in /runs)
  useEffect(() => { recordRunsTo(me ? serverRuns : undefined); }, [me]);
  if (me === undefined) return <div className="flex h-dvh items-center justify-center"><span className="loading loading-spinner" /></div>;
  if (!me) return <Login onIn={setMe} />;
  return <Drafts me={me} onOut={() => setMe(null)} />;
}

function Login({ onIn }: { onIn: (m: api.Me) => void }) {
  const { m } = useLang();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      onIn(await api.login(email, password));
    } catch (err) {
      setError(err instanceof api.ApiError && err.status === 401 ? m.login_mismatch() : err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-h-dvh items-center justify-center bg-base-200 p-4">
      <div className="fixed top-2 start-4"><Areas /></div>
      <form onSubmit={(e) => void submit(e)} className="flex w-full max-w-sm flex-col gap-3 rounded-box bg-base-100 p-6 shadow">
        <h1 className="text-lg font-semibold">{m.sign_in()}</h1>
        <label className="flex flex-col gap-1 text-sm">{m.email()}
          <input className="input w-full" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">{m.password()}
          <input className="input w-full" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p role="alert" className="text-sm text-error">{error}</p>}
        <button type="submit" className="btn btn-primary" disabled={busy}>{m.sign_in()}</button>
      </form>
    </div>
  );
}

const SELECTED = 'workshop:draft';

const KINDS: { kind: api.Kind; icon: typeof Plus; label: (m: Messages) => string; ask: (m: Messages) => string }[] = [
  { kind: 'view', icon: LayoutTemplate, label: (m) => m.kind_view(), ask: (m) => m.kind_view_ask() },
  { kind: 'viz', icon: ChartSpline, label: (m) => m.kind_viz(), ask: (m) => m.kind_viz_ask() },
  { kind: 'sequence', icon: ListOrdered, label: (m) => m.kind_sequence(), ask: (m) => m.kind_sequence_ask() },
];
const KIND = Object.fromEntries(KINDS.map((k) => [k.kind, k])) as Record<api.Kind, (typeof KINDS)[number]>;

/** A turn running on a draft that isn't open goes on there: said where the draft is listed. */
function Running({ draft }: { draft: string }) {
  const { m } = useLang();
  return useRunning(draft) ? <span className="loading loading-dots loading-xs shrink-0" title={m.agent_working()} /> : null;
}

function Drafts({ me, onOut }: { me: api.Me; onOut: () => void }) {
  const { m } = useLang();
  const [list, setList] = useState<api.DraftInfo[]>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<string | null>(() => { try { return localStorage.getItem(SELECTED); } catch { return null; } });
  const [choice, setChoice] = useState<AgentChoice>(loadChoice);
  const [settings, setSettings] = useState(false);
  const refresh = useCallback(() => api.drafts().then(setList, (e: unknown) => setError(e instanceof Error ? e.message : String(e))), []);
  useEffect(() => { void refresh(); }, [refresh]);
  const choose = (id: string | null) => {
    setSelected(id);
    try { if (id) localStorage.setItem(SELECTED, id); else localStorage.removeItem(SELECTED); } catch { /* not remembered */ }
  };
  const create = async (kind: api.Kind) => {
    (document.activeElement as HTMLElement | null)?.closest('details')?.removeAttribute('open');
    const title = window.prompt(KIND[kind].ask(m))?.trim();
    if (!title) return;
    try {
      const d = await api.newDraft(title, kind);
      await refresh();
      choose(d.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const signOut = async () => { await api.logout().catch(() => undefined); onOut(); };
  const current = list?.find((d) => d.id === selected);
  return (
    <div className="flex h-dvh flex-col bg-base-200">
      <header className="navbar min-h-0 gap-2 border-b border-base-300 bg-base-100 px-4 py-1">
        <Areas />
        <span className="flex-1 font-semibold">{m.area_workshop()}</span>
        <span className="hidden text-sm text-base-content/60 sm:inline">{me.email}</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSettings(true)} title={m.settings()} aria-label={m.settings()}><SettingsIcon className="size-4" /></button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void signOut()} title={m.sign_out()} aria-label={m.sign_out()}><LogOut className="size-4" /></button>
      </header>
      {error && <div role="alert" className="alert alert-error m-2">{error}</div>}
      <MoveOffer onMoved={() => void refresh()} />
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-56 shrink-0 flex-col gap-1 overflow-y-auto border-e border-base-300 bg-base-100 p-2">
          <details className="dropdown">
            <summary className="btn btn-sm btn-primary w-full"><Plus className="size-4" /> {m.new()}</summary>
            <ul className="dropdown-content menu z-50 mt-1 w-52 rounded-box border border-base-300 bg-base-100 p-1 shadow">
              {KINDS.map(({ kind, label, icon: Icon }) => <li key={kind}><button type="button" onClick={() => void create(kind)}><Icon className="size-4" /> {label(m)}</button></li>)}
            </ul>
          </details>
          {!list && <span className="loading loading-spinner m-4" />}
          <ul className="menu menu-sm w-full p-0">
            {list?.map((d) => {
              const Icon = KIND[d.kind]?.icon ?? LayoutTemplate;
              return (
                <li key={d.id}>
                  <button type="button" className={d.id === selected ? 'menu-active' : ''} onClick={() => choose(d.id)} title={KIND[d.kind]?.label(m)}>
                    <Icon className="size-4 shrink-0 opacity-60" /><span className="flex-1 truncate">{d.title || d.id}</span><Running draft={d.id} />
                  </button>
                </li>
              );
            })}
          </ul>
          {list?.length === 0 && <p className="p-2 text-sm text-base-content/60">{m.drafts_none()}</p>}
        </nav>
        <main className="min-w-0 flex-1">
          {current?.kind === 'view' && <DraftPane key={current.id} info={current} me={me} agent={choice} onChanged={() => void refresh()} onDeleted={() => { choose(null); void refresh(); }} />}
          {current?.kind === 'sequence' && <SequencePane key={current.id} info={current} agent={choice} onChanged={() => void refresh()} onDeleted={() => { choose(null); void refresh(); }} />}
          {current?.kind === 'viz' && <VizPane key={current.id} info={current} agent={choice} onChanged={() => void refresh()} onDeleted={() => { choose(null); void refresh(); }} />}
          {!current && <div className="flex h-full items-center justify-center p-4 text-center text-base-content/60">{m.drafts_pick()}</div>}
        </main>
      </div>
      {settings && <Settings choice={choice} onClose={() => setSettings(false)} onSave={(c) => { saveChoice(c); setChoice(c); setSettings(false); }} />}
    </div>
  );
}
