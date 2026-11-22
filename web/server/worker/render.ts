// A built viz rendered in headless Chromium, for the server's agent when GESTALTS_VIZ_RENDER=worker: what
// `@gestalts/check`'s render does in the page (packages/check/src/render.ts), with a real browser instead of sandboxed
// frames. At 360 and 1000 px, light and dark, offline: uncaught and console errors, requests (there's no network),
// a runtime that didn't mount, the viz's own error, empty renders and horizontal overflow; a screenshot of each, and
// the still, 800 px wide, light, cut to 5:3 at most.
//
// Env: GESTALTS_CHROMIUM, the browser to run (else the one playwright installed).
import { chromium, type Browser } from 'playwright-core';
import type { Render, Shot } from '@gestalts/check';

const VIEWS = [[360, 'light'], [1000, 'light'], [1000, 'dark']] as const;
const SETTLE_MS = 800;
const MIN_HEIGHT = 8;
const TIMEOUT_MS = 20_000;
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:";

let browser: Promise<Browser> | undefined;
function launch(): Promise<Browser> {
  browser ??= chromium.launch({ executablePath: process.env.GESTALTS_CHROMIUM || undefined }).catch((e: unknown) => {
    browser = undefined;
    throw new Error(`no Chromium to render visualizations with (set GESTALTS_CHROMIUM, or run \`npx playwright-core install chromium\`): ${e instanceof Error ? e.message : String(e)}`);
  });
  return browser;
}

const withCsp = (html: string) => {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;
  return html.includes('<head>') ? html.replace('<head>', `<head>${meta}`) : `${meta}${html}`;
};

function within<T>(p: Promise<T>, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} within ${TIMEOUT_MS / 1000} s (an endless loop?)`)), TIMEOUT_MS))]);
}

type Probe = { problems: string[]; png?: Uint8Array };

async function frame(html: string, width: number, mode: 'light' | 'dark', clip?: number): Promise<Probe> {
  const ctx = await (await launch()).newContext({ viewport: { width, height: 600 }, colorScheme: mode, offline: true });
  const problems: string[] = [];
  try {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(`uncaught: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console.error: ${m.text()}`); });
    page.on('requestfailed', (r) => { if (!/^(data|blob):/.test(r.url())) problems.push(`blocked request (a viz must work offline): ${r.url()}`); });
    await page.setContent(withCsp(html), { waitUntil: 'load', timeout: TIMEOUT_MS });
    // the theme as the page around it says it (`Down` in @gestalts/viz's protocol): here the page is its own parent
    await page.evaluate((m) => postMessage({ type: 'theme', mode: m }, '*'), mode);
    await page.waitForTimeout(SETTLE_MS);
    const m = await within(page.evaluate(() => {
      const err = document.querySelector<HTMLElement>('.viz-error');
      return {
        height: Math.ceil(document.documentElement.getBoundingClientRect().height),
        used: document.documentElement.scrollWidth,
        mounted: Boolean(document.querySelector('.viz-root')),
        error: err && !err.hidden ? err.textContent : null,
      };
    }), "the page didn't answer");
    if (!m.mounted) problems.push("the runtime didn't mount: no .viz-root");
    if (m.error) problems.push(`the viz showed an error: ${m.error}`);
    if (m.height < MIN_HEIGHT) problems.push(`the page is ${m.height}px high: nothing visible was rendered`);
    if (m.used > width + 1) problems.push(`horizontal overflow at ${width}px wide: content is ${m.used}px wide`);
    const height = clip ? Math.min(Math.max(m.height, 1), clip) : Math.max(m.height, 1);
    await page.setViewportSize({ width, height });
    const png = await within(page.screenshot({ clip: { x: 0, y: 0, width, height } }), "the screenshot didn't finish");
    return { problems, png: new Uint8Array(png) };
  } catch (e) {
    problems.push(e instanceof Error ? e.message : String(e));
    return { problems };
  } finally {
    await ctx.close().catch(() => {});
  }
}

export async function render(html: string): Promise<Render> {
  const problems: string[] = [];
  const shots: Shot[] = [];
  for (const [width, mode] of VIEWS) {
    const p = await frame(html, width, mode);
    for (const m of new Set(p.problems)) problems.push(`${width}px ${mode}: ${m}`);
    if (p.png) shots.push({ name: `check-${width}-${mode}.png`, png: p.png });
  }
  const s = await frame(html, 800, 'light', 480);
  return { problems, shots, still: s.png };
}
