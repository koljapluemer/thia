import { describe, expect, it, vi } from 'vitest';
import { sha256, startRun, type Envelope, type RunSink } from './recorder';

function memorySink(fail = 0) {
  const blobs = new Map<string, Uint8Array>();
  const lines: Envelope[] = [];
  let failing = fail;
  const sink: RunSink = {
    async missing(shas) { return shas.filter((s) => !blobs.has(s)); },
    async putBlob(sha, bytes) { blobs.set(sha, bytes); },
    async append(_run, events) {
      if (failing > 0) { failing -= 1; throw new Error('down'); }
      lines.push(...events);
    },
  };
  return { sink, blobs, lines };
}

describe('a run', () => {
  it('keeps events in order, contents as blobs, each blob once', async () => {
    const m = memorySink();
    const template = { 'CLAUDE.md': 'the contract' };
    const run = startRun(m.sink, { type: 'start', inputs: { files: { 'view.tsx': 'a' }, template, spec: 'brief' } }, 'r1');
    run.add({ type: 'text', text: 'hi' });
    run.add({ type: 'files', files: { 'view.tsx': 'b', 'old.yml': null } });
    await run.end();
    expect(m.lines.map((l) => [l.seq, l.type])).toEqual([[0, 'start'], [1, 'text'], [2, 'files']]);
    expect(m.lines.every((l) => l.v === 1 && l.run === 'r1' && typeof l.ms === 'number' && l.at)).toBe(true);
    const files = m.lines[2].files as Record<string, { $blob: string } | null>;
    expect(files['old.yml']).toBeNull();
    expect(new TextDecoder().decode(m.blobs.get(files['view.tsx']!.$blob))).toBe('b');
    const inputs = m.lines[0].inputs as { template: Record<string, { $blob: string }> };
    expect(inputs.template['CLAUDE.md'].$blob).toBe(await sha256(new TextEncoder().encode('the contract')));

    const second = startRun(m.sink, { type: 'start', inputs: { template } }, 'r2');
    const put = vi.spyOn(m.sink, 'putBlob');
    await second.end();
    expect(put).not.toHaveBeenCalled();
  });

  it('keeps images and long texts out of the line', async () => {
    const m = memorySink();
    const run = startRun(m.sink, { type: 'start' }, 'r');
    run.add({ type: 'tool_result', name: 'check', ok: false, content: [{ type: 'text', text: 'short' }, { type: 'image', mimeType: 'image/png', data: btoa('png') }] });
    run.add({ type: 'trace', source: 'x', data: { big: 'y'.repeat(20_000) } });
    await run.end();
    const content = m.lines[1].content as Record<string, unknown>[];
    expect(content[0]).toEqual({ type: 'text', text: 'short' });
    expect(content[1]).toMatchObject({ type: 'image', mimeType: 'image/png', bytes: 3 });
    expect((m.lines[2].data as { $blob: string }).$blob).toMatch(/^[0-9a-f]{64}$/);
  });

  it('tries again when the sink fails, and never throws', async () => {
    const m = memorySink(2);
    const run = startRun(m.sink, { type: 'start' }, 'r');
    await run.flush();
    await run.flush();
    expect(m.lines).toHaveLength(0);
    run.add({ type: 'text', text: 'later' });
    await run.end();
    expect(m.lines.map((l) => l.seq)).toEqual([0, 1]);
  });

  it('records a rating after it ended', async () => {
    const m = memorySink();
    const run = startRun(m.sink, { type: 'start' }, 'r');
    await run.end();
    run.add({ type: 'rating', score: 4 });
    await run.flush();
    expect(m.lines.at(-1)).toMatchObject({ type: 'rating', score: 4, seq: 1 });
  });
});
