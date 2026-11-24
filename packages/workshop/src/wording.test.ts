import { describe, expect, it, vi } from 'vitest';
import { textHash, type Wording } from '@gestalts/view/wording';
import type { Draft } from './draft';
import { keepEntry, markReviewed, messageProblem, rowsFor, setEntry, wordingId, type WordingYml } from './wording';

const source: WordingYml = { id: 'wording', wording: { lang: 'en', layer: 'source', messages: { next: { text: 'Next', description: 'goes on' }, left: { text: '{n} left' } } } };
const de: WordingYml = { id: 'wording-de-machine', wording: { lang: 'de', layer: 'machine', messages: { next: { text: 'Weiter', source: textHash('Next') }, left: { text: 'übrig: {n}', source: textHash('{n} remaining') }, old: { text: 'Alt', source: 'x' } } } };
const draft: Draft = { id: 'v', title: 'T', spec: '', source: '', reads: [], writes: [], npm: {}, package: 'd-x', members: ['wording', 'wording-de-machine'], lang: 'en' };

describe('rewording a draft', () => {
  it('shows each key in a language, with what is stale and what the source dropped', () => {
    const { rows, gone, langs } = rowsFor([source, de], 'de');
    expect(langs).toEqual(['en', 'de']);
    expect(rows).toEqual([
      { key: 'next', description: 'goes on', source: 'Next', text: 'Weiter', from: 'machine', stale: [] },
      { key: 'left', description: undefined, source: '{n} left', text: '{n} left', from: 'source', stale: [{ layer: 'machine', text: 'übrig: {n}' }] },
    ]);
    expect(gone).toEqual([{ id: 'wording-de-machine', layer: 'machine', lang: 'de', key: 'old', text: 'Alt' }]);
  });

  it('writes an override signed against the source, and makes it a member', async () => {
    const put = vi.fn(async () => ({}) as never);
    await setEntry({ put }, draft, [source, de], 'en', 'override', 'next', 'On we go');
    expect(put).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: wordingId('en', 'override'), layer: 'override', messages: { next: { text: 'On we go', source: textHash('Next') } } }));
    expect(put).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: 'v', members: ['wording', 'wording-de-machine', 'wording-en-override'] }));
    const after = rowsFor([source, de, { id: 'wording-en-override', wording: { lang: 'en', layer: 'override', messages: { next: { text: 'On we go', source: textHash('Next') } } } }], 'en');
    expect(after.rows[0]).toMatchObject({ text: 'On we go', from: 'override' });
  });

  it('keeps a stale entry, and marks a translation reviewed', async () => {
    const put = vi.fn<(v: unknown) => Promise<never>>(async () => ({}) as never);
    await keepEntry({ put }, [source, de], 'wording-de-machine', 'left');
    expect((put.mock.calls[0][0] as { messages: Wording['messages'] }).messages.left.source).toBe(textHash('{n} left'));
    put.mockClear();
    await markReviewed({ put }, draft, [source, de], 'de');
    expect(put).toHaveBeenCalledWith(expect.objectContaining({ id: 'wording-de', layer: 'reviewed', messages: expect.objectContaining({ next: de.wording.messages.next }) }));
    expect(put).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'wording-de-machine', messages: {} }));
  });

  it('checks a wording against its source', () => {
    expect(messageProblem('noch {n}', '{n} left')).toBeUndefined();
    expect(messageProblem('noch viele', '{n} left')).toEqual({ missing: ['n'], extra: [] });
    expect(messageProblem('noch {m}', '{n} left')).toEqual({ missing: ['n'], extra: ['m'] });
    expect(messageProblem('noch {n', '{n} left')?.parse).toMatch(/never closed/);
  });
});
