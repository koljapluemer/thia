/**
 * oxlint's `i18n` plugin (`oxlint.config.ts`, `jsPlugins`): the rules of `src/i18n-scan.ts`, the same the check runs
 * over an agent's view, over this repo's code. `react/jsx-no-literals` (built in) refuses bare JSX text and text
 * attributes; these cover the rest (see `Rule`). A plugin's view (`plugins/<id>/view.tsx`) is a view: its `t()` keys
 * are checked against its source wording (`wording/*.yml`), and so are the numbers it reads and shows.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import ts from 'typescript-js';
import { parse } from 'yaml';
import { scanI18n, type Finding, type Rule } from '../src/i18n-scan.ts';

type Context = { filename: string; sourceCode: { text: string }; report(d: { message: string; loc: { start: { line: number; column: number }; end: { line: number; column: number } } }): void };

const VIEW = /[\\/]plugins[\\/][^\\/]+[\\/]view\.tsx$/;

/** The keys of a plugin's source wording; null if it has none. */
function sourceKeys(viewFile: string): Set<string> | null {
  const dir = join(dirname(viewFile), 'wording');
  if (!existsSync(dir)) return null;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.yml'))) {
    const w = parse(readFileSync(join(dir, f), 'utf8')) as { layer?: string; messages?: Record<string, unknown> } | null;
    if (w?.layer === 'source') return new Set(Object.keys(w.messages ?? {}));
  }
  return null;
}

// one scan per file, whichever rule asks first
let last: { file: string; text: string; findings: Finding[] } | undefined;
function findings(context: Context): Finding[] {
  const file = context.filename;
  const text = context.sourceCode.text;
  if (last?.file === file && last.text === text) return last.findings;
  const view = VIEW.test(file);
  last = { file, text, findings: scanI18n(ts, text, file, { view, keys: view ? sourceKeys(file) : undefined }) };
  return last.findings;
}

const rule = (name: Rule) => ({
  create(context: Context) {
    return {
      Program() {
        for (const f of findings(context)) {
          if (f.rule !== name) continue;
          context.report({ message: f.message, loc: { start: { line: f.line, column: f.column }, end: { line: f.endLine, column: f.endColumn } } });
        }
      },
    };
  },
});

const RULES: Rule[] = ['no-text-expression', 'logical-direction', 'locale-aware', 't-key', 'no-compare-text', 'no-concat-text', 'number-format'];

export default {
  meta: { name: 'i18n' },
  rules: Object.fromEntries(RULES.map((r) => [r, rule(r)])),
};
