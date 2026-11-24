import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AccountForm, type Account } from '@gestalts/host';
import { PersonalSync } from './personal-sync';

export function PersonalAccount({ syncing, status, onSync }: { syncing: PersonalSync | null; status?: string; onSync: (sync: PersonalSync | null, importLocal?: boolean) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [account, setAccount] = useState<Account | null>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refresh = async () => {
    const response = await fetch('/api/me', { cache: 'no-store' });
    if (response.status === 401) { setAccount(null); return; }
    if (!response.ok) throw new Error('Could not load your account.');
    setAccount(await response.json() as Account);
  };
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const open = () => {
      if (!element.open) element.showModal();
      void refresh().catch((failure: Error) => setError(failure.message));
    };
    window.addEventListener('thia:open-account', open);
    return () => window.removeEventListener('thia:open-account', open);
  }, []);
  const unlock = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!account || busy) return;
    setBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);
    const sync = new PersonalSync(account.id);
    try {
      await sync.unlock(String(form.get('passphrase')));
      onSync(sync, form.has('import'));
      dialog.current?.close();
    } catch (failure) {
      sync.close();
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const signOut = async () => {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/logout', { method: 'POST' });
      if (!response.ok) throw new Error('Could not sign out.');
      onSync(null);
      setAccount(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog ref={dialog} className="modal">
      <div className="modal-box flex flex-col gap-3">
        <button type="button" className="btn btn-sm self-end" disabled={busy} onClick={() => dialog.current?.close()}>Close</button>
        {account === null && <AccountForm onIn={setAccount} />}
        {account && <>
          <p>{account.email}</p>
          {status && <p role="status">{status}</p>}
          {syncing ? <button className="btn" onClick={() => onSync(null)}>Lock personal sync</button>
            : <form className="flex flex-col gap-3" onSubmit={(event) => void unlock(event)}>
              <h2 className="font-semibold">Sync my progress</h2>
              <p>Use a separate passphrase for your encrypted backup. Save it somewhere safe. You’ll need it on every device and Thia cannot recover it.</p>
              <label>Sync passphrase<input name="passphrase" className="input w-full" type="password" required /></label>
              <label className="flex items-center gap-2"><input name="import" type="checkbox" className="checkbox" /> Merge existing progress from this browser</label>
              <button className="btn btn-primary" disabled={busy}>Unlock sync</button>
            </form>}
          <button className="btn" disabled={busy} onClick={() => void signOut()}>Sign out</button>
        </>}
        {error && <p role="alert" className="text-error">{error}</p>}
      </div>
    </dialog>
  );
}
