/**
 * A view's one file to the module the frame runs: TypeScript and JSX out, ES imports kept. The same for views in
 * source (at build time) and vibecoded ones (in the browser), so there is one way a view runs.
 */
import { transform } from 'sucrase';

/** What the frame's runtime provides; any other bare import is fetched from npm. */
export const RUNTIME_MODULES = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', 'lucide-react', '@gestalts/view', '@gestalts/kit', '@gestalts/learning', '@gestalts/sources'] as const;

export type CompileError = { message: string; line?: number; column?: number };
/**
 * `imports`: the parts a view uses from each package whose parts have data needs (`needs.ts`), by their exported names.
 * The compiler drops imports used only as types, or not at all, so these are what the view's code refers to.
 */
export type Compiled = { ok: true; js: string; npm: string[]; imports: Record<string, string[]> } | { ok: false; errors: CompileError[] };

/** The packages whose parts declare what they read and write (`needs.ts` in each). */
export const WITH_NEEDS = ['@gestalts/kit', '@gestalts/learning'] as const;
const STATEMENT = /(?:^|[\n;])\s*import\s+([^'"\n;]*?)\s*\bfrom\s+(['"])([^'"\n]+)\2/g;

const IMPORT = /(?:^|[\n;])\s*(?:import|export)\s+(?:[^'"\n;]*?\bfrom\s+)?(['"])([^'"\n]+)\1/g;
const runtime: readonly string[] = RUNTIME_MODULES;

export function compile(source: string, filePath = 'view.tsx'): Compiled {
  let js: string;
  try {
    js = transform(source, { transforms: ['typescript', 'jsx'], jsxRuntime: 'automatic', production: true, filePath }).code;
  } catch (e) {
    const err = e as { message?: string; loc?: { line: number; column: number } };
    return { ok: false, errors: [{ message: err.message ?? String(e), line: err.loc?.line, column: err.loc?.column }] };
  }
  const imports = [...new Set([...js.matchAll(IMPORT)].map((m) => m[2]))];
  const errors: CompileError[] = imports.filter((i) => i.startsWith('.') || i.startsWith('/')).map((i) => ({ message: `cannot import ${JSON.stringify(i)}: a view is one file` }));
  if (!/\bexport\s+default\b/.test(js)) errors.push({ message: 'a view needs a default export: the React component to show' });
  const parts: Record<string, string[]> = {};
  for (const [, clause, , from] of js.matchAll(STATEMENT)) {
    if (!(WITH_NEEDS as readonly string[]).includes(from)) continue;
    const named = /^\{([^}]*)\}$/.exec(clause.trim());
    // what a part reads and writes is checked by its name
    if (!named) { errors.push({ message: `import ${from}'s parts by name (import { … } from '${from}')` }); continue; }
    const names = named[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0]).filter(Boolean);
    parts[from] = [...new Set([...(parts[from] ?? []), ...names])];
  }
  if (/\bimport\s*\(\s*['"]@gestalts\/(?:kit|learning)['"]/.test(js)) errors.push({ message: 'import the kit and learning statically, by name' });
  return errors.length ? { ok: false, errors } : { ok: true, js, npm: imports.filter((i) => !runtime.includes(i)), imports: parts };
}
