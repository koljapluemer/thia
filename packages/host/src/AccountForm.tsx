import { useLang } from '@gestalts/i18n';
import { useState, type FormEvent } from 'react';

export type Account = { id: string; email: string; school: string | null; maintainer: boolean };

export function AccountForm({ onIn }: { onIn: (account: Account) => void }) {
  const { m } = useLang();
  const [signup, setSignup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      const response = await fetch(signup ? '/api/signup' : '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(fields)),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(response.status === 401 ? m.login_mismatch()
          : response.status === 403 && signup ? 'The beta code was rejected.' : body.error ?? 'Unable to sign in.');
      }
      onIn(await response.json() as Account);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="flex w-full max-w-sm flex-col gap-3 rounded-box bg-base-100 p-6">
      <h1 className="text-lg font-semibold">{signup ? 'Create account' : m.sign_in()}</h1>
      <label>{m.email()}<input className="input w-full" name="email" type="email" autoComplete="username" maxLength={254} required /></label>
      <label>{m.password()}<input key={String(signup)} className="input w-full" name="password" type="password" autoComplete={signup ? 'new-password' : 'current-password'} minLength={signup ? 15 : undefined} maxLength={256} required /></label>
      {signup && <>
        <label>Beta code<input className="input w-full" name="code" type="password" autoComplete="off" required /></label>
        <p className="text-sm">Use your own email address and save your password. Email verification and password reset will come after the beta.</p>
      </>}
      {error && <p role="alert" className="text-error">{error}</p>}
      <button className="btn btn-primary" disabled={busy}>{signup ? 'Create account' : m.sign_in()}</button>
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => { setError(''); setSignup(!signup); }}>{signup ? 'Sign in instead' : 'Create a beta account'}</button>
    </form>
  );
}
