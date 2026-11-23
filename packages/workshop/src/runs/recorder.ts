import { fromBase64 } from '../base64';

/**
 * The record of agent runs (`web/app/doc/workshop/runs.md`): what each turn was sent, what it said and did, as it
 * went, whichever backend ran it. The page writes it, a line per event, to a `RunSink` (the server's, in the app);
 * contents go to blobs, by hash, so a turn costs little more than what changed. Recording never gets in a turn's way:
 * whatever the sink does, `add` returns at once and nothing here throws.
 */

/** One event of a run: a `type` and whatever it carries. Readers keep the types they don't know. */
export type RunEvent = { type: string; [field: string]: unknown };

/**
 * An event as it's kept: which run, its place in it, when (and `ms` since the run began, on this page's clock). What
 * the event itself called `ms` (how long a tool or a request took) is kept as `took`.
 */
export type Envelope = RunEvent & { v: 1; run: string; seq: number; at: string; ms: number };

/** Where a long text or bytes went: `blobs/<sha256>`. */
export type BlobRef = { $blob: string; bytes: number };

export type RunSink = {
  /** of these, the blobs the sink doesn't have yet */
  missing(shas: string[]): Promise<string[]>;
  putBlob(sha: string, bytes: Uint8Array): Promise<void>;
  /** `keepalive`: the page is going, so the request has to outlive it */
  append(run: string, events: Envelope[], opts?: { keepalive?: boolean }): Promise<void>;
};

export type Run = {
  id: string;
  /** records `event` now (its time is now), and sends it soon */
  add(event: RunEvent): void;
  /** sends what's recorded, once it's ready */
  flush(): Promise<void>;
  /** sends what's left; `add` still works after (a rating, later) */
  end(): Promise<void>;
};

/** a text longer than this goes to a blob, wherever it is in an event */
const LONG = 16 * 1024;
/** a tool result's text longer than this goes to a blob */
const RESULT_TEXT = 4 * 1024;
/** what one run may keep of its backend's raw stream; after it, one `trace` saying so */
const TRACE_BUDGET = 32 * 1024 * 1024;
const FLUSH_MS = 1000;
const FLUSH_BYTES = 256 * 1024;
/** after this many failed sends in a row, what's waiting is dropped */
const GIVE_UP = 5;

const enc = new TextEncoder();

export async function sha256(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A run's id: 32 hex digits. */
export const runId = (): string => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

/** the same text hashed once: a template's files come with every turn */
const known = new Map<string, string>();

class Blobs {
  waiting = new Map<string, Uint8Array>();
  async text(s: string): Promise<BlobRef> {
    let sha = known.get(s);
    const bytes = enc.encode(s);
    if (!sha) {
      sha = await sha256(bytes);
      if (known.size > 5000) known.clear();
      known.set(s, sha);
    }
    this.waiting.set(sha, bytes);
    return { $blob: sha, bytes: bytes.length };
  }
  async bytes(b: Uint8Array): Promise<BlobRef> {
    const sha = await sha256(b);
    this.waiting.set(sha, b);
    return { $blob: sha, bytes: b.length };
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every value of a map of texts as a blob (`null` stays: deleted). */
async function allBlobs(blobs: Blobs, m: unknown, binary = false): Promise<unknown> {
  if (!isRecord(m)) return m;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) {
    out[k] = typeof v === 'string' ? (binary ? await blobs.bytes(fromBase64(v)) : await blobs.text(v)) : v;
  }
  return out;
}

/** Long texts anywhere in `v` as blobs. */
async function longOnes(blobs: Blobs, v: unknown, depth = 0): Promise<unknown> {
  if (typeof v === 'string') return v.length > LONG ? blobs.text(v) : v;
  if (depth > 6) return v;
  if (Array.isArray(v)) return Promise.all(v.map((x) => longOnes(blobs, x, depth + 1)));
  if (isRecord(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = await longOnes(blobs, x, depth + 1);
    return out;
  }
  return v;
}

/** What an event keeps in the line, and what goes to blobs: contents always, long texts anywhere. */
async function stored(blobs: Blobs, e: RunEvent): Promise<RunEvent> {
  const out: RunEvent = { ...e };
  // an event's own duration (a tool's, a request's) is `took`: `ms` is the envelope's, when it happened
  if ('ms' in out) { out.took = out.ms; delete out.ms; }
  if (e.type === 'start' && isRecord(e.inputs)) {
    const i = e.inputs;
    out.inputs = {
      ...i,
      files: await allBlobs(blobs, i.files),
      binary: await allBlobs(blobs, i.binary, true),
      template: await allBlobs(blobs, i.template),
      ...(typeof i.spec === 'string' ? { spec: await blobs.text(i.spec) } : {}),
      ...(typeof i.system === 'string' ? { system: await blobs.text(i.system) } : {}),
    };
  } else if (e.type === 'files') {
    out.files = await allBlobs(blobs, e.files);
  } else if (e.type === 'tool_result' && Array.isArray(e.content)) {
    out.content = await Promise.all(e.content.map(async (c: unknown) => {
      if (!isRecord(c)) return c;
      if (c.type === 'image' && typeof c.data === 'string') return { type: 'image', mimeType: c.mimeType, ...(await blobs.bytes(fromBase64(c.data))) };
      if (c.type === 'text' && typeof c.text === 'string' && c.text.length > RESULT_TEXT) return { type: 'text', ...(await blobs.text(c.text)) };
      return c;
    }));
  } else if (e.type === 'trace') {
    const s = typeof e.data === 'string' ? e.data : JSON.stringify(e.data) ?? '';
    if (s.length > LONG) out.data = await blobs.text(s);
  }
  return (await longOnes(blobs, out)) as RunEvent;
}

const size = (e: unknown) => { try { return JSON.stringify(e).length; } catch { return 0; } };

/** A run that records nothing: when there's nowhere to send it. */
export const NO_RUN: Run = { id: '', add() {}, flush: async () => {}, end: async () => {} };

/** Starts recording a run with `start` (its `start` event: what it was sent). */
export function startRun(sink: RunSink, start: RunEvent, id: string = runId()): Run {
  const t0 = performance.now();
  const blobs = new Blobs();
  let seq = 0;
  let traced = 0;
  let truncated = false;
  /** events in the order added, each made ready (its blobs) in turn */
  let ready: Promise<void> = Promise.resolve();
  let buffer: Envelope[] = [];
  let buffered = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;

  const send = async (keepalive = false) => {
    await ready;
    if (!buffer.length && !blobs.waiting.size) return;
    const batch = buffer;
    const shas = [...blobs.waiting.keys()];
    buffer = [];
    buffered = 0;
    try {
      if (shas.length) {
        const missing = new Set(await sink.missing(shas));
        for (const sha of shas) {
          const b = blobs.waiting.get(sha);
          if (b && missing.has(sha)) await sink.putBlob(sha, b);
          blobs.waiting.delete(sha);
        }
      }
      if (batch.length) await sink.append(id, batch, { keepalive });
      failures = 0;
    } catch (e) {
      failures += 1;
      if (failures >= GIVE_UP) {
        console.warn(`the record of agent run ${id} couldn't be sent, ${batch.length} event(s) dropped:`, e);
        blobs.waiting.clear();
        failures = 0;
      } else {
        buffer = [...batch, ...buffer];
        buffered += size(batch);
        schedule();
      }
    }
  };
  /** sends one batch after another, never two at once */
  let chain: Promise<void> = Promise.resolve();
  const flush = (keepalive = false): Promise<void> => {
    if (timer) { clearTimeout(timer); timer = undefined; }
    chain = chain.then(() => send(keepalive)).catch(() => {});
    return chain;
  };
  const schedule = () => {
    if (buffered > FLUSH_BYTES) { void flush(); return; }
    timer ??= setTimeout(() => { timer = undefined; void flush(); }, FLUSH_MS);
  };
  const leaving = () => { void flush(true); };
  if (typeof addEventListener === 'function') addEventListener('pagehide', leaving);

  const add = (event: RunEvent) => {
    let e = event;
    if (e.type === 'trace') {
      if (truncated) return;
      traced += size(e.data);
      if (traced > TRACE_BUDGET) { truncated = true; e = { type: 'trace', source: e.source, truncated: true }; }
    }
    const envelope = { v: 1 as const, run: id, seq: seq++, at: new Date().toISOString(), ms: Math.round(performance.now() - t0) };
    ready = ready.then(async () => {
      try {
        const s = await stored(blobs, e);
        const line = { ...s, ...envelope } as Envelope;
        buffer.push(line);
        buffered += size(line);
      } catch (err) {
        console.warn(`an event of agent run ${id} couldn't be recorded:`, err);
      }
      schedule();
    });
  };

  add({ ...start, type: 'start' });
  return {
    id,
    add,
    flush: () => flush(),
    end: async () => {
      if (typeof removeEventListener === 'function') removeEventListener('pagehide', leaving);
      await flush();
    },
  };
}
