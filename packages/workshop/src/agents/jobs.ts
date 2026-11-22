import { contracts } from './kinds';
import type { AgentBackend, AgentEvent, CompleteRequest, OpenQuestion, TurnRequest } from './types';

/** A tool the job hands to this page (a viz's check, where the server doesn't render): answered with `POST tool_result`. */
type ToolCall = { type: 'tool_call'; id: string; name: string; input: unknown; files: Record<string, string> };

/** One request to wherever the agent runs, by path relative to it (`turn`, `events?…`, `cancel`). */
export type Call = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * An agent run as a job: `POST turn` starts it and answers `{job}`, `GET events?job=&after=` long-polls what it did
 * (`{events, next, done}`), `POST cancel {job}` stops it. A turn has no request-sized deadline: it's read through short
 * polls, each independently proxied, and a dropped poll is retried. A `tool_call` event is one of the kind's tools the
 * job hands to this page, as the Claude bridge hands all of them: the page runs it and posts `tool_result {job, id, …}`.
 */
export function jobBackend(opts: { id: string; label: string; available: () => Promise<true | string>; open?: AgentBackend['open']; call: Call }): AgentBackend {
  const { call } = opts;
  const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return {
    id: opts.id,
    label: opts.label,
    available: opts.available,
    open: opts.open,
    async complete(req: CompleteRequest, signal: AbortSignal): Promise<string> {
      const r = await call('complete', { ...json({ system: req.system, prompt: req.prompt }), signal });
      const body = (await r.json().catch(() => ({}))) as { text?: string; error?: string };
      if (!r.ok || typeof body.text !== 'string') throw new Error(body.error ?? `the agent answered ${r.status}`);
      return body.text;
    },
    async *turn(req: TurnRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
      const started = await call('turn', json(req));
      const body = (await started.json().catch(() => ({}))) as { job?: string; error?: string };
      if (!started.ok || !body.job) { yield { type: 'error', message: body.error ?? `the agent answered ${started.status}` }; return; }
      const job = body.job;
      const cancel = () => { void call('cancel', json({ job })).catch(() => {}); };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        let after = 0;
        for (;;) {
          let r: Response;
          try {
            r = await call(`events?job=${job}&after=${after}`);
          } catch {
            if (signal.aborted) return;
            await new Promise((res) => setTimeout(res, 1000));
            continue;
          }
          const page = (await r.json().catch(() => ({}))) as { events?: AgentEvent[]; next?: number; done?: boolean; error?: string };
          if (!r.ok) { yield { type: 'error', message: page.error ?? `the agent answered ${r.status}` }; return; }
          for (const e of (page.events ?? []) as (AgentEvent | ToolCall)[]) {
            if (e.type !== 'tool_call') { yield e; continue; }
            const tool = contracts[req.kind ?? 'view'].tools(req).find((t) => t.name === e.name);
            const r = tool ? await tool.run(e.input, e.files) : { content: [{ type: 'text' as const, text: `no tool ${e.name} here` }], isError: true };
            await call('tool_result', json({ job, id: e.id, ...r })).catch(() => {});
          }
          after = page.next ?? after;
          if (page.done) return;
        }
      } finally {
        signal.removeEventListener('abort', cancel);
      }
    },
  };
}

/**
 * A job backend at `base` over plain HTTP, with the page's cookies. `GET status` says whether it takes a turn now:
 * `{available: true}` or `{available: false, reason}`, and `ask`: the question the conversation waits on.
 */
export function httpBackend(base: string, opts: { id: string; label: string }): AgentBackend {
  const call: Call = (path, init) => fetch(`${base.replace(/\/$/, '')}/${path}`, { credentials: 'same-origin', ...init });
  return jobBackend({
    ...opts,
    call,
    async available() {
      try {
        const r = await call('status');
        const s = (await r.json()) as { available?: boolean; reason?: string };
        return s.available ? true : (s.reason ?? `the agent answered ${r.status}`);
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    },
    async open() {
      try {
        const r = await call('status');
        return r.ok ? ((await r.json()) as { ask?: OpenQuestion }).ask : undefined;
      } catch {
        return undefined;
      }
    },
  });
}
