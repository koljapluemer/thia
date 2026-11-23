import type { RunSink } from '@gestalts/workshop';

/** keepalive requests may carry this much, all of them together */
const KEEPALIVE_BYTES = 60 * 1024;

const fail = async (r: Response) => {
  if (!r.ok) throw new Error(`the server answered ${r.status} to the run's record`);
};

/**
 * Where the workshop records its agent runs: the server's `runs/` (`web/server/src/runs`), as this account's. Admins
 * read them in /runs.
 */
export const serverRuns: RunSink = {
  async missing(shas) {
    const r = await fetch('/api/runs/blobs/missing', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(shas) });
    await fail(r);
    return (await r.json()) as string[];
  },
  async putBlob(sha, bytes) {
    await fail(await fetch(`/api/runs/blobs/${sha}`, { method: 'PUT', credentials: 'same-origin', body: bytes as BodyInit }));
  },
  async append(run, events, opts) {
    const body = JSON.stringify(events);
    await fail(await fetch(`/api/runs/${run}/events`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body,
      keepalive: Boolean(opts?.keepalive) && body.length < KEEPALIVE_BYTES,
    }));
  },
};
