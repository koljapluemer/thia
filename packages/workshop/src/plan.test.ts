import { describe, expect, it } from 'vitest';
import { checkPlan } from './plan';

describe('a plan', () => {
  it('is checked and tied to its rules, whichever agent wrote it', () => {
    expect(checkPlan('{"one_view": "a quiz"}')).toEqual({ one_view: 'a quiz' });
    const answer = 'Here:\n```json\n{"title": "Plus", "steps": ['
      + '{"title": "Check", "does": "4 sums", "brief": "Four sums.", "practises": [{"id": "zehner", "name": "Zehnerübergang"}], "rule": {"skip_if_known": "zehner"}},'
      + '{"title": "Main", "does": "sums", "brief": "Sums.", "practises": [{"id": "zehner", "name": "Zehnerübergang"}], "rule": {"detour": {"concept": "zehner", "title": "Easy", "brief": "Easier."}}}'
      + ']}\n```';
    const p = checkPlan(answer);
    if (!('steps' in p)) throw new Error('steps');
    expect(p.steps[0].rule).toBeNull();
    const d = p.steps[1].rule;
    expect(d && 'detour' in d && d.detour.brief).toContain('`zehner` (Zehnerübergang)');
    expect(p.steps[0].brief).toMatch(/^Four sums\..*gestalt: concept@2.*done\(\)/s);
    expect(() => checkPlan('{"title": "x", "steps": [{"title": "a", "brief": "c", "practises": [{"id": "Bad Id"}]}]}')).toThrow();
    expect(() => checkPlan('no plan')).toThrow();
  });
});
