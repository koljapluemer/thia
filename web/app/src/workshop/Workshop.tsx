import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ChartSpline, LayoutTemplate, ListOrdered, LogOut, Plus, Settings as SettingsIcon } from 'lucide-react';
import * as api from './api';
import { loadChoice, saveChoice, type AgentChoice } from './agent';
import { DraftPane } from './DraftPane';
import { MoveOffer } from './move';
import { SequencePane } from './SequencePane';
import { Settings } from './Settings';
import { VizPane } from './VizPane';
import { Areas } from '../router';

/**
 * The workshop: everything made with an agent, behind the account. One list of drafts, each of a kind (a learning
 * view, a visualization), kept on the server; each kind has its own pane. Signed out: the sign-in.
 */
export function Workshop() {
  const [me, setMe] = useState<api.Me | null>();
  useEffect(() => { api.me().then(setMe, () => setMe(null)); }, []);
  if (me === undefined) return <div className="flex h-dvh items-center justify-center"><span className="loading loading-spinner" /></div>;
  if (!me) return <Login onIn={setMe} />;
  return <Drafts me={me} onOut={() => setMe(null)} />;
}

function Login({ onIn }: { onIn: (m: api.Me) => void }) {
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
      setError(err instanceof api.ApiError && err.status === 401 ? 'That email and password don’t match.' : err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-h-dvh items-center justify-center bg-base-200 p-4">
      <div className="fixed top-2 left-4"><Areas /></div>
      <form onSubmit={(e) => void submit(e)} className="flex w-full max-w-sm flex-col gap-3 rounded-box bg-base-100 p-6 shadow">
        <h1 className="text-lg font-semibold">Sign in</h1>
        <label className="flex flex-col gap-1 text-sm">Email
          <input className="input w-full" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">Password
          <input className="input w-full" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p role="alert" className="text-sm text-error">{error}</p>}
        <button type="submit" className="btn btn-primary" disabled={busy}>Sign in</button>
      </form>
    </div>
  );
}

const SELECTED = 'workshop:draft';

const KINDS: { kind: api.Kind; label: string; icon: typeof Plus; ask: string }[] = [
  { kind: 'view', label: 'View', icon: LayoutTemplate, ask: 'What will it be? A title; you describe it in the chat next.' },
  { kind: 'viz', label: 'Visualization', icon: ChartSpline, ask: 'What will it be? A title; you write its spec next.' },
  { kind: 'sequence', label: 'Lesson of several views', icon: ListOrdered, ask: 'What will the lesson be? A title; you put its steps together next.' },
];
const KIND = Object.fromEntries(KINDS.map((k) => [k.kind, k])) as Record<api.Kind, (typeof KINDS)[number]>;

function Drafts({ me, onOut }: { me: api.Me; onOut: () => void }) {
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
    const title = window.prompt(KIND[kind].ask)?.trim();
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
        <span className="flex-1 font-semibold">Workshop</span>
        <span className="hidden text-sm text-base-content/60 sm:inline">{me.email}</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSettings(true)} title="Settings"><SettingsIcon className="size-4" /></button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void signOut()} title="Sign out"><LogOut className="size-4" /></button>
      </header>
      {error && <div role="alert" className="alert alert-error m-2">{error}</div>}
      <MoveOffer onMoved={() => void refresh()} />
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-56 shrink-0 flex-col gap-1 overflow-y-auto border-r border-base-300 bg-base-100 p-2">
          <details className="dropdown">
            <summary className="btn btn-sm btn-primary w-full"><Plus className="size-4" /> New</summary>
            <ul className="dropdown-content menu z-50 mt-1 w-52 rounded-box border border-base-300 bg-base-100 p-1 shadow">
              {KINDS.map(({ kind, label, icon: Icon }) => <li key={kind}><button type="button" onClick={() => void create(kind)}><Icon className="size-4" /> {label}</button></li>)}
            </ul>
          </details>
          {!list && <span className="loading loading-spinner m-4" />}
          <ul className="menu menu-sm w-full p-0">
            {list?.map((d) => {
              const Icon = KIND[d.kind]?.icon ?? LayoutTemplate;
              return (
                <li key={d.id}>
                  <button type="button" className={d.id === selected ? 'menu-active' : ''} onClick={() => choose(d.id)} title={KIND[d.kind]?.label}>
                    <Icon className="size-4 shrink-0 opacity-60" /><span className="truncate">{d.title || d.id}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {list?.length === 0 && <p className="p-2 text-sm text-base-content/60">Nothing yet: make a view, a visualization, or a lesson of several views.</p>}
        </nav>
        <main className="min-w-0 flex-1">
          {current?.kind === 'view' && <DraftPane key={current.id} info={current} me={me} agent={choice} onChanged={() => void refresh()} onDeleted={() => { choose(null); void refresh(); }} />}
          {current?.kind === 'sequence' && <SequencePane key={current.id} info={current} agent={choice} onChanged={() => void refresh()} onDeleted={() => { choose(null); void refresh(); }} />}
          {current?.kind === 'viz' && <VizPane key={current.id} info={current} onChanged={() => void refresh()} onDeleted={() => { choose(null); void refresh(); }} />}
          {!current && <div className="flex h-full items-center justify-center p-4 text-center text-base-content/60">Pick a draft, or make a new one.</div>}
        </main>
      </div>
      {settings && <Settings choice={choice} onClose={() => setSettings(false)} onSave={(c) => { saveChoice(c); setChoice(c); setSettings(false); }} />}
    </div>
  );
}
