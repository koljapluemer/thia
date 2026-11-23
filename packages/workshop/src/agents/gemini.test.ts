import { describe, expect, it } from 'vitest';
import { GEMINI_CHAIN, Workspace, geminiBackend, pauseMs, type GeminiEnv } from './gemini';
import type { AgentEvent, TurnRequest } from './types';

type Sent = { model: string; body: { contents: { role: string; parts: Record<string, unknown>[] }[] } };

/** An env whose fetch answers from `replies` in order, recording what was sent. */
function fake(replies: ((model: string) => { status: number; body: unknown })[]) {
  const sent: Sent[] = [];
  let now = 1_000_000;
  const store = new Map<string, string>();
  const env: GeminiEnv = {
    now: () => now,
    sleep: async (ms) => { now += ms; },
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => { store.set(k, v); } },
    fetch: async (url, init) => {
      const model = /models\/([^:]+):/.exec(String(url))![1];
      sent.push({ model, body: JSON.parse(String(init!.body)) });
      const next = replies.shift();
      if (!next) throw new Error('no more replies');
      const { status, body } = next(model);
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    },
  };
  return { env, sent, advance: (ms: number) => { now += ms; } };
}

const answer = (...parts: unknown[]) => () => ({ status: 200, body: { candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }] } });
const limited = (body = '{"error":{"message":"quota","details":[{"retryDelay":"20s"}]}}') => () => ({ status: 429, body });

const req = (over: Partial<TurnRequest> = {}): TurnRequest => ({ kind: 'view', view: 'd', message: 'make it', files: { 'view.tsx': 'old' }, gestalts: [], diagnostics: [], ...over });

async function all(it: AsyncIterable<AgentEvent>) {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('pauseMs', () => {
  it('pauses an hour on a daily quota, the retryDelay otherwise, a minute without one', () => {
    expect(pauseMs(429, 'GenerateRequestsPerDayPerProjectPerModel')).toBe(3_600_000);
    expect(pauseMs(429, '"retryDelay": "12.5s"')).toBe(12_500);
    expect(pauseMs(429, 'busy')).toBe(60_000);
    expect(pauseMs(503, 'overloaded')).toBe(30_000);
    expect(pauseMs(400, 'bad')).toBeNull();
  });
});

describe('Workspace', () => {
  const keep = /^(?:view\.tsx|data\/[a-z]+\.yml)$/;
  it('writes and deletes only the draft, and edits a unique string', () => {
    const ws = new Workspace({ 'view.tsx': 'a b a', 'CLAUDE.md': 'x', 'data/x.yml': 'y' }, {}, keep);
    expect(() => ws.run('write_file', { path: 'CLAUDE.md', content: 'no' })).toThrow(/only the draft/);
    expect(() => ws.run('write_file', { path: '../view.tsx', content: 'no' })).toThrow();
    expect(() => ws.run('edit_file', { path: 'view.tsx', old_string: 'a', new_string: 'c' })).toThrow(/2 times/);
    ws.run('edit_file', { path: 'view.tsx', old_string: 'a', new_string: '$&', replace_all: true });
    expect(ws.files['view.tsx']).toBe('$& b $&');
    expect(() => ws.run('delete_file', { path: 'view.tsx' })).toThrow(/inside a folder/);
    ws.run('delete_file', { path: 'data/x.yml' });
    expect(ws.draft()).toEqual({ 'view.tsx': '$& b $&' });
    expect(ws.run('search', { text: 'B' })).toBe('view.tsx:1: $& b $&');
  });
});

describe('geminiBackend', () => {
  it('runs tools until the model answers, and hands back the changed files', async () => {
    const { env, sent } = fake([
      answer({ functionCall: { name: 'write_file', args: { path: 'view.tsx', content: 'new' } }, thoughtSignature: 'sig1' }),
      answer({ text: 'Done.' }),
    ]);
    const events = await all(geminiBackend('k', env).turn(req(), new AbortController().signal));
    expect(events).toContainEqual({ type: 'tool', name: 'write_file', summary: 'view.tsx' });
    expect(events).toContainEqual({ type: 'text', text: 'Done.' });
    expect(events).toContainEqual({ type: 'files', files: { 'view.tsx': 'new' } });
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    // the model's part goes back as it came, signature and all; the result follows it
    const second = sent[1].body.contents;
    expect(second[1]).toEqual({ role: 'model', parts: [{ functionCall: { name: 'write_file', args: { path: 'view.tsx', content: 'new' } }, thoughtSignature: 'sig1' }] });
    expect(second[2].parts[0]).toMatchObject({ functionResponse: { name: 'write_file', response: { output: 'wrote view.tsx' } } });
  });

  it('moves on to the next model after a rate limit, and swaps the earlier model’s signatures', async () => {
    const { env, sent } = fake([
      answer({ functionCall: { name: 'list_files', args: {} }, thoughtSignature: 'sig1' }),
      limited(),
      answer({ text: 'ok' }),
    ]);
    await all(geminiBackend('k', env).turn(req(), new AbortController().signal));
    expect(sent.map((s) => s.model)).toEqual([GEMINI_CHAIN[0], GEMINI_CHAIN[0], GEMINI_CHAIN[1]]);
    expect(sent[2].body.contents[1].parts[0].thoughtSignature).toBe('skip_thought_signature_validator');
  });

  it('ends the turn when every model is out for the day, and says so until then', async () => {
    const daily = limited('{"error":{"message":"GenerateRequestsPerDayPerProjectPerModel"}}');
    const { env, advance } = fake(GEMINI_CHAIN.map(() => daily));
    const backend = geminiBackend('k', env);
    const events = await all(backend.turn(req(), new AbortController().signal));
    expect(events.find((e) => e.type === 'error')).toMatchObject({ message: expect.stringMatching(/used up until/) });
    expect(await backend.available()).toMatch(/used up until/);
    advance(3_600_001);
    expect(await backend.available()).toBe(true);
  });

  it('waits out a short pause on every model', async () => {
    const { env, sent } = fake([...GEMINI_CHAIN.map(() => limited()), answer({ text: 'ok' })]);
    const events = await all(geminiBackend('k', env).turn(req(), new AbortController().signal));
    expect(events).toContainEqual({ type: 'tool', name: 'waiting', summary: 'for the free quota, 20 s' });
    expect(events).toContainEqual({ type: 'text', text: 'ok' });
    expect(sent.at(-1)!.model).toBe(GEMINI_CHAIN[0]);
  });

  it('goes on with the same conversation on the next turn', async () => {
    const { env, sent } = fake([answer({ text: 'one' }), answer({ text: 'two' })]);
    const backend = geminiBackend('k', env);
    const first = await all(backend.turn(req(), new AbortController().signal));
    const session = (first.at(-1) as { session: string }).session;
    await all(backend.turn(req({ session, message: 'more', files: { 'view.tsx': 'changed' } }), new AbortController().signal));
    const contents = sent[1].body.contents;
    expect(contents).toHaveLength(3);
    expect(String(contents[2].parts[0].text)).toMatch(/^\(Changed outside this conversation since your last turn: view\.tsx\.\)/);
  });

  it('is unavailable without a key', async () => {
    expect(await geminiBackend(' ', fake([]).env).available()).toMatch(/API key/);
  });
});
