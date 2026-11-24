/**
 * oxlint's `i18n` plugin (`oxlint.config.ts`, `jsPlugins`): the rules of `src/i18n-rules.ts` over this repo's code.
 * `react/jsx-no-literals` (built in) refuses bare JSX text and text attributes; these cover what it doesn't:
 *
 * - `i18n/no-text-expression`: a string in a JSX expression (`{'Save'}`, `{busy ? '…' : 'Move'}`)
 * - `i18n/logical-direction`: Tailwind's `ml-`, `text-left` and the like, which don't turn around for right-to-left
 * - `i18n/locale-aware`: `toLocaleString()` or `new Intl.NumberFormat()` without a language
 */
import { INTL_FORMATS, LOCALE_METHODS, MESSAGES, PHYSICAL_STYLE, isText, physicalClasses } from '../src/i18n-rules.ts';

type Node = { type: string; [k: string]: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
type Context = { report(d: { node: Node; message: string }): void };

/** The strings an expression shows as itself: a literal, a template without holes, either branch of `?:`, the right of `&&`/`||`/`??`. */
function shown(e: Node | null | undefined): Node[] {
  if (!e) return [];
  if (e.type === 'Literal' && typeof e.value === 'string') return [e];
  if (e.type === 'TemplateLiteral' && e.expressions.length === 0) return [e];
  if (e.type === 'ConditionalExpression') return [...shown(e.consequent), ...shown(e.alternate)];
  if (e.type === 'LogicalExpression') return shown(e.right);
  return [];
}
const textOf = (n: Node): string => (n.type === 'Literal' ? String(n.value) : n.quasis.map((q: Node) => q.value.cooked ?? '').join(''));

/** The string parts of a className expression: literals, template parts, and those inside calls (`clsx(...)`) and branches. */
function classParts(e: Node | null | undefined, out: Node[] = []): Node[] {
  if (!e) return out;
  if (e.type === 'Literal' && typeof e.value === 'string') out.push(e);
  else if (e.type === 'TemplateLiteral') { out.push(...e.quasis); e.expressions.forEach((x: Node) => classParts(x, out)); }
  else if (e.type === 'ConditionalExpression') { classParts(e.consequent, out); classParts(e.alternate, out); }
  else if (e.type === 'LogicalExpression' || e.type === 'BinaryExpression') { classParts(e.left, out); classParts(e.right, out); }
  else if (e.type === 'CallExpression') e.arguments.forEach((x: Node) => classParts(x, out));
  else if (e.type === 'ArrayExpression') e.elements.forEach((x: Node) => classParts(x, out));
  else if (e.type === 'JSXExpressionContainer') classParts(e.expression, out);
  return out;
}
const classText = (n: Node): string => (n.type === 'TemplateElement' ? n.value.cooked ?? '' : String(n.value));

const noTextExpression = {
  create(context: Context) {
    return {
      JSXExpressionContainer(node: Node & { parent?: Node }) {
        // children only: attributes are jsx-no-literals' (text ones) or not text at all (className, href)
        if (node.parent?.type !== 'JSXElement' && node.parent?.type !== 'JSXFragment') return;
        for (const s of shown(node.expression)) if (isText(textOf(s))) context.report({ node: s, message: MESSAGES.text(textOf(s)) });
      },
    };
  },
};

const logicalDirection = {
  create(context: Context) {
    return {
      JSXAttribute(node: Node) {
        const name = node.name?.name;
        if (name === 'style' && node.value?.expression?.type === 'ObjectExpression') {
          for (const p of node.value.expression.properties) {
            const key = p.type === 'Property' && !p.computed ? (p.key.name ?? p.key.value) : undefined;
            if (key && PHYSICAL_STYLE[key]) context.report({ node: p, message: MESSAGES.physical(key, PHYSICAL_STYLE[key]) });
            if (key === 'textAlign' && p.value.type === 'Literal' && (p.value.value === 'left' || p.value.value === 'right')) {
              context.report({ node: p, message: MESSAGES.physical(`textAlign: '${p.value.value}'`, p.value.value === 'left' ? "'start'" : "'end'") });
            }
          }
          return;
        }
        if (name !== 'className' && name !== 'class') return;
        for (const part of classParts(node.value)) {
          for (const { found, use } of physicalClasses(classText(part))) context.report({ node: part, message: MESSAGES.physical(found, use) });
        }
      },
    };
  },
};

const localeAware = {
  create(context: Context) {
    const unset = (args: Node[]) => !args.length || (args[0].type === 'Identifier' && args[0].name === 'undefined') || (args[0].type === 'ArrayExpression' && args[0].elements.length === 0);
    return {
      CallExpression(node: Node) {
        const c = node.callee;
        if (c.type === 'MemberExpression' && !c.computed && LOCALE_METHODS.includes(c.property.name) && unset(node.arguments)) {
          context.report({ node, message: MESSAGES.locale(`${c.property.name}()`) });
        }
      },
      NewExpression(node: Node) {
        const c = node.callee;
        if (c.type === 'MemberExpression' && c.object.type === 'Identifier' && c.object.name === 'Intl' && INTL_FORMATS.includes(c.property.name) && unset(node.arguments)) {
          context.report({ node, message: MESSAGES.locale(`new Intl.${c.property.name}()`) });
        }
      },
    };
  },
};

export default {
  meta: { name: 'i18n' },
  rules: { 'no-text-expression': noTextExpression, 'logical-direction': logicalDirection, 'locale-aware': localeAware },
};
