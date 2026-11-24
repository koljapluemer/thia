import { describe, expect, it } from 'vitest';
import { keysShowing, resolveWording, setWording, t, textHash, type Wording } from './wording';

const source: Wording = { lang: 'en', layer: 'source', messages: { next: { text: 'Next', description: 'goes on' }, left: { text: '{n, plural, one {# left} other {# left}}' } } };
const signed = (text: string, of: string) => ({ text, source: textHash(of) });
const de: Wording = { lang: 'de', layer: 'machine', messages: { next: signed('Weiter', 'Next'), left: signed('noch {n}', '{n, plural, one {# left} other {# left}}') } };

describe('a view\'s text', () => {
  it('is in the first language wanted that it has, else its source\'s', () => {
    expect(resolveWording([source, de], ['de-AT', 'de', 'en']).lang).toBe('de');
    expect(resolveWording([source, de], ['de-AT', 'de', 'en']).messages.next).toBe('Weiter');
    expect(resolveWording([source, de], ['fr', 'en'])).toMatchObject({ lang: 'en', messages: { next: 'Next' } });
    expect(resolveWording([source, de], ['vi'])).toMatchObject({ lang: 'en', messages: { next: 'Next' } });
  });
  it('takes an override before a reviewed before a machine translation', () => {
    const reviewed: Wording = { lang: 'de', layer: 'reviewed', messages: { next: signed('Weiter geht’s', 'Next') } };
    const override: Wording = { lang: 'de', layer: 'override', messages: { next: signed('Nächste', 'Next') } };
    expect(resolveWording([source, de, reviewed], ['de']).messages.next).toBe('Weiter geht’s');
    expect(resolveWording([source, de, reviewed, override], ['de'])).toMatchObject({ messages: { next: 'Nächste', left: 'noch {n}' }, from: { next: 'override', left: 'machine' } });
  });
  it('rewords its own language too', () => {
    const du: Wording = { lang: 'en', layer: 'override', messages: { next: signed('On we go', 'Next') } };
    expect(resolveWording([source, du], ['en']).messages.next).toBe('On we go');
  });
  it('never trusts what was written against another source text', () => {
    const changed: Wording = { ...source, messages: { ...source.messages, next: { text: 'Continue' } } };
    const r = resolveWording([changed, de], ['de']);
    expect(r.messages).toEqual({ next: 'Continue', left: 'noch {n}' });
    expect(r.stale).toEqual(['de/machine/next']);
  });
});

describe('t()', () => {
  it('formats the current text, and says where it showed while picking', () => {
    setWording({ messages: { left: '{n, plural, one {noch #} other {noch #}}', next: 'Weiter' }, locale: 'de', lang: 'de', picking: true });
    expect(t('left', { n: 1500 })).toBe('noch 1.500');
    expect(t('next')).toBe('Weiter');
    expect(t('unknown')).toBe('unknown');
    expect(keysShowing('Weiter')).toEqual(['next']);
    expect(keysShowing('  Weiter → ')).toEqual(['next']);
    setWording({ messages: {}, locale: 'en', lang: 'en' });
    expect(keysShowing('Weiter')).toEqual([]);
  });
});
