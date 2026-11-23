import { describe, expect, it } from 'vitest';
import type { AgentBackend, AgentEvent } from './agents/types';
import { conversationKey, conversationOf, onTurnDone, runTurn, stop } from './turns';
import type { Work } from './work';

const work = (id: string): Work => ({
  kind: 'viz', id,
  snapshot: async () => ({ files: {}, gestalts: [] }),
  setSpec: async () => {},
  apply: async () => [],
});

/** A backend whose turn says one thing, then waits until `go` (or the abort), then says another. */
function slow() {
  let go!: () => void;
  const gate = new Promise<void>((r) => { go = r; });
  const backend: AgentBackend = {
    id: 'test', label: 'Test',
    available: async () => true,
    complete: async () => '',
    async *turn(_req, signal): AsyncIterable<AgentEvent> {
      yield { type: 'text', text: 'working' };
      await Promise.race([gate, new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }))]);
      if (signal.aborted) { yield { type: 'error', message: 'stopped' }; return; }
      yield { type: 'text', text: 'done' };
      yield { type: 'done' };
    },
  };
  return { backend, go };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('a conversation is its draft’s, not its chat’s', () => {
  it('runs on with no chat showing it, and is there as it went', async () => {
    const { backend, go } = slow();
    const key = conversationKey(backend.id, 'a');
    const running = runTurn({ work: work('a'), backend, message: 'build it', errors: [] });
    await tick();
    expect(conversationOf(key).busy).toBe(true);
    // another draft can take its own turn meanwhile
    const other = slow();
    void runTurn({ work: work('b'), backend: other.backend, message: 'and this', errors: [] });
    await tick();
    expect(conversationOf(conversationKey('test', 'b')).busy).toBe(true);
    // a second turn on the same draft waits for the first
    await runTurn({ work: work('a'), backend, message: 'again', errors: [] });
    go();
    await running;
    other.go();
    const c = conversationOf(key);
    expect(c.busy).toBe(false);
    expect(c.lines.map((l) => ('text' in l ? l.text : l.who))).toEqual(['working', 'done']);
  });

  it('stops by its key, and tells the chat showing it when it ends', async () => {
    const { backend } = slow();
    const key = conversationKey(backend.id, 'c');
    let told = 0;
    onTurnDone(key, () => { told += 1; });
    const running = runTurn({ work: work('c'), backend, message: 'go', errors: [] });
    await tick();
    stop(key);
    await running;
    expect(conversationOf(key).busy).toBe(false);
    expect(conversationOf(key).lines.some((l) => l.who === 'error')).toBe(true);
    expect(told).toBe(1);
  });
});
