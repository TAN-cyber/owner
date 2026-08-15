import { execFileSync, spawnSync } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import manifest from '../../assets/manifest.json';

const generatedRuntime = path.resolve(
  'assets',
  'skills',
  'owner',
  'scripts',
  'owner-entry-runtime.mjs',
);
const generatedHookRouter = path.resolve(
  'assets',
  'skills',
  'owner',
  'scripts',
  'owner-hook-router.mjs',
);
const builder = path.resolve('scripts', 'build', 'build-entry-runtime.mjs');

describe('Owner entry resolver runtime release asset', () => {
  let temporaryRoot: string;
  let skillOnlyRuntime: string;

  beforeEach(async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-entry-runtime-'));
    skillOnlyRuntime = path.join(
      temporaryRoot,
      'installed-skills',
      'owner',
      'scripts',
      'owner-entry-runtime.mjs',
    );
    await fs.mkdir(path.dirname(skillOnlyRuntime), { recursive: true });
    await fs.copyFile(generatedRuntime, skillOnlyRuntime);
  });

  afterEach(async () => {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  });

  function runSkillOnly(projectRoot: string) {
    return spawnSync(process.execPath, [skillOnlyRuntime, projectRoot, '--json'], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: { ...process.env, PATH: '' },
    });
  }

  it('publishes one fresh self-contained resolver without workflow execution logic', async () => {
    expect(manifest.skills).toContain('owner/scripts/owner-entry-runtime.mjs');
    const source = await fs.readFile(generatedRuntime, 'utf8');

    expect(source.startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(source).toContain('owner.workflow-resolution.v1');
    expect(source).not.toMatch(
      /openspec|superpowers|owner loop|owner state|owner guard|runLoopCli|runPipelineCli|pipeline-runtime|loop-runtime/iu,
    );
    execFileSync(process.execPath, [builder, '--check'], { stdio: 'pipe' });
  });

  it('publishes a fresh Hook Router that validates platform configuration', async () => {
    expect(manifest.skills).toContain('owner/scripts/owner-hook-router.mjs');
    const source = await fs.readFile(generatedHookRouter, 'utf8');
    expect(source.startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(source).toContain('owner.selection.v2');
    expect(source).toContain('Multiple active Owner changes');

    const unsupported = spawnSync(
      process.execPath,
      [generatedHookRouter, '--platform', 'unknown-platform'],
      { cwd: temporaryRoot, encoding: 'utf8' },
    );
    expect(unsupported.status).toBe(64);
    expect(unsupported.stderr).toContain('unsupported Hook platform');

    const outsideProject = spawnSync(
      process.execPath,
      [generatedHookRouter, '--platform', 'claude'],
      {
        cwd: temporaryRoot,
        encoding: 'utf8',
        env: { ...process.env, FILE_PATH: 'src/app.ts' },
      },
    );
    expect(outsideProject.status).toBe(0);
    expect(outsideProject.stdout).toBe('');
    expect(outsideProject.stderr).toBe('');
  });

  it('resolves Loop from project config with only the bundled Skill runtime available', async () => {
    const projectRoot = path.join(temporaryRoot, 'loop-project');
    await fs.mkdir(path.join(projectRoot, '.git'), { recursive: true });
    await fs.mkdir(path.join(projectRoot, '.owner'), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, '.owner', 'config.yaml'),
      [
        'schema: owner.project.v1',
        'default_workflow: loop',
        'loop:',
        '  artifact_root: docs',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = runSkillOnly(projectRoot);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      schema: 'owner.workflow-resolution.v1',
      workflow: 'loop',
      skill: 'owner-loop',
      source: 'project-config',
    });
  });

  it('fails closed when configuration is absent with only the bundled Skill runtime available', async () => {
    const projectRoot = path.join(temporaryRoot, 'pipeline-project');
    await fs.mkdir(path.join(projectRoot, '.git'), { recursive: true });

    const result = runSkillOnly(projectRoot);

    expect(result.status).toBe(65);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('.owner/config.yaml is missing');
  });

  it('fails closed on malformed config instead of falling back to Pipeline', async () => {
    const projectRoot = path.join(temporaryRoot, 'invalid-project');
    await fs.mkdir(path.join(projectRoot, '.git'), { recursive: true });
    await fs.mkdir(path.join(projectRoot, '.owner'), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, '.owner', 'config.yaml'),
      'schema: [broken\n',
      'utf8',
    );

    const result = runSkillOnly(projectRoot);

    expect(result.status).toBe(65);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/Invalid \.owner\/config\.yaml/iu);
    expect(result.stderr).not.toContain('legacy-fallback');
  });
});
