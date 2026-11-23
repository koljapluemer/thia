import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const webApps = [
  'web/app',
  'installables/folder-sync/settings',
];

const sourceFor = (app: string) => {
  try {
    readFileSync(`${app}/icon.svg`);
    return `${app}/icon.svg`;
  } catch {
    return 'assets/icon.svg';
  }
};
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const fail = (message: string): never => {
  throw new Error(`${message}\nRun \`mise run icons\` and commit the generated files.`);
};

for (const app of webApps) {
  const html = readFileSync(`${app}/index.html`, 'utf8');
  if (!html.includes('<link rel="icon" href="/favicon.svg" type="image/svg+xml">')) {
    fail(`${app}/index.html does not reference its favicon`);
  }
  if (hash(`${app}/public/favicon.svg`) !== hash(sourceFor(app))) fail(`${app}/public/favicon.svg is stale`);
}

const pngSize = (path: string) => {
  const png = readFileSync(path);
  if (png.toString('hex', 0, 8) !== '89504e470d0a1a0a') fail(`${path} is not a PNG`);
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
};
const nativeTargets = [
  ['installables/folder-sync/desktop', 'installables/folder-sync/desktop/assets/icon.source.sha256'],
  ['installables/claude-bridge', 'installables/claude-bridge/assets/icon.source.sha256'],
];
for (const [app, stamp] of nativeTargets) {
  if (readFileSync(stamp, 'utf8').trim() !== hash(sourceFor(app))) fail(`${app}'s generated icons are stale`);
}

const pngs = new Map([
  ['installables/folder-sync/desktop/assets/icon.png', 256],
  ['installables/claude-bridge/assets/icon.png', 256],
]);
for (const [path, expected] of pngs) {
  const [width, height] = pngSize(path);
  if (width !== expected || height !== expected) fail(`${path} is ${width}x${height}, expected ${expected}x${expected}`);
}

const desktopConfig = readFileSync('installables/folder-sync/desktop/Cargo.toml', 'utf8');
if (!desktopConfig.includes('icons = ["assets/icon.png"]')) fail('the desktop packager does not reference its icon');
if (!desktopConfig.includes('dest = "/usr/share/icons/hicolor/256x256/apps/gestalts-node.png"')) fail('the RPM does not install its icon');
const bridgeConfig = readFileSync('installables/claude-bridge/Cargo.toml', 'utf8');
if (!bridgeConfig.includes('icons = ["assets/icon.png"]')) fail('the Claude bridge packager does not reference its icon');
if (!bridgeConfig.includes('dest = "/usr/share/icons/hicolor/256x256/apps/gestalts-claude-bridge.png"')) fail('the Claude bridge RPM does not install its icon');
console.log('Web and desktop icons are present and wired into their builds.');
