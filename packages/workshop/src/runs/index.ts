import type { AgentBackend, CompleteRequest } from '../agents/types';
import type { RunProvenance } from '../agents/types';
import { NO_RUN, startRun, type Run, type RunEvent, type RunSink } from './recorder';

export { NO_RUN, runId, sha256, startRun, type BlobRef, type Envelope, type Run, type RunEvent, type RunSink } from './recorder';

let sink: RunSink | undefined;
let provenance: RunProvenance | undefined;

/** Where this page records its agent runs, once (the app's server); without, nothing is recorded. */
export function recordRunsTo(s: RunSink | undefined, p?: RunProvenance) {
  sink = s;
  provenance = p;
}

const client = () => (typeof navigator === 'undefined' ? undefined : { ua: navigator.userAgent });

/** A new run, recorded where `recordRunsTo` said; `NO_RUN` when nowhere. */
export function newRun(start: RunEvent): Run {
  return sink ? startRun(sink, { client: client(), provenance, ...start }) : NO_RUN;
}

/** `backend.complete`, recorded as a run of its own (`purpose: complete`). */
export async function recordedComplete(backend: AgentBackend, req: CompleteRequest, signal: AbortSignal, kind?: string): Promise<string> {
  const run = newRun({
    type: 'start', purpose: 'complete', draft: req.view, kind, backend: { id: backend.id, label: backend.label },
    inputs: { system: req.system }, message: req.prompt,
  });
  try {
    const text = await backend.complete(req, signal);
    run.add({ type: 'text', text });
    run.add({ type: 'end', outcome: 'completed' });
    return text;
  } catch (e) {
    run.add({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    run.add({ type: 'end', outcome: signal.aborted ? 'stopped' : 'failed' });
    throw e;
  } finally {
    void run.end();
  }
}
