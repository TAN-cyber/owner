import { spawnSync } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
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

  it('skips Husky setup during a global Git dependency install', async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-prepare-test-'));
    await fs.writeFile(
      path.join(fixtureRoot, 'build.js'),
      "process.stdout.write('[FIXTURE] build completed.\\n');\n",
      'utf8',
    );

    const result = spawnSync(process.execPath, [prepareScript], {
      cwd: fixtureRoot,
      encoding: 'utf-8',
      env: { ...process.env, npm_config_global: 'true' },
    });
    await fs.rm(fixtureRoot, { recursive: true, force: true });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('skipped Husky setup (global install)');
    expect(result.stdout).toContain('[FIXTURE] build completed.');
  });
});
