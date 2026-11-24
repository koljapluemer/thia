import { describe, expect, it } from 'vitest';
import { MessageError, argsOf, formatMessage, parseMessage } from './icu';

describe('messages', () => {
  it('fill in names and numbers', () => {
    expect(formatMessage('Hello {name}!', { name: 'Ada' })).toBe('Hello Ada!');
    expect(formatMessage('{n, number} points', { n: 1234.5 }, 'de')).toBe('1.234,5 points');
  });
  it('make plurals as each language does', () => {
    const m = '{n, plural, =0 {no cards} one {# card} other {# cards}}';
    expect(formatMessage(m, { n: 0 }, 'en')).toBe('no cards');
    expect(formatMessage(m, { n: 1 }, 'en')).toBe('1 card');
    expect(formatMessage(m, { n: 1500 }, 'de')).toBe('1.500 cards');
    const pl = '{n, plural, one {# plik} few {# pliki} many {# plików} other {# pliku}}';
    expect([1, 3, 5, 22].map((n) => formatMessage(pl, { n }, 'pl'))).toEqual(['1 plik', '3 pliki', '5 plików', '22 pliki']);
    // a language CLDR has no plurals for takes those of the language its speakers read next: Mauritian Creole, French's
    expect(formatMessage('{n, plural, one {# kart} other {# kart-yo}}', { n: 0 }, 'mfe')).toBe('0 kart');
    expect(formatMessage('{n, plural, one {# kart} other {# kart-yo}}', { n: 2 }, 'mfe')).toBe('2 kart-yo');
  });
  it('select, nest and quote', () => {
    const m = "{who, select, du {Du hast} other {Sie haben}} '{'{n, plural, one {eine} other {#}}'}' Karten, it''s";
    expect(formatMessage(m, { who: 'du', n: 1 }, 'de')).toBe("Du hast {eine} Karten, it's");
    expect(formatMessage('{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}', { n: 22 }, 'en')).toBe('22nd');
  });
  it('say what they take, and what is wrong with them', () => {
    expect([...argsOf(parseMessage('{a} {b, plural, other {{c}}} {d, select, x {} other {}}')).entries()]).toEqual([['a', 'text'], ['b', 'number'], ['c', 'text'], ['d', 'select']]);
    expect(() => parseMessage('{n, plural, one {x}}')).toThrow(MessageError);
    expect(() => parseMessage('Hello {name')).toThrow(/never closed/);
    expect(() => parseMessage('a } b')).toThrow(/without its/);
    expect(() => parseMessage('{n, date}')).toThrow(/types are/);
    expect(formatMessage('broken {')).toBe('broken {');
  });
});
