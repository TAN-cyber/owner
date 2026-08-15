import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import { spawnSync } from 'child_process';
import os from 'os';
import path from 'path';
import { preparePipelineLegacyProject } from '../../helpers/pipeline-project.js';

const sourceScripts = path.resolve('assets', 'skills', 'owner', 'scripts');

describe('Skill Engine schema compatibility', () => {
  let root: string;
  let stateScript: string;
  let validateScript: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-engine-'));
    await preparePipelineLegacyProject(root);
    await fs.mkdir(path.join(root, 'assets'), { recursive: true });
    for (const name of [
      'owner-runtime.mjs',
      'owner-state.mjs',
      'owner-yaml-validate.mjs',
      'owner-guard.mjs',
      'owner-handoff.mjs',
      'owner-archive.mjs',
      'owner-env.mjs',
    ]) {
      await fs.copyFile(path.join(sourceScripts, name), path.join(root, 'assets', name));
    }
    stateScript = path.join(root, 'assets', 'owner-state.mjs');
    validateScript = path.join(root, 'assets', 'owner-yaml-validate.mjs');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function run(script: string, args: string[]) {
    return spawnSync(process.execPath, [script, ...args], {
      cwd: root,
      encoding: 'utf8',
    });
  }

  it('validates every Pipeline projection field written as the engine would', async () => {
    expect(run(stateScript, ['init', 'demo', 'full']).status).toBe(0);
    const result = run(validateScript, ['demo']);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('unknown field');
  }, 30_000);

  async function setYamlField(field: string, value: string): Promise<void> {
    const yamlPath = path.join(root, 'openspec', 'changes', 'demo', '.owner.yaml');
    const raw = await fs.readFile(yamlPath, 'utf8');
    await fs.writeFile(
      yamlPath,
      raw.replace(new RegExp(`^${field}:.*$`, 'mu'), `${field}: ${value}`),
    );
  }

  it.each([
    ['workflow', 'freeform'],
    ['phase', 'bad'],
    ['verify_result', 'maybe'],
  ])('rejects invalid %s=%s', async (field, value) => {
    expect(run(stateScript, ['init', 'demo', 'full']).status).toBe(0);
    await setYamlField(field, value);
    const result = run(validateScript, ['demo']);
    expect(result.status).not.toBe(0);
  });
});
