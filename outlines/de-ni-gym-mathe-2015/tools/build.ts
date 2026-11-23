// Rewrites this outline's notes/ from the Kerncurriculum's PDF: its Lernbereiche (chapter 3.3) per Doppelschuljahrgang,
// each with its Kern (bullets and their sub-bullets) and its Fakultative Erweiterungen. The Intentionen, the content
// areas and the notes on digital tools aren't kept. Concepts come from tools/concepts.yml, by an entry's labels from
// its Lernbereich down, joined by ` › `.
//
//   node outlines/de-ni-gym-mathe-2015/tools/build.ts [kc.pdf]   (needs pdftotext, from poppler)
//   mise run publish-data outlines/de-ni-gym-mathe-2015
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type Node, readMapping, write } from '../../lib/outline.ts';

const DIR = resolve(import.meta.dirname, '..');
const PDF_URL = 'https://cuvo.nibis.de/index.php?p=download&upload=63';
const DETAIL_URL = 'https://cuvo.nibis.de/index.php?p=detail_view&docid=1779';
const BULLET = '';
const STAGES: Record<string, string[]> = {
  '5 und 6': ['Umgang mit natürlichen Zahlen', 'Körper und Figuren', 'Umgang mit Brüchen', 'Planung und Durchführung statistischer Erhebungen', 'Umgang mit Dezimalzahlen', 'Symmetrien', 'Maßzahlen statistischer Erhebungen'],
  '7 und 8': ['Umgang mit negativen Zahlen', 'Wahrscheinlichkeit', 'Proportionale und antiproportionale Zusammenhänge', 'Längen, Flächen- und Rauminhalte und deren Terme', 'Elementare Termumformungen', 'Entdeckungen an Dreiecken – Konstruktionen und besondere Linien', 'Ein- und mehrstufige Zufallsversuche', 'Lineare Zusammenhänge'],
  '9 und 10': ['Baumdiagramme und Vierfeldertafeln', 'Entdeckungen an rechtwinkligen Dreiecken und Ähnlichkeit', 'Quadratische Zusammenhänge', 'Kreis- und Körperberechnungen', 'Exponentielle Zusammenhänge', 'Periodische Zusammenhänge', 'Näherungsverfahren als Grenzprozesse – Zahlbereichserweiterungen'],
};

async function pdfText(path?: string): Promise<string> {
  let file = path;
  if (!file) {
    const res = await fetch(PDF_URL);
    if (!res.ok) throw new Error(`${PDF_URL}: ${res.status}`);
    file = join(mkdtempSync(join(tmpdir(), 'kc-ni-')), 'kc.pdf');
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  return execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8', maxBuffer: 64 << 20 });
}

/** The Symbol font's private-use code points, as the characters they draw. */
const SYMBOL: Record<string, string> = {
  '\uf03d': '=', '\uf0d7': '·', '\uf02b': '+', '\uf02d': '−', '\uf0b3': '≥', '\uf0a3': '≤', '\uf03e': '>', '\uf03c': '<',
  '\uf070': 'π', '\uf028': '(', '\uf029': ')', '\uf0bb': '≈', '\uf0b1': '±', '\uf0b9': '≠',
};
const symbols = (line: string) => line.replace(/[\uf000-\uf0ff]/g, (c) => (c === BULLET ? c : SYMBOL[c] ?? c));

/**
 * Labels whose formulas the text layer garbles (superscripts, an overline, fractions are drawn, not text), as the PDF
 * prints them: text as extracted (Symbol glyphs mapped) → as printed. Each must match once, so a new PDF shows up.
 */
const PRINTED: Record<string, string> = {
  'Zusammenhang von Funktionsgleichung und -graph für f(x) = a · x2 + b · x + c': 'Zusammenhang von Funktionsgleichung und -graph für f(x) = a · x² + b · x + c',
  'Zusammenhang von Funktionsgleichung und -graph für f(x) = a · (x − d)2 + e': 'Zusammenhang von Funktionsgleichung und -graph für f(x) = a · (x − d)² + e',
  'x2 + p · x = 0 und x 2 + q = 0 hilfsmittelfrei lösen 2 2': 'x² + p · x = 0 und x² + q = 0 hilfsmittelfrei lösen',
  'x2 + p · x + q = 0 , a · x + b · x = 0 , a · x + c = 0 und a · (x − d)2 + e = 0 lösen, in einfachen Fällen auch hilfsmittelfrei':
    'x² + p · x + q = 0, a · x² + b · x = 0, a · x² + c = 0 und a · (x − d)² + e = 0 lösen, in einfachen Fällen auch hilfsmittelfrei',
  'Zusammenhang von Funktionsgleichung und -graph für f(x) = a · b x + c': 'Zusammenhang von Funktionsgleichung und -graph für f(x) = a · bˣ + c',
  'hilfsmittelfreies Skizzieren der Graphen f(x) = a · bx für b > 0': 'hilfsmittelfreies Skizzieren der Graphen f(x) = a · bˣ für b > 0',
  'Zusammenhang von Funktionsgleichung und -graph für f(x) = a · sin (b · (x − c) ) + d': 'Zusammenhang von Funktionsgleichung und -graph für f(x) = a · sin(b · (x − c)) + d',
  'die Identität 0,9 = 1 als Grenzprozess': 'die Identität 0,9\u0305 = 1 als Grenzprozess',
  'Grenzverhalten des Graphen von f mit f(x) = x': 'Grenzverhalten des Graphen von f mit f(x) = 1/x',
};
/** Fakultative Erweiterungen the text layer scrambles, by Lernbereich, as printed */
const PRINTED_EXTENSIONS: Record<string, string[]> = {
  'Näherungsverfahren als Grenzprozesse – Zahlbereichserweiterungen': [
    'Grenzverhalten der Graphen von f und g mit f(x) = a ± b/x und g(x) = a · bˣ; b > 0',
    'Grenzprozesse beim Pyramidenvolumen, bei der Kegelmantelfläche und bei der Kugel',
  ],
};

/** A wrapped line joined to the one before: a hyphen at the end goes, unless it stands for a word (`Flächen- und`). */
function join2(a: string, b: string): string {
  if (/\p{L}-$/u.test(a) && !/^(und|oder|bzw\.|sowie)\b/.test(b)) return /^\p{Ll}/u.test(b) ? a.slice(0, -1) + b : a + b;
  return `${a} ${b}`;
}

type Mode = 'skip' | 'kern' | 'erw';

function parse(text: string): Node[] {
  const stages: Node[] = [];
  let stage: Node | undefined;
  let unit: Node | undefined;
  let mode: Mode = 'skip';
  let erw: string[] = [];
  let last: Node | undefined;
  const flushErw = () => {
    if (!unit || !erw.length) return;
    // "––" for none
    const items = PRINTED_EXTENSIONS[unit.label] ?? erw.reduce(join2).split(';').map((s) => s.trim()).filter((s) => s && !/^[–-]+$/.test(s));
    erw = [];
    if (!items.length) return;
    unit.children.push({ label: 'Fakultative Erweiterungen', kind: 'Erweiterung', key: `${unit.label} › Fakultative Erweiterungen`, children: items.map((i) => ({ label: i, key: `${unit!.label} › Fakultative Erweiterungen › ${i}`, children: [] })) });
    erw = [];
  };
  // only chapter 3.3 on: the first stage heading after the table of contents
  const lines = text.split('\n');
  const start = lines.findIndex((l, i) => i > 200 && /^3\.3\.1\s+Lernbereiche für den Doppelschuljahrgang/.test(l.replace(/\f/g, '')));
  for (const raw of lines.slice(start)) {
    const line = symbols(raw.replace(/\f/g, '')).trim();
    const s = /^3\.3\.\d\s+Lernbereiche für den Doppelschuljahrgang (\d+ und \d+)$/.exec(line);
    if (s) {
      flushErw();
      const grades = s[1].split(' und ').map(Number);
      stage = { label: `Doppelschuljahrgang ${grades.join('/')}`, kind: 'Doppelschuljahrgang', level: `Doppelschuljahrgang ${grades.join('/')}`, grades, isced: 2, key: `Doppelschuljahrgang ${grades.join('/')}`, children: [] };
      stages.push(stage);
      mode = 'skip';
      continue;
    }
    const lb = /^Lernbereich:\s+(.+)$/.exec(line);
    if (lb) {
      flushErw();
      if (!stage) throw new Error(`Lernbereich ${lb[1]} before any Doppelschuljahrgang`);
      const label = lb[1].replace(/\s+/g, ' ');
      unit = { label, kind: 'Lernbereich', key: label, children: [] };
      stage.children.push(unit);
      mode = 'skip';
      continue;
    }
    if (!unit) continue;
    if (line === 'Kern') { mode = 'kern'; last = undefined; continue; }
    if (line === 'Fakultative Erweiterungen') { mode = 'erw'; continue; }
    if (line === 'Inhaltsbezogene Kompetenzbereiche' || line.startsWith('Hinweise zum Einsatz digitaler') || line === 'Intentionen') {
      if (mode === 'erw') flushErw();
      mode = 'skip';
      continue;
    }
    if (!line || /^\d+$/.test(line)) continue;
    if (mode === 'erw') { erw.push(line); continue; }
    if (mode !== 'kern') continue;
    if (line.startsWith(BULLET)) {
      const label = line.slice(1).trim();
      last = { label, kind: 'Kern', key: `${unit.label} › ${label}`, children: [] };
      unit.children.push(last);
    } else if (/^o\s/.test(line)) {
      const parent = unit.children.at(-1);
      if (!parent || parent.kind !== 'Kern') throw new Error(`${unit.label}: a sub-bullet before any bullet: ${line}`);
      const label = line.slice(2).trim();
      // the PDF breaks one item into two now and then ("… identifizieren und" / "o konstruieren")
      if (last && last !== parent && /\s(und|oder)$/.test(last.label) && /^\p{Ll}/u.test(label)) last.label = `${last.label} ${label}`;
      else {
        last = { label, key: '', children: [] };
        parent.children.push(last);
      }
    } else if (last) {
      last.label = join2(last.label, line);
    } else {
      throw new Error(`${unit.label}: text in the Kern before any bullet: ${line}`);
    }
  }
  flushErw();
  // labels as printed, then keys once labels are whole
  const unused = new Set(Object.keys(PRINTED));
  const fix = (n: Node) => {
    const l = n.label.replace(/\s+/g, ' ');
    if (PRINTED[l]) { n.label = PRINTED[l]; unused.delete(l); }
    n.children.forEach(fix);
  };
  stages.forEach(fix);
  if (unused.size) throw new Error(`corrections that match nothing: ${[...unused].join('; ')}`);
  for (const st of stages) for (const u of st.children) for (const k of u.children) {
    if (k.kind === 'Kern') k.key = `${u.label} › ${k.label}`;
    for (const c of k.children) if (k.kind === 'Kern') c.key = `${k.key} › ${c.label}`;
  }
  return stages;
}

const stages = parse(await pdfText(process.argv[2]));
// what the curriculum is: 7, 8 and 7 Lernbereiche, as named
const want = Object.entries(STAGES);
if (stages.length !== want.length) throw new Error(`${stages.length} Doppelschuljahrgänge, not ${want.length}`);
for (const [i, [grades, titles]] of want.entries()) {
  const got = stages[i].children.map((u) => u.label);
  if (stages[i].label !== `Doppelschuljahrgang ${grades.replace(' und ', '/')}` || got.join('|') !== titles.join('|')) throw new Error(`${stages[i].label}: ${got.join('; ')}`);
  for (const u of stages[i].children) if (!u.children.some((k) => k.kind === 'Kern')) throw new Error(`${u.label}: no Kern`);
}

write(
  DIR,
  {
    name: 'de-ni-gym-mathe-2015',
    title: 'Kerncurriculum Mathematik, Gymnasium, Schuljahrgänge 5–10',
    lang: 'de',
    issuer: 'Niedersächsisches Kultusministerium',
    region: 'DE-NI',
    subject: 'Mathematik',
    school_type: 'Gymnasium',
    edition: '2015',
    valid_from: '2015',
  },
  stages,
  {
    id: 'source-de-ni-gym-mathe-2015',
    gestalt: 'source@1',
    key: 'nkm2015mathegym',
    entrytype: 'report',
    title: 'Kerncurriculum für das Gymnasium, Schuljahrgänge 5–10: Mathematik',
    institution: ['Niedersächsisches Kultusministerium'],
    location: ['Hannover'],
    date: '2015',
    url: DETAIL_URL,
  },
  readMapping(join(DIR, 'tools/concepts.yml')),
);
