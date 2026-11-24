import { describe, expect, it } from 'vitest';
import { chain, langPath, nativeName, pick, resolve, sameLanguage, splitPath } from './lang';
import { pseudo } from './pseudo';

const AVAILABLE = ['en', 'de'];

describe('chain', () => {
  it('drops subtags, then follows the language on, then English', () => {
    expect(chain('de-AT')).toEqual(['de-AT', 'de', 'en']);
    expect(chain('mfe')).toEqual(['mfe', 'fr', 'en']);
    expect(chain('zh-Hant-TW')).toEqual(['zh-Hant-TW', 'zh-Hant', 'zh', 'en']);
  });
  it('takes three-letter codes and refuses what is not a tag', () => {
    expect(chain('vie')).toEqual(['vi', 'en']);
    expect(chain('mfe-MU')).toEqual(['mfe-MU', 'mfe', 'fr', 'en']);
    expect(chain('not a tag')).toEqual(['en']);
  });
});

describe('resolve', () => {
  it('puts the choice before the URL before the browser', () => {
    expect(resolve({ choice: 'en', url: 'de', browser: ['de'] }, AVAILABLE)).toBe('en');
    expect(resolve({ url: 'de', browser: ['en-US'] }, AVAILABLE)).toBe('de');
    expect(resolve({ browser: ['fr-FR', 'de-AT'] }, AVAILABLE)).toBe('de');
  });
  it('follows a language down its chain before asking the next source', () => {
    expect(resolve({ choice: 'de-AT', url: 'en' }, AVAILABLE)).toBe('de');
    expect(resolve({ browser: ['lb', 'en'] }, AVAILABLE)).toBe('de');
  });
  it('ends in English', () => {
    expect(resolve({ browser: ['mfe'] }, AVAILABLE)).toBe('en');
    expect(resolve({}, AVAILABLE)).toBe('en');
  });
  it('matches without regard to case', () => {
    expect(pick('EN-xa', ['en', 'en-XA'])).toBe('en-XA');
  });
});

describe('names', () => {
  it('names a language in itself', () => {
    expect(nativeName('de')).toBe('Deutsch');
    expect(sameLanguage('de-AT', 'de')).toBe(true);
  });
});

describe('pseudo', () => {
  it('accents letters, keeps placeholders and pads', () => {
    expect(pseudo('Hello {name}')).toBe('[Ĥéļļö {name} ~~~~]');
  });
});

describe('paths', () => {
  it('splits off an available language, and puts it back', () => {
    expect(splitPath('/de/', AVAILABLE)).toEqual({ lang: 'de', path: '/' });
    expect(splitPath('/de', AVAILABLE)).toEqual({ lang: 'de', path: '/' });
    expect(splitPath('/de/v/math-drills', AVAILABLE)).toEqual({ lang: 'de', path: '/v/math-drills' });
    expect(splitPath('/v/de', AVAILABLE)).toEqual({ path: '/v/de' });
    expect(splitPath('/vi/x', AVAILABLE)).toEqual({ path: '/vi/x' });
    expect(splitPath('/en/', AVAILABLE)).toEqual({ path: '/en/' });
    expect(langPath('/', 'de')).toBe('/de/');
    expect(langPath('/v/x', 'en')).toBe('/v/x');
  });
});
