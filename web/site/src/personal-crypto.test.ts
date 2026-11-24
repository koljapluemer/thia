import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

it('restores a backup in a fresh worker and authenticates the account and revision', async () => {
  type Reply = { result?: string; error?: string };
  type Operation = 'unlock' | 'read' | 'write';
  async function start() {
    vi.resetModules();
    const worker: { onmessage?: (message: unknown) => void; postMessage?: (value: Reply) => void } = {};
    vi.stubGlobal('self', worker);
    await import('./personal-crypto.worker');
    return (operation: Operation, revision: number, value?: string, key?: Uint8Array, account = 'alice') =>
      new Promise<Reply>((resolve) => {
        worker.postMessage = resolve;
        worker.onmessage?.({ data: { operation, revision, value, key, account } });
      });
  }

  const key = new Uint8Array(32).fill(7);
  const first = await start();
  expect(await first('unlock', 0, undefined, key)).not.toHaveProperty('error');
  const { result: envelope } = await first('write', 1, 'my private progress');
  expect(envelope).toBeDefined();
  expect(envelope).not.toContain('my private progress');

  const second = await start();
  expect(await second('unlock', 0, undefined, new Uint8Array(32))).not.toHaveProperty('error');
  expect(await second('read', 1, envelope)).toHaveProperty('error');
  expect(await second('unlock', 0, undefined, key)).not.toHaveProperty('error');
  expect(await second('read', 1, envelope, undefined, 'bob')).toHaveProperty('error');
  expect(await second('read', 1, envelope)).toEqual({ result: 'my private progress' });
  expect(await second('read', 2, envelope)).toHaveProperty('error');
}, 15000);
