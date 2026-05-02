import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixturesDir = join(repoRoot, 'tests/fixtures/two_sum');

describe('e2e reference harness (two_sum unittest)', () => {
  it('passes python3 -m unittest discover with sane wall-clock', () => {
    const started = Date.now();
    const result = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', fixturesDir, '-p', 'test_*.py', '-v'], {
      cwd: repoRoot,
      encoding: 'utf-8'
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const combinedOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    expect(combinedOutput).toMatch(/\bOK\b/);
    expect(Date.now() - started).toBeLessThan(15_000);
  });
});
