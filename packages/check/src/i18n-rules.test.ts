import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isText, physicalClasses } from './i18n-rules.ts';

describe('text a person reads', () => {
  it('is any letters, but not punctuation, numbers or the name', () => {
    expect(isText('Save')).toBe(true);
    expect(isText('  Übung ')).toBe(true);
    expect(isText('·')).toBe(false);
    expect(isText('3 / 4')).toBe(false);
    expect(isText('thia')).toBe(false);
    expect(isText('   ')).toBe(false);
  });
});

describe('physical classes', () => {
  it('names each with its logical one, variants and negatives kept', () => {
    expect(physicalClasses('flex ml-2 md:pr-4 -mr-1 hover:text-left !pl-0')).toEqual([
      { found: 'ml-2', use: 'ms-2' },
      { found: 'md:pr-4', use: 'md:pe-4' },
      { found: '-mr-1', use: '-me-1' },
      { found: 'hover:text-left', use: 'hover:text-start' },
      { found: '!pl-0', use: '!ps-0' },
    ]);
    expect(physicalClasses('border-l rounded-tr-lg left-0 float-right')).toEqual([
      { found: 'border-l', use: 'border-s' },
      { found: 'rounded-tr-lg', use: 'rounded-se-lg' },
      { found: 'left-0', use: 'start-0' },
      { found: 'float-right', use: 'float-end' },
    ]);
  });
  it('leaves what has no direction alone', () => {
    expect(physicalClasses('mx-2 px-4 inset-x-0 text-center border-t rounded-lg space-x-2 menu-left')).toEqual([]);
  });
});

// the linter itself, on a file of what it should refuse and what it should let be
describe('the i18n lint', () => {
  it('refuses text in JSX, physical directions and formatting without a language', () => {
    const root = join(import.meta.dirname, '../../..');
    const dir = mkdtempSync(join(root, 'web/site/src/.lint-'));
    try {
      writeFileSync(join(dir, 'probe.tsx'), [
        "export const A = ({ busy, n, d }: { busy: boolean; n: number; d: Date }) => (",
        "  <div className=\"ml-2 mx-2\" style={{ paddingLeft: 4, top: 0 }} title=\"Hello\">",
        "    Bare {busy ? '…' : 'Move'} {'·'} {n.toLocaleString()} {d.toLocaleDateString('de')} {new Intl.NumberFormat().format(n)}",
        "  </div>",
        ");",
      ].join('\n'));
      let out = '';
      try { execFileSync('npx', ['oxlint', '--format', 'unix', dir], { cwd: root, encoding: 'utf8' }); } catch (e) { out = (e as { stdout: string }).stdout; }
      const rules = out.split('\n').map((l) => /\[Error\/([^\]]+)\]/.exec(l)?.[1]).filter((r) => r && /^(i18n|react\(jsx-no-literals)/.test(r)).sort();
      expect(rules).toEqual([
        'i18n(locale-aware)', 'i18n(locale-aware)',
        'i18n(logical-direction)', 'i18n(logical-direction)',
        'i18n(no-text-expression)',
        'react(jsx-no-literals)', 'react(jsx-no-literals)',
      ]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  }, 60_000);
});
