const ACCENTED: Record<string, string> = {
  a: 'à', b: 'ƀ', c: 'ç', d: 'ð', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'î', j: 'ĵ', k: 'ķ', l: 'ļ', m: 'ɱ', n: 'ñ', o: 'ö',
  p: 'þ', q: 'ǫ', r: 'ŕ', s: 'š', t: 'ţ', u: 'û', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž',
  A: 'Å', B: 'Ɓ', C: 'Ç', D: 'Ð', E: 'É', F: 'Ƒ', G: 'Ĝ', H: 'Ĥ', I: 'Î', J: 'Ĵ', K: 'Ķ', L: 'Ļ', M: 'Ṁ', N: 'Ñ', O: 'Ö',
  P: 'Þ', Q: 'Ǫ', R: 'Ŕ', S: 'Š', T: 'Ţ', U: 'Û', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ', Y: 'Ý', Z: 'Ž',
};

/**
 * `text` in the pseudo-locale: letters accented, placeholders (`{name}`, escaped braces) kept, about a third longer
 * and bracketed, so text that bypasses the messages, and text cut off or overflowing, stand out.
 */
export function pseudo(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { out += c + (text[i + 1] ?? ''); i++; continue; }
    if (c === '{') {
      const end = text.indexOf('}', i);
      if (end > 0) { out += text.slice(i, end + 1); i = end; continue; }
    }
    out += ACCENTED[c] ?? c;
  }
  const pad = '~'.repeat(Math.max(1, Math.round(text.length / 3)));
  return `[${out} ${pad}]`;
}
