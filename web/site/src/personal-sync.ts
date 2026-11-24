import type { Repo } from '@gestalts/client';

type Snapshot = { revision: number; envelope: string };
const EMPTY = '{"notes":[],"blobs":[]}';

async function request(account: string, method = 'GET', body?: Snapshot, signal?: AbortSignal) {
  const headers = { 'X-Thia-Account': account };
  const deadline = AbortSignal.timeout(10000);
  const common: RequestInit = { signal: signal ? AbortSignal.any([signal, deadline]) : deadline, cache: 'no-store' };
  const response = await fetch('/api/personal-sync', body ? {
    ...common, method, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : { ...common, headers });
  if (response.status === 401) {
    window.dispatchEvent(new Event('thia:session-expired'));
    throw new Error('Sign in again to sync progress.');
  }
  if (response.status === 409) return undefined;
  if (!response.ok) throw new Error(response.status === 413 ? 'The encrypted backup exceeds the storage limit.' : 'Could not contact personal sync.');
  return await response.json() as Snapshot | number | null;
}

export class PersonalSync {
  private readonly worker = new Worker(new URL('./personal-crypto.worker.ts', import.meta.url), { type: 'module' });
  private readonly abort = new AbortController();
  private running = false;

  constructor(readonly account: string) {}

  close() {
    this.abort.abort();
    this.worker.terminate();
  }

  private crypto(operation: 'unlock' | 'read' | 'write', revision: number, value?: string, key?: Uint8Array) {
    return new Promise<string | undefined>((resolve, reject) => {
      const signal = this.abort.signal;
      if (signal.aborted) { reject(signal.reason); return; }
      const cancel = () => reject(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
      this.worker.onmessage = ({ data }: MessageEvent<{ result?: string; error?: string }>) => {
        signal.removeEventListener('abort', cancel);
        if (data.error) reject(new Error(data.error));
        else resolve(data.result);
      };
      this.worker.onerror = () => {
        signal.removeEventListener('abort', cancel);
        reject(new Error('The encryption worker failed to load.'));
      };
      this.worker.postMessage({ operation, account: this.account, revision, value, key });
    });
  }

  async unlock(key: Uint8Array) {
    await this.crypto('unlock', 0, undefined, key);
  }

  async sync(repo: Repo, includeLocal: boolean) {
    if (this.running) return false;
    this.running = true;
    try {
      await repo.syncPersonal(async (merge) => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const saved = await request(this.account, 'GET', undefined, this.abort.signal) as Snapshot | null;
          const revision = saved?.revision ?? 0;
          const remote = saved ? await this.crypto('read', revision, saved.envelope) : EMPTY;
          const merged = await merge(remote!, includeLocal);
          if (saved && remote === merged) return merged;
          const envelope = await this.crypto('write', revision + 1, merged);
          if (envelope === undefined) throw new Error('Could not encrypt the backup.');
          const accepted = await request(this.account, 'PUT', { revision, envelope }, this.abort.signal);
          if (accepted === revision + 1 && !this.abort.signal.aborted) return merged;
          this.abort.signal.throwIfAborted();
        }
        throw new Error('Another device is syncing. Try again shortly.');
      });
      return true;
    } finally {
      this.running = false;
    }
  }
}
