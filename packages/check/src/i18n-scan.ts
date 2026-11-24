/**
 * The i18n rules over one TSX file, on TypeScript's syntax tree: what the linter reports over this repo
 * (`packages/check/lint/i18n.ts`, through oxlint) and what the check reports over an agent's view, alike. TypeScript
 * comes in from the caller (`typescript-js`, loaded where it runs), so this file stays light.
 */
import type * as TS from 'typescript-js';
import { INTL_FORMATS, LOCALE_METHODS, MESSAGES, PHYSICAL_STYLE, TEXT_ATTRIBUTES, isText, physicalClasses } from './i18n-rules.ts';

export type Rule =
  /** text written into JSX, or into an attribute a person reads (the linter has `react/jsx-no-literals` for it) */
  | 'jsx-text'
  /** a string shown from a JSX expression: `{'Save'}`, `{busy ? '…' : 'Move'}`, `{`${n} cards`}` */
  | 'no-text-expression'
  /** left and right that don't turn around for right-to-left text: `ml-2`, `text-left`, `style={{ left }}` */
  | 'logical-direction'
  /** `toLocaleString()` or `new Intl.NumberFormat()` without a language */
  | 'locale-aware'
  /** `t()` with a key that isn't a literal, or isn't in the view's wording */
  | 't-key'
  /** `t('x') === …`: code that depends on what the text says, which rewording and translating change */
  | 'no-compare-text'
  /** `t('a') + t('b')`, `${t('a')} …`: text put together in code, which no other language can reorder */
  | 'no-concat-text'
  /** `parseFloat(input.value)`, `.toFixed()` shown: numbers the person reads and types, not as they write them */
  | 'number-format';

export type Finding = { rule: Rule; message: string; line: number; column: number; endLine: number; endColumn: number };

export type ScanOptions = {
  /** the keys of the view's source wording; `null`: it has none; undefined: `t()` isn't checked */
  keys?: Set<string> | null;
  /** a view (a plugin's or an agent's): numbers the person types and reads are checked too */
  view?: boolean;
  /** which rules: all, unless said */
  rules?: Rule[];
  /** filled with the keys `t()` is called with */
  used?: Set<string>;
};

/** Every place in `source` (a TSX file) that breaks a rule. */
export function scanI18n(ts: typeof TS, source: string, fileName: string, opts: ScanOptions = {}): Finding[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Finding[] = [];
  const on = (r: Rule) => !opts.rules || opts.rules.includes(r);
  const report = (rule: Rule, node: TS.Node, message: string) => {
    if (!on(rule)) return;
    const a = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    const b = sf.getLineAndCharacterOfPosition(node.getEnd());
    out.push({ rule, message, line: a.line + 1, column: a.character, endLine: b.line + 1, endColumn: b.character });
  };
  const unwrap = (e: TS.Expression): TS.Expression => (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) ? unwrap(e.expression) : e);
  const isT = (e: TS.Node): e is TS.CallExpression => ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 't';
  const hasT = (e: TS.Node): boolean => isT(e) || (ts.forEachChild(e, (c) => (hasT(c) ? true : undefined)) ?? false);

  /** the strings an expression shows as itself: literals, template text, either branch, the right of && || ?? */
  const shown = (e: TS.Expression, acc: { node: TS.Node; text: string }[] = []) => {
    e = unwrap(e);
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) acc.push({ node: e, text: e.text });
    else if (ts.isTemplateExpression(e)) acc.push({ node: e, text: [e.head.text, ...e.templateSpans.map((s) => s.literal.text)].join(' ') });
    else if (ts.isConditionalExpression(e)) { shown(e.whenTrue, acc); shown(e.whenFalse, acc); }
    else if (ts.isBinaryExpression(e) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(e.operatorToken.kind)) shown(e.right, acc);
    return acc;
  };
  /** the string parts of a className: literals, template text, inside calls (clsx), branches and arrays */
  const classParts = (e: TS.Node | undefined, acc: { node: TS.Node; text: string }[] = []) => {
    if (!e) return acc;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) acc.push({ node: e, text: e.text });
    else if (ts.isTemplateExpression(e)) {
      acc.push({ node: e.head, text: e.head.text });
      for (const s of e.templateSpans) { classParts(s.expression, acc); acc.push({ node: s.literal, text: s.literal.text }); }
    } else if (ts.isJsxExpression(e) || ts.isParenthesizedExpression(e)) classParts(e.expression, acc);
    else if (ts.isConditionalExpression(e)) { classParts(e.whenTrue, acc); classParts(e.whenFalse, acc); }
    else if (ts.isBinaryExpression(e)) { classParts(e.left, acc); classParts(e.right, acc); }
    else if (ts.isCallExpression(e)) e.arguments.forEach((a) => classParts(a, acc));
    else if (ts.isArrayLiteralExpression(e)) e.elements.forEach((a) => classParts(a, acc));
    return acc;
  };
  const unset = (args: readonly TS.Expression[] | undefined) => {
    const a = args?.[0];
    return !a || (ts.isIdentifier(a) && a.text === 'undefined') || (ts.isArrayLiteralExpression(a) && a.elements.length === 0);
  };
  // what was typed: an event's target, a ref's element, an input's value; not a yml's `value`
  const readsInput = (e: TS.Node) => /\b(target|currentTarget|current|input\w*|field\w*|box\w*|el)\)?\.value\b|as HTML\w+Element\)\.value\b/.test(e.getText(sf));

  const visit = (node: TS.Node, inJsx: boolean) => {
    if (ts.isJsxText(node) && !node.containsOnlyTriviaWhiteSpaces && isText(node.text)) report('jsx-text', node, MESSAGES.text(node.text));

    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sf);
      const init = node.initializer;
      if (TEXT_ATTRIBUTES.includes(name) && init) {
        const strings = ts.isStringLiteral(init) ? [{ node: init as TS.Node, text: init.text }] : ts.isJsxExpression(init) && init.expression ? shown(init.expression) : [];
        for (const s of strings) if (isText(s.text)) report('jsx-text', s.node, MESSAGES.text(s.text));
      }
      if (name === 'className' || name === 'class') {
        for (const p of classParts(init)) for (const { found, use } of physicalClasses(p.text)) report('logical-direction', p.node, MESSAGES.physical(found, use));
      }
      if (name === 'style' && init && ts.isJsxExpression(init) && init.expression && ts.isObjectLiteralExpression(unwrap(init.expression))) {
        for (const p of (unwrap(init.expression) as TS.ObjectLiteralExpression).properties) {
          if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) continue;
          const key = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined;
          if (key && PHYSICAL_STYLE[key]) report('logical-direction', p, MESSAGES.physical(key, PHYSICAL_STYLE[key]));
          if (key === 'textAlign' && ts.isPropertyAssignment(p) && ts.isStringLiteral(p.initializer) && (p.initializer.text === 'left' || p.initializer.text === 'right')) {
            report('logical-direction', p, MESSAGES.physical(`textAlign: '${p.initializer.text}'`, p.initializer.text === 'left' ? "'start'" : "'end'"));
          }
        }
      }
    }

    if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      for (const s of shown(node.expression)) if (isText(s.text)) report('no-text-expression', s.node, MESSAGES.text(s.text));
    }

    if (ts.isCallExpression(node)) {
      const c = node.expression;
      if (ts.isPropertyAccessExpression(c) && LOCALE_METHODS.includes(c.name.text) && unset(node.arguments)) report('locale-aware', node, MESSAGES.locale(`${c.name.text}()`));
      if (isT(node) && opts.keys !== undefined) {
        const k = node.arguments[0];
        if (!k || !(ts.isStringLiteral(k) || ts.isNoSubstitutionTemplateLiteral(k))) report('t-key', node, MESSAGES.tLiteral);
        else if ((opts.used?.add(k.text), opts.keys === null)) report('t-key', k, MESSAGES.tNoWording);
        else if (!opts.keys.has(k.text)) report('t-key', k, MESSAGES.tMissing(k.text));
      }
      if (opts.view) {
        const fn = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && c.expression.text === 'Number' ? `Number.${c.name.text}` : '';
        if (['parseFloat', 'parseInt', 'Number', 'Number.parseFloat', 'Number.parseInt'].includes(fn) && node.arguments[0] && readsInput(node.arguments[0])) report('number-format', node, MESSAGES.parse(fn));
        if (inJsx && ts.isPropertyAccessExpression(c) && (c.name.text === 'toFixed' || c.name.text === 'toPrecision')) report('number-format', node, MESSAGES.fixed(c.name.text));
      }
    }
    if (opts.view && ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.PlusToken && readsInput(node.operand)) report('number-format', node, MESSAGES.parse('+'));

    if (ts.isNewExpression(node)) {
      const c = node.expression;
      if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && c.expression.text === 'Intl' && INTL_FORMATS.includes(c.name.text) && unset(node.arguments)) report('locale-aware', node, MESSAGES.locale(`new Intl.${c.name.text}()`));
    }

    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      const compares = [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(op);
      if (compares && (isT(unwrap(node.left)) || isT(unwrap(node.right)))) report('no-compare-text', node, MESSAGES.compare);
      if (op === ts.SyntaxKind.PlusToken && (isT(unwrap(node.left)) || isT(unwrap(node.right)))) report('no-concat-text', node, MESSAGES.concat);
    }
    if (ts.isSwitchStatement(node) && isT(unwrap(node.expression))) report('no-compare-text', node.expression, MESSAGES.compare);
    if (ts.isCaseClause(node) && isT(unwrap(node.expression))) report('no-compare-text', node.expression, MESSAGES.compare);
    if (ts.isTemplateExpression(node) && node.templateSpans.some((s) => hasT(s.expression)) && [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].some(isText)) {
      report('no-concat-text', node, MESSAGES.concat);
    }

    ts.forEachChild(node, (c) => visit(c, inJsx || ts.isJsxExpression(node)));
  };
  visit(sf, false);
  return out;
}
