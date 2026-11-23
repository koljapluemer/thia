/** One line of a diff: kept, removed (`-`) or added (`+`). */
export type DiffLine = { op: ' ' | '-' | '+'; text: string };

/** above this many lines on either side, the diff isn't worked out (it's quadratic): both are shown whole */
const MAX_LINES = 5000;

/** The lines from `a` to `b`, by their longest common subsequence; `undefined` when they're too long for it. */
export function lineDiff(a: string, b: string): DiffLine[] | undefined {
  const x = a.split('\n');
  const y = b.split('\n');
  if (x.length > MAX_LINES || y.length > MAX_LINES) return undefined;
  // common lines at both ends need no table
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start++;
  let end = 0;
  while (end < x.length - start && end < y.length - start && x[x.length - 1 - end] === y[y.length - 1 - end]) end++;
  const xs = x.slice(start, x.length - end);
  const ys = y.slice(start, y.length - end);
  const w = ys.length + 1;
  const len = new Uint32Array((xs.length + 1) * w);
  for (let i = xs.length - 1; i >= 0; i--) {
    for (let j = ys.length - 1; j >= 0; j--) {
      len[i * w + j] = xs[i] === ys[j] ? len[(i + 1) * w + j + 1] + 1 : Math.max(len[(i + 1) * w + j], len[i * w + j + 1]);
    }
  }
  const out: DiffLine[] = x.slice(0, start).map((text) => ({ op: ' ', text }));
  let i = 0;
  let j = 0;
  while (i < xs.length || j < ys.length) {
    if (i < xs.length && j < ys.length && xs[i] === ys[j]) { out.push({ op: ' ', text: xs[i] }); i++; j++; }
    else if (j < ys.length && (i === xs.length || len[i * w + j + 1] >= len[(i + 1) * w + j])) { out.push({ op: '+', text: ys[j] }); j++; }
    else { out.push({ op: '-', text: xs[i] }); i++; }
  }
  out.push(...x.slice(x.length - end).map((text) => ({ op: ' ' as const, text })));
  return out;
}
