import { useLang } from '@gestalts/i18n';
import { useState, type FormEvent } from 'react';

import { signIn, notifyAccountChange, type Account, type AccountUnlock } from '@gestalts/client';

export type { Account };

export function AccountForm({ onIn }: { onIn: (account: Account, unlock: AccountUnlock) => void }) {
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
      const unlock = await signIn(String(fields.get('email')), String(fields.get('password')), fields.has('remember'), signup ? String(fields.get('code')) : undefined);
      onIn(unlock.account, unlock);
      unlock.key.fill(0);
      notifyAccountChange();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="flex w-full max-w-sm flex-col gap-3 rounded-box bg-base-100 p-6">
      <h1 className="text-lg font-semibold">{signup ? m.create_account() : m.sign_in()}</h1>
      <label>{m.email()}<input className="input w-full" name="email" type="email" autoComplete="username" maxLength={254} required /></label>
      <label>{m.password()}<input key={String(signup)} className="input w-full" name="password" type="password" autoComplete={signup ? 'new-password' : 'current-password'} minLength={signup ? 15 : undefined} maxLength={256} required /></label>
      {signup && <>
        <label>{m.beta_code()}<input className="input w-full" name="code" type="password" autoComplete="off" required /></label>
        <p className="text-sm">{m.account_password_note()}</p>
      </>}
      <label className="flex items-center gap-2"><input className="checkbox" name="remember" type="checkbox" defaultChecked /> {m.stay_signed_in()}</label>
      {error && <p role="alert" className="text-error">{error}</p>}
      <button className="btn btn-primary" disabled={busy}>{signup ? m.create_account() : m.sign_in()}</button>
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => { setError(''); setSignup(!signup); }}>{signup ? m.sign_in_instead() : m.create_beta_account()}</button>
    </form>
  );
}
