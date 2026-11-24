import { useEffect, useEffectEvent, useRef, useState, type FormEvent } from 'react';
import { useLang } from '@gestalts/i18n';
import { AccountForm } from '@gestalts/host';
import {
  changePassword, hasLocalProgress, notifyAccountChange, restoreUnlock, signOut, watchAccount,
  type Account, type AccountUnlock,
} from '@gestalts/client';
import { PersonalSync } from './personal-sync';

export function PersonalAccount({ syncing, status, onSync }: {
  syncing: PersonalSync | null;
  status?: string;
  onSync: (sync: PersonalSync | null, importLocal?: boolean) => void;
}) {
  const { m } = useLang();
  const dialog = useRef<HTMLDialogElement>(null);
  const active = useRef<Account | undefined>(undefined);
  const request = useRef(0);
  const pending = useRef<PersonalSync | null>(null);
  const [account, setAccount] = useState<Account | null>();
  const [busy, setBusy] = useState(false);
  const [merge, setMerge] = useState(false);
  const [changing, setChanging] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  function clearPending() {
    pending.current?.close();
    pending.current = null;
    setMerge(false);
  }

  async function startSync(current: Account, key: Uint8Array, ask: boolean, version: number) {
    const sync = new PersonalSync(current.id);
    try {
      await sync.unlock(key);
      const decision = 'thia-import-' + current.id;
      let decided = false;
      try { decided = !!localStorage.getItem(decision); } catch { /* storage unavailable */ }
      const offer = ask && !decided && await hasLocalProgress().catch(() => false);
      if (version !== request.current) { sync.close(); return; }
      active.current = current;
      if (offer) {
        pending.current = sync;
        setMerge(true);
        if (!dialog.current?.open) dialog.current?.showModal();
      } else {
        onSync(sync);
      }
    } catch (failure) {
      sync.close();
      throw failure;
    } finally { key.fill(0); }
  }

  const refresh = useEffectEvent(async () => {
    const version = ++request.current;
    const response = await fetch('/api/me', { cache: 'no-store' });
    if (version !== request.current) return;
    if (response.status === 401) {
      clearPending();
      if (active.current) onSync(null);
      active.current = undefined;
      setAccount(null);
      return;
    }
    if (!response.ok) throw new Error('Could not load your account.');
    const current = await response.json() as Account;
    if (version !== request.current) return;
    setAccount(current);
    if (active.current?.id === current.id && active.current.generation === current.generation) return;
    clearPending();
    if (active.current) onSync(null);
    active.current = undefined;
    const key = await restoreUnlock(current).catch(() => undefined);
    if (version !== request.current) { key?.fill(0); return; }
    if (key) await startSync(current, key, true, version);
  });
  const dispose = useEffectEvent(() => {
    request.current++;
    pending.current?.close();
  });
  const showError = (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure));

  useEffect(() => {
    const check = () => void refresh().catch(showError);
    const open = () => {
      if (!dialog.current?.open) dialog.current?.showModal();
      check();
    };
    const unwatch = watchAccount(check);
    window.addEventListener('thia:open-account', open);
    window.addEventListener('thia:session-expired', check);
    window.addEventListener('focus', check);
    check();
    return () => {
      dispose();
      window.removeEventListener('thia:open-account', open);
      window.removeEventListener('thia:session-expired', check);
      unwatch();
      window.removeEventListener('focus', check);
    };
  }, []);

  function signedIn(current: Account, unlock: AccountUnlock, ask = true) {
    const version = ++request.current;
    clearPending();
    setAccount(current);
    setNotice(unlock.remembered ? '' : m.unlock_unsaved());
    void startSync(current, unlock.key.slice(), ask, version).then(() => {
      if (version === request.current && !pending.current && ask) dialog.current?.close();
    }).catch(showError);
  }

  const decide = (includeLocal: boolean) => {
    const sync = pending.current;
    if (!sync) return;
    // A skipped import is remembered now. An accepted one is remembered after sync succeeds.
    if (!includeLocal) {
      try { localStorage.setItem('thia-import-' + sync.account, 'skipped'); } catch { /* storage unavailable */ }
    }
    pending.current = null;
    setMerge(false);
    onSync(sync, includeLocal);
    dialog.current?.close();
  };

  const submitChange = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!account || busy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      const unlock = await changePassword(account, String(form.get('current')), String(form.get('next')), form.has('remember'));
      signedIn(unlock.account, unlock, false);
      unlock.key.fill(0);
      notifyAccountChange();
      setChanging(false);
      setNotice(unlock.remembered ? m.password_changed() : [m.password_changed(), m.unlock_unsaved()].join(' '));
    } catch (failure) { showError(failure); }
    finally { setBusy(false); }
  };

  const logout = async () => {
    setBusy(true);
    setError('');
    try {
      await signOut();
      request.current++;
      clearPending();
      active.current = undefined;
      onSync(null);
      setAccount(null);
      setChanging(false);
      setNotice('');
    } catch (failure) { showError(failure); }
    finally { setBusy(false); }
  };

  return (
    <dialog ref={dialog} className="modal" onCancel={event => { if (merge) { event.preventDefault(); decide(false); } }}>
      <div className="modal-box flex flex-col gap-3">
        {!merge && <button type="button" className="btn btn-sm self-end" disabled={busy} onClick={() => dialog.current?.close()}>{m.close()}</button>}
        {account === null && <AccountForm onIn={signedIn} />}
        {account && <>
          <p>{account.email}</p>
          {notice && <p role="status">{notice}</p>}
          {status && <p role="status">{status}</p>}
          {merge ? <>
            <p>{m.account_merge_question()}</p>
            <button className="btn btn-primary" onClick={() => decide(true)}>{m.account_merge()}</button>
            <button className="btn" onClick={() => decide(false)}>{m.account_keep_local()}</button>
          </> : <>
            {!syncing && !changing && <AccountForm onIn={signedIn} />}
            {changing ? <form className="flex flex-col gap-3" onSubmit={event => void submitChange(event)}>
              <input type="hidden" name="username" autoComplete="username" value={account.email} />
              <label>{m.current_password()}<input name="current" className="input w-full" type="password" autoComplete="current-password" required /></label>
              <label>{m.new_password()}<input name="next" className="input w-full" type="password" autoComplete="new-password" minLength={15} maxLength={256} required /></label>
              <label className="flex items-center gap-2"><input name="remember" className="checkbox" type="checkbox" defaultChecked /> {m.stay_signed_in()}</label>
              <button className="btn btn-primary" disabled={busy}>{m.save_password()}</button>
              <button className="btn" type="button" disabled={busy} onClick={() => setChanging(false)}>{m.cancel()}</button>
            </form> : <button className="btn" onClick={() => setChanging(true)}>{m.change_password()}</button>}
            <button className="btn" disabled={busy} onClick={() => void logout()}>{m.sign_out()}</button>
          </>}
        </>}
        {error && <p role="alert" className="text-error">{error}</p>}
      </div>
    </dialog>
  );
}
