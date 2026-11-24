import { signOut as endSession, watchAccount } from '@gestalts/client';
import { AccountForm } from '@gestalts/host';
import { useCallback, useEffect, useState } from 'react';
import { LayoutTemplate, LogOut, Plus } from 'lucide-react';
import { useLang } from '@gestalts/i18n';
import * as api from './api';
import { ChatApps } from './ChatApps';
import { DraftPane } from './DraftPane';
import { MoveOffer } from './move';
import { Areas } from '../router';

/**
 * Signed-in workspace for MCP-authored view drafts.
 */
export function Workshop() {
  const [me, setMe] = useState<api.Me | null>();
  useEffect(() => {
    const refresh = () => void api.me().then(setMe, () => setMe(null));
    refresh();
    return watchAccount(refresh);
  }, []);
  if (me === undefined) return <div className="flex h-dvh items-center justify-center"><span className="loading loading-spinner" /></div>;
  if (!me) return <Login onIn={setMe} />;
  return <Drafts me={me} onOut={() => setMe(null)} />;
}

export function Login({ onIn }: { onIn: (m: api.Me) => void }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-base-200 p-4">
      <div className="fixed top-2 start-4"><Areas /></div>
      <AccountForm onIn={onIn} />
    </div>
  );
}

const SELECTED = 'workshop:draft';

function Drafts({ me, onOut }: { me: api.Me; onOut: () => void }) {
  const { m } = useLang();
  const [list, setList] = useState<api.DraftInfo[]>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<string | null>(() => { try { return localStorage.getItem(SELECTED); } catch { return null; } });
  const refresh = useCallback(() => api.drafts().then((drafts) => setList(drafts.filter((draft) => draft.kind === 'view')), (e: unknown) => setError(e instanceof Error ? e.message : String(e))), []);
  useEffect(() => { void refresh(); }, [refresh]);
  const choose = (id: string | null) => {
    setSelected(id);
    try { if (id) localStorage.setItem(SELECTED, id); else localStorage.removeItem(SELECTED); } catch { /* not remembered */ }
  };
  const create = async () => {
    const title = window.prompt(m.kind_view_ask())?.trim();
    if (!title) return;
    try {
      const d = await api.newDraft(title, 'view');
      await refresh();
      choose(d.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const signOut = async () => { try { await endSession(); onOut(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  const current = list?.find((d) => d.id === selected);
  return (
    <div className="flex h-dvh flex-col bg-base-200">
      <header className="navbar min-h-0 gap-2 border-b border-base-300 bg-base-100 px-4 py-1">
        <Areas />
        <span className="flex-1 font-semibold">{m.area_workshop()}</span>
        <ChatApps />
        <span className="hidden text-sm text-base-content/60 sm:inline">{me.email}</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void signOut()} title={m.sign_out()} aria-label={m.sign_out()}><LogOut className="size-4" /></button>
      </header>
      {error && <div role="alert" className="alert alert-error m-2">{error}</div>}
      <MoveOffer onMoved={() => void refresh()} />
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-56 shrink-0 flex-col gap-1 overflow-y-auto border-e border-base-300 bg-base-100 p-2">
          <button type="button" className="btn btn-sm btn-primary" onClick={() => void create()}><Plus className="size-4" /> {m.kind_view()}</button>
          {!list && <span className="loading loading-spinner m-4" />}
          <ul className="menu menu-sm w-full p-0">
            {list?.map((d) => {
              return (
                <li key={d.id}>
                  <button type="button" className={d.id === selected ? 'menu-active' : ''} onClick={() => choose(d.id)} >
                    <LayoutTemplate className="size-4 shrink-0 opacity-60" /><span className="flex-1 truncate">{d.title || d.id}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {list?.length === 0 && <p className="p-2 text-sm text-base-content/60">{m.drafts_none()}</p>}
        </nav>
        <main className="min-w-0 flex-1">
          {current?.kind === 'view' && <DraftPane key={current.id} info={current} me={me} onChanged={() => void refresh()} onDeleted={() => { choose(null); void refresh(); }} />}
          {!current && <div className="flex h-full items-center justify-center p-4 text-center text-base-content/60">{m.drafts_pick()}</div>}
        </main>
      </div>
    </div>
  );
}
