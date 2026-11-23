import { describe, expect, it } from 'vitest';
import { lineDiff } from './diff';

describe('lineDiff', () => {
  it('keeps what both have and marks the rest', () => {
    const d = lineDiff('a\nb\nc\nd', 'a\nx\nc\nd\ne')!;
    expect(d.map((l) => `${l.op}${l.text}`)).toEqual([' a', '+x', '-b', ' c', ' d', '+e']);
    expect(lineDiff('same', 'same')).toEqual([{ op: ' ', text: 'same' }]);
    expect(lineDiff('', 'new')!.map((l) => l.op)).toEqual(['+', '-']);
  });
});
