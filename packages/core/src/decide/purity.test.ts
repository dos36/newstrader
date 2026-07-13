import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The engine is money-path pure: no I/O, no clock, no randomness — every
 * input arrives as a parameter so decisions replay bit-for-bit from stored
 * snapshots. This suite enforces that structurally on the SOURCE files
 * (test files are exempt — they may use node modules to verify the sources).
 */

const decideDir = dirname(fileURLToPath(import.meta.url));

const sourceFiles = async (): Promise<string[]> => {
  const entries = await readdir(decideDir);
  return entries.filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
};

describe('decide/ purity', () => {
  it('contains the expected engine modules', async () => {
    expect((await sourceFiles()).sort()).toEqual([
      'decide.ts',
      'decimal.ts',
      'default-rules.ts',
      'exit-rules.ts',
      'index.ts',
      'intent.ts',
      'sha256.ts',
      'sizing.ts',
    ]);
  });

  it('no module imports node: builtins, the db package, or any package at all beyond contracts', async () => {
    for (const file of await sourceFiles()) {
      const source = await readFile(join(decideDir, file), 'utf8');
      const importSpecifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] ?? '');
      for (const specifier of importSpecifiers) {
        expect(specifier, `${file} imports "${specifier}"`).not.toMatch(/^node:/);
        expect(specifier, `${file} imports "${specifier}"`).not.toMatch(/@newstrader\/db/);
        // Only relative imports (contracts + siblings) are allowed — no
        // bare-package imports of any kind on the decision path.
        expect(
          specifier.startsWith('./') || specifier.startsWith('../'),
          `${file} imports non-relative "${specifier}"`,
        ).toBe(true);
      }
      expect(source, `${file} uses require()`).not.toMatch(/\brequire\s*\(/);
    }
  });

  it('no module reads a clock or randomness', async () => {
    for (const file of await sourceFiles()) {
      const source = await readFile(join(decideDir, file), 'utf8');
      expect(source, `${file} calls Date.now`).not.toMatch(/Date\.now/);
      expect(source, `${file} constructs new Date()`).not.toMatch(/new Date\(/);
      expect(source, `${file} uses Math.random`).not.toMatch(/Math\.random/);
      expect(source, `${file} uses performance.now`).not.toMatch(/performance\.now/);
    }
  });
});
