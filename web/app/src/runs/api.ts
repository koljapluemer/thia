/** The record of agent runs, as admins read it (`web/server/src/runs`). */

export type RunRow = {
  id: string; account: string; started: string; lastAt?: string; draft?: string; kind?: string; purpose?: string;
  backend?: string; session?: string; appCommit?: string; appBuild?: string; serverCommit?: string; serverBuild?: string;
  bridgeCommit?: string; bridgeVersion?: string; providerVersion?: string;
  models?: string; billing?: string; outcome?: string; waiting: boolean; wallMs?: number;
  firstOutputMs?: number; requests: number; input: number; output: number; cacheRead: number; cacheWrite: number;
  costUsd?: number; tools: number; toolFailures: number; checkOk?: boolean; filesChanged: number; errors: number;
  rating?: number; comment?: string; notes: number;
};

export type Group = {
  key: string; runs: number; completed: number; failed: number; checked: number; checkPassed: number;
  wallMedian?: number; wallP90?: number; firstOutputMedian?: number; requests: number; input: number; output: number;
  cacheRead: number; cacheWrite: number; costApi: number; costSubscription: number; costAll: number; rated: number;
  ratingMean?: number; toolFailures: number;
};

/** One line of a run's record: whatever it carries. */
export type RunEvent = { v?: number; run?: string; seq: number; at: string; ms?: number; type: string; by?: string; [k: string]: unknown };
/** Where a content went (a blob, by its sha256); an image's carries its `mimeType`. */
export type BlobRef = { $blob: string; bytes?: number; mimeType?: unknown };
export const isBlob = (v: unknown): v is BlobRef => typeof v === 'object' && v !== null && typeof (v as BlobRef).$blob === 'string';

export type Facets = { backends: string[]; models: string[]; kinds: string[]; purposes: string[]; outcomes: string[] };
export type Filter = Partial<Record<'since' | 'backend' | 'model' | 'kind' | 'purpose' | 'outcome' | 'rated' | 'draft', string>>;

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`/api/admin/runs${path}`, { credentials: 'same-origin' });
  const body = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(body.error ?? `the server answered ${r.status}`);
  return body;
}

const query = (f: Filter & Record<string, string | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) q.set(k, v);
  return q.size ? `?${q}` : '';
};

export const list = (f: Filter, before?: string) => get<{ runs: RunRow[]; next: string | null; pricesAsOf: string }>(query({ ...f, before, limit: '50' }));
export const summary = (f: Filter, by: string) => get<{ groups: Group[]; rows: number; capped: boolean; pricesAsOf: string }>(`/summary${query({ ...f, by })}`);
export const facets = () => get<Facets>('/facets');
export const detail = (id: string, after?: number, trace = false) =>
  get<{ run: RunRow; backendLabel?: string; throttles: number; reasoning: number; unpriced: number; events: RunEvent[]; next: number | null }>(
    `/${id}${query({ after: after === undefined ? undefined : String(after), trace: trace ? 'only' : undefined })}`);
export const exportUrl = (id: string) => `/api/admin/runs/${id}/export`;

export async function addNote(id: string, text: string) {
  const r = await fetch(`/api/admin/runs/${id}/notes`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `the server answered ${r.status}`);
}

const blobs = new Map<string, Promise<Uint8Array>>();
/** A blob's bytes, fetched once. */
export function blob(sha: string): Promise<Uint8Array> {
  let b = blobs.get(sha);
  if (!b) {
    b = fetch(`/api/admin/runs/blobs/${sha}`, { credentials: 'same-origin' }).then(async (r) => {
      if (!r.ok) throw new Error(r.status === 404 ? 'not kept (the page went before it was sent)' : `the server answered ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    });
    b.catch(() => blobs.delete(sha));
    blobs.set(sha, b);
  }
  return b;
}
export const blobText = async (sha: string) => new TextDecoder().decode(await blob(sha));
