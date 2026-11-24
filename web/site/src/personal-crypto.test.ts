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
    return (operation: Operation, revision: number, value?: string, passphrase?: string, account = 'alice') =>
      new Promise<Reply>((resolve) => {
        worker.postMessage = resolve;
        worker.onmessage?.({ data: { operation, revision, value, passphrase, account } });
      });
  }

  const passphrase = 'separate sync passphrase';
  const first = await start();
  expect(await first('unlock', 0, undefined, passphrase)).not.toHaveProperty('error');
  const { result: envelope } = await first('write', 1, 'my private progress');
  expect(envelope).toBeDefined();
  expect(envelope).not.toContain('my private progress');

  const second = await start();
  expect(await second('unlock', 1, envelope, 'wrong passphrase')).toHaveProperty('error');
  expect(await second('unlock', 1, envelope, passphrase, 'bob')).toHaveProperty('error');
  expect(await second('unlock', 1, envelope, passphrase)).toEqual({ result: 'my private progress' });
  expect(await second('read', 2, envelope)).toHaveProperty('error');
}, 15000);
