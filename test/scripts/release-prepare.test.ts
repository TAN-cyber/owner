import { spawnSync } from 'child_process';
import path from 'path';
import { describe, expect, it } from 'vitest';

const prepareScript = path.resolve('scripts/release/prepare.js');

describe('release prepare script', () => {
  it('skips prepare work during npm publish because prepublishOnly already builds', () => {
    const result = spawnSync(process.execPath, [prepareScript], {
      encoding: 'utf-8',
      env: { ...process.env, npm_command: 'publish', NPM_COMMAND: 'publish' },
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('skipped during npm publish');
  });
});
