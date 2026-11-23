/** The built page (`dist/index.html`) filled in per page, by scripts/prerender.ts. */

export type Head = { title: string; description: string; lang: string; path: string; jsonLd?: object };

const APP = '<div id="app"></div>';

/** `template`, if it's the page this fills in. */
export function checkTemplate(template: string): string {
  if (!template.includes(APP) || !/<title>[^<]*<\/title>/.test(template) || !/<meta name="description" content="[^"]*">/.test(template)) {
    throw new Error('dist/index.html is not the page this script fills in: it needs <title>, <meta name="description"> and an empty <div id="app">');
  }
  return template;
}

/** The lesson domain's player (web/server, lessons.rs): the bare page, which nothing indexes. */
export function playerPage(template: string): string {
  return template.replace('</head>', '  <meta name="robots" content="noindex, nofollow">\n</head>');
}

export const attr = (s: string) => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export const text = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
// inside <script>: nothing in it may end it
const json = (o: object) => JSON.stringify(o).replaceAll('<', '\\u003c');

/** The template with `markup` in it and `head`'s title, description, language and the rest; `base` the site's URL. */
export function fill(template: string, markup: string, head: Head, base: string, extra: string[] = []): string {
  const tags = [
    ...extra,
    `<meta property="og:title" content="${attr(head.title)}">`,
    `<meta property="og:description" content="${attr(head.description)}">`,
    `<meta property="og:type" content="website">`,
    ...(base ? [`<link rel="canonical" href="${attr(`${base}${head.path}`)}">`, `<meta property="og:url" content="${attr(`${base}${head.path}`)}">`] : []),
    ...(head.jsonLd ? [`<script type="application/ld+json">${json(head.jsonLd)}</script>`] : []),
  ];
  // replaced by functions: a `$` in what goes in is just a `$`
  return template
    .replace(/<html lang="[^"]*">/, () => `<html lang="${attr(head.lang)}">`)
    .replace(/<title>[^<]*<\/title>/, () => `<title>${text(head.title)}</title>`)
    .replace(/<meta name="description" content="[^"]*">/, () => `<meta name="description" content="${attr(head.description)}">`)
    .replace('</head>', () => `  ${tags.join('\n  ')}\n</head>`)
    .replace(APP, () => `<div id="app">${markup}</div>`);
}
