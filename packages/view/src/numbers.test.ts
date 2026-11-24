import { describe, expect, it } from 'vitest';
import { formatNumber, operators, parseNumber } from './numbers';

describe('numbers as people write them', () => {
  it('reads German and English decimals and groups each their own way', () => {
    expect(parseNumber('3,5', 'de')).toBe(3.5);
    expect(parseNumber('3.5', 'en')).toBe(3.5);
    expect(parseNumber('1.234,5', 'de-DE')).toBe(1234.5);
    expect(parseNumber('1,234.5', 'en-US')).toBe(1234.5);
    expect(parseNumber(' −2,25 ', 'de')).toBe(-2.25);
    expect(parseNumber('+7', 'en')).toBe(7);
    expect(parseNumber(',5', 'de')).toBe(0.5);
  });
  it('refuses what it could read two ways, or not at all', () => {
    expect(parseNumber('3.5', 'de')).toBeUndefined();
    expect(parseNumber('3,5', 'en')).toBeUndefined();
    expect(parseNumber('1,23,4', 'en')).toBeUndefined();
    expect(parseNumber('drei', 'de')).toBeUndefined();
    expect(parseNumber('', 'de')).toBeUndefined();
    expect(parseNumber('1,2,3', 'de')).toBeUndefined();
  });
  it('reads groups of spaces, and other digits', () => {
    expect(parseNumber('1 234,5', 'fr')).toBe(1234.5);
    expect(parseNumber('1 234,5', 'fr')).toBe(1234.5);
    expect(parseNumber('١٢٣', 'ar-EG')).toBe(123);
  });
  it('writes each its own way, Mauritian Creole as CLDR has it', () => {
    expect(formatNumber(3.5, 'de')).toBe('3,5');
    expect(formatNumber(1234.5, 'en')).toBe('1,234.5');
    expect(formatNumber(3.5, 'mfe')).toBe('3.5');
    expect(parseNumber('3.5', 'mfe-MU')).toBe(3.5);
  });
  it('multiplies and divides as schools write it', () => {
    expect(operators('de-AT')).toEqual({ times: '·', divide: ':' });
    expect(operators('en-GB')).toEqual({ times: '×', divide: '÷' });
  });
});
