import { spawnSync } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLoopChange } from '../../domains/owner-loop/loop-change.js';
import { loopProjectPaths } from '../../domains/owner-loop/loop-paths.js';
import { ensureCliBuilt } from '../helpers/ensure-cli-built.js';
import { resolveProjectLanguage } from '../../app/commands/resume-probe.js';

const repositoryRoot = path.resolve('.');
const cli = path.join(repositoryRoot, 'bin', 'owner.js');
const stateScript = path.resolve('assets', 'skills', 'owner', 'scripts', 'owner-state.mjs');
const activeChange = 'resume-probe-change';

function pipelineProjectConfig(ambientResume = true): string {
  return [
    'schema: owner.project.v1',
    'default_workflow: pipeline',
    'workflows: [pipeline]',
    `ambient_resume: ${String(ambientResume)}`,
    'pipeline:',
    '  artifact_layout: legacy',
    '  language: en',
    '',
  ].join('\n');
}

function runCli(cwd: string, args: string[], input?: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    input,
  });
}

function state(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): void {
  const result = spawnSync(process.execPath, [stateScript, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    throw new Error(
      `owner-state command failed: ${result.status} ${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  }
}

function parseResult(stdout: string) {
  return JSON.parse(stdout) as {
    action: string;
    schema_version: string;
    workflow: string | null;
    skill: string | null;
    entrySource: string | null;
    changeName: string | null;
    phase: string | null;
    confidence: string;
    reason: string;
    nextCommand: string | null;
  };
}

describe('resumeProbe command', () => {
  let tmpDir: string;

  beforeAll(async () => {
    await ensureCliBuilt(repositoryRoot);
  }, 120_000);

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-resume-cli-'));
    await fs.mkdir(path.join(tmpDir, '.owner'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.owner', 'config.yaml'), pipelineProjectConfig(), 'utf8');
    await fs.mkdir(path.join(tmpDir, 'openspec'), { recursive: true });
    state(tmpDir, ['init', activeChange, 'full']);
    state(tmpDir, ['set', activeChange, 'build_mode', 'executing-plans']);
    state(tmpDir, ['set', activeChange, 'tdd_mode', 'direct']);
    state(tmpDir, ['set', activeChange, 'isolation', 'branch']);
    state(tmpDir, ['set', activeChange, 'verify_mode', 'light']);
    await fs.mkdir(path.join(tmpDir, 'docs'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'docs', 'plan.md'), 'plan: done\n', 'utf8');
    state(tmpDir, ['set', activeChange, 'plan', 'docs/plan.md']);
    state(tmpDir, ['set', activeChange, 'phase', 'build'], {
      OWNER_FORCE_PHASE: '1',
    });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns JSON using top-level CLI invocation and --utterance', () => {
    const result = runCli(tmpDir, ['resume-probe', tmpDir, '--utterance', '继续', '--json']);

    expect(result.status, result.stderr).toBe(0);
    expect(parseResult(result.stdout)).toMatchObject({
      schema_version: 'owner.resume_probe.v2',
      workflow: 'pipeline',
      skill: 'owner-pipeline',
      entrySource: 'project-config',
      action: 'auto_resume',
      nextCommand: '/owner-pipeline',
    });
  });

  it('does not treat the removed flat language field as the project locale', async () => {
    await fs.writeFile(
      path.join(tmpDir, '.owner', 'config.yaml'),
      'language: zh-CN\nambient_resume: true\n',
      'utf8',
    );

    await expect(resolveProjectLanguage(tmpDir)).resolves.toBe('unknown');
  });

  it('renders the resolved workflow and permanent entry in text mode', () => {
    const result = runCli(tmpDir, ['resume-probe', tmpDir, '--utterance', '继续']);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('workflow: pipeline');
    expect(result.stdout).toContain('skill: owner-pipeline');
    expect(result.stdout).toContain('next: /owner-pipeline');
  });

  it('honors ambient_resume: false in a legacy Pipeline project config', async () => {
    await fs.writeFile(
      path.join(tmpDir, '.owner', 'config.yaml'),
      pipelineProjectConfig(false),
      'utf8',
    );

    const result = runCli(tmpDir, ['resume-probe', tmpDir, '--utterance', '继续', '--json']);

    expect(result.status, result.stderr).toBe(0);
    expect(parseResult(result.stdout)).toMatchObject({
      workflow: null,
      skill: null,
      action: 'out_of_scope',
      reason: 'Ambient Resume is disabled by .owner/config.yaml',
      nextCommand: null,
    });
  });

  it('routes a configured Loop project without considering Pipeline changes', async () => {
    const initialized = runCli(tmpDir, ['loop', 'init', '--language', 'en']);
    expect(initialized.status, initialized.stderr).toBe(0);
    await createLoopChange({
      paths: await loopProjectPaths(tmpDir, 'docs'),
      name: 'loop-resume',
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });
    const changeDir = path.join(tmpDir, 'docs', 'owner', 'changes', 'loop-resume');
    await fs.writeFile(
      path.join(changeDir, 'brief.md'),
      [
        '# Outcome',
        'Resume Loop.',
        '# Scope',
        'One change.',
        '# Non-goals',
        'No Pipeline work.',
        '# Acceptance examples',
        '- Resume the selected change.',
        '# Constraints and invariants',
        'Keep workflows separate.',
        '# Decisions',
        'Use Loop.',
        '# Open questions',
        'None.',
        '# Verification expectations',
        'Run focused tests.',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = runCli(tmpDir, [
      'resume-probe',
      tmpDir,
      '--utterance',
      '继续 loop-resume',
      '--json',
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(parseResult(result.stdout)).toMatchObject({
      workflow: 'loop',
      skill: 'owner-loop',
      entrySource: 'project-config',
      action: 'auto_resume',
      changeName: 'loop-resume',
      nextCommand: '/owner-loop',
    });
  });

  it('uses stdin over --utterance when --stdin is set', () => {
    const fromUtterance = runCli(tmpDir, [
      'resume-probe',
      tmpDir,
      '--utterance',
      'what is this?',
      '--json',
    ]);
    const fromStdin = runCli(
      tmpDir,
      ['resume-probe', tmpDir, '--utterance', 'what is this?', '--stdin', '--json'],
      'continue',
    );

    expect(fromUtterance.status, fromUtterance.stderr).toBe(0);
    expect(fromStdin.status, fromStdin.stderr).toBe(0);
    expect(parseResult(fromUtterance.stdout).action).toBe('ask_user');
    expect(parseResult(fromStdin.stdout).action).toBe('auto_resume');
  });

  it('maps --no-workflow-work into an out-of-scope result', () => {
    const defaultResult = runCli(tmpDir, [
      'resume-probe',
      tmpDir,
      '--utterance',
      'what is this?',
      '--json',
    ]);
    const noNonTrivial = runCli(tmpDir, [
      'resume-probe',
      tmpDir,
      '--utterance',
      'what is this?',
      '--no-workflow-work',
      '--json',
    ]);

    expect(defaultResult.status, defaultResult.stderr).toBe(0);
    expect(noNonTrivial.status, noNonTrivial.stderr).toBe(0);
    expect(parseResult(defaultResult.stdout).action).toBe('ask_user');
    expect(parseResult(noNonTrivial.stdout).action).toBe('out_of_scope');
  });

  it('maps --already-in-owner-flow to out_of_scope', () => {
    const result = runCli(tmpDir, [
      'resume-probe',
      tmpDir,
      '--utterance',
      'continue',
      '--already-in-owner-flow',
      '--json',
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(parseResult(result.stdout).action).toBe('out_of_scope');
  });
});
