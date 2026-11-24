import init, { hasLocalProgress as readLocalProgress } from '../wasm/gestalts.js';

export type Account = { id: string; email: string; school: string | null; maintainer: boolean; generation: number };
export type AccountUnlock = { account: Account; key: Uint8Array<ArrayBuffer>; remembered: boolean };

function exchange<T>(request: object): Promise<T> {
  const worker = new Worker(new URL('./account.worker.ts', import.meta.url), { type: 'module' });
  return new Promise<T>((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      worker.terminate();
      if (data.error) reject(new Error(data.error));
      else resolve(data.result as T);
    };
    worker.onerror = () => {
      worker.terminate();
      reject(new Error('Could not load sign-in.'));
    };
    worker.postMessage(request);
  });
}

export function signIn(email: string, password: string, remember: boolean, code?: string) {
  return exchange<AccountUnlock>({ type: 'login', email, password, remember, code });
}

export function changePassword(account: Account, password: string, next: string, remember: boolean) {
  return exchange<AccountUnlock>({ type: 'change', account, password, next, remember });
}

export function restoreUnlock(account: Account) {
  return exchange<Uint8Array<ArrayBuffer> | undefined>({ type: 'restore', account });
}

export function clearUnlock() {
  return exchange<void>({ type: 'clear' });
}

const ACCOUNT_CHANNEL = 'thia-account-change';

export function watchAccount(callback: () => void) {
  const channel = new BroadcastChannel(ACCOUNT_CHANNEL);
  channel.onmessage = callback;
  return () => channel.close();
}

export function notifyAccountChange() {
  const channel = new BroadcastChannel(ACCOUNT_CHANNEL);
  channel.postMessage(null);
  channel.close();
}

export async function signOut() {
  const response = await fetch('/api/logout', { method: 'POST' });
  if (!response.ok) throw new Error('Could not sign out.');
  await clearUnlock().catch(() => undefined);
  notifyAccountChange();
}

export async function hasLocalProgress() {
  await init();
  return readLocalProgress();
}
