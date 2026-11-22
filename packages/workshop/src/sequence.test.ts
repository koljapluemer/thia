import { describe, expect, it } from 'vitest';
import type { Belief } from '@gestalts/view';
import { parseSequenceManifest } from './lesson';
import { decide, walk, type Step } from './sequence';

const belief = (p: number, evidence = 3): Belief => ({ concept: 'c', mean: 0, sd: 1, p, evidence });

describe('a sequence', () => {
  const steps: Step[] = [{ view: 'check' }, { view: 'main', skipIfKnown: 'zehner' }, { view: 'more', detour: { concept: 'zehner', view: 'easy' } }];

  it('skips what is known and adds a detour for what is struggled with, never on no evidence', () => {
    expect(walk(steps, () => belief(0.9)).map((w) => w.decision.kind)).toEqual(['play', 'skip', 'play']);
    expect(walk(steps, () => belief(0.2)).map((w) => w.decision.kind)).toEqual(['play', 'play', 'detour']);
    expect(walk(steps, () => belief(0.2, 0)).map((w) => w.decision.kind)).toEqual(['play', 'play', 'play']);
    expect(walk(steps, () => undefined).map((w) => w.decision.kind)).toEqual(['play', 'play', 'play']);
    expect(decide(steps[2], () => belief(0.1))).toMatchObject({ kind: 'detour', view: 'easy' });
  });

  it('is published as a lesson@2 the player checks', () => {
    const ok = { format: 'lesson@2', title: 'T', runtime: 'r', views: ['views/0', 'views/1'], steps: [{ view: 0 }, { view: 1, skipIfKnown: 'c' }, { view: 1, detour: { concept: 'c', view: 0 } }], published: 'x' };
    expect(parseSequenceManifest(ok)).toEqual(ok);
    for (const bad of [
      { ...ok, network: true },
      { ...ok, views: ['../x'] },
      { ...ok, steps: [{ view: 2 }] },
      { ...ok, steps: [{ view: 0, skipIfKnown: 'c', detour: { concept: 'c', view: 0 } }] },
      { ...ok, steps: [] },
    ]) expect(() => parseSequenceManifest(bad)).toThrow();
  });
});
