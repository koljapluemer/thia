import { describe, expect, it } from 'vitest';
import { compile } from './compile';

describe('compiling a view', () => {
  it('finds every npm import, also one the JSX runtime import shares a line with', () => {
    const r = compile('import * as THREE from "three";\nimport { OrbitControls } from "three/addons/controls/OrbitControls.js";\nimport { useState } from "react";\nexport default function V() { const [s] = useState(0); return <div>{THREE.REVISION}{String(OrbitControls)}{s}</div>; }\n');
    expect(r.ok && r.npm).toEqual(['three', 'three/addons/controls/OrbitControls.js']);
  });

  it('refuses local imports and a missing default export', () => {
    expect(compile('import x from "./x";\nexport default function V() { return x; }').ok).toBe(false);
    expect(compile('export function V() { return null; }').ok).toBe(false);
  });

  it('names the kit and learning parts a view uses, not those only typed or unused', () => {
    const r = compile("import { Modal, type BlobRef, NoteEditor as Editor, Unused } from '@gestalts/kit';\nimport { logPractice } from '@gestalts/learning';\nconst b: BlobRef[] = [];\nexport default function V() { void logPractice; return <Editor id={String(b)} />; }\n");
    expect(r.ok && r.imports).toEqual({ '@gestalts/kit': ['NoteEditor'], '@gestalts/learning': ['logPractice'] });
  });

  it('refuses the kit imported other than by name', () => {
    expect(compile("import * as kit from '@gestalts/kit';\nexport default function V() { return <kit.Modal />; }").ok).toBe(false);
    expect(compile("export default function V() { void import('@gestalts/kit'); return null; }").ok).toBe(false);
  });
});
