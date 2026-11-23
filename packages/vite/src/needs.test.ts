import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pluginNeedsProblems, readPlugin } from './index';

const plugins = join(import.meta.dirname, '../../../plugins');

describe("every plugin's plugin.yml", () => {
  it('declares what the kit and learning parts its view uses read and write', () => {
    const problems = readdirSync(plugins, { withFileTypes: true }).filter((e) => e.isDirectory()).flatMap((e) => {
      const { manifest, compiled } = readPlugin(join(plugins, e.name));
      if (!compiled.ok) return [`${e.name}: ${compiled.errors.map((x) => x.message).join('; ')}`];
      return pluginNeedsProblems(manifest, compiled).map((p) => `${e.name}: ${p}`);
    });
    expect(problems).toEqual([]);
  });
});
