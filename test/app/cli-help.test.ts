import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureCliBuilt } from '../helpers/ensure-cli-built.js';

const repositoryRoot = path.resolve('.');
const cli = path.join(repositoryRoot, 'bin', 'owner.js');

function runCli(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
}

describe('CLI help text', () => {
  beforeAll(async () => {
    await ensureCliBuilt(repositoryRoot);
  }, 120_000);

  it('uses the Owner workflow tagline and fixed package version', () => {
    const help = runCli('--help');
    const packageJson = JSON.parse(
      readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
    ) as { description: string; version: string };
    const tagline = 'Resumable Loop and Pipeline vibe coding for Claude Code and Codex';

    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain(tagline);
    expect(packageJson.description).toBe(tagline);
    expect(packageJson.version).toBe('0.1.1');
  });

  it('exposes only lifecycle, Loop, and Pipeline command surfaces', () => {
    const help = runCli('--help');

    expect(help.status, help.stderr).toBe(0);
    for (const command of [
      'init',
      'status',
      'workflow',
      'resume-probe',
      'doctor',
      'update',
      'uninstall',
      'loop',
      'pipeline',
      'state',
      'guard',
      'handoff',
      'archive',
    ]) {
      expect(help.stdout).toMatch(new RegExp(`^\\s+${command}\\b`, 'mu'));
    }
  });

  it.each(['eval', 'dashboard', 'skill', 'creator', 'publish', 'bundle'])(
    'rejects the removed %s command',
    (command) => {
      const result = runCli(command);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`unknown command '${command}'`);
    },
  );

  it('exposes only the four stable Pipeline facade commands at the root', () => {
    const help = runCli('--help');

    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('Read and update Pipeline workflow state');
    expect(help.stdout).toContain('Check Pipeline workflow phase guards');
    expect(help.stdout).toContain('Create and inspect Pipeline workflow handoffs');
    expect(help.stdout).toContain('Archive completed Pipeline workflow changes');
    expect(help.stdout).not.toMatch(/^\s+(validate|intent|hook-guard)\b/mu);
  });

  it('documents the layout-aware Pipeline command group', () => {
    const help = runCli('pipeline', '--help');

    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('Usage: owner pipeline <command> [args]');
    expect(help.stdout).toContain('openspec -- <openspec-args...>');
    expect(help.stdout).toContain('root move docs --dry-run');
    expect(help.stdout).toContain('root move docs --apply');
  });

  it('keeps Loop behind one isolated root command', () => {
    const rootHelp = runCli('--help');
    const loopHelp = runCli('loop', '--help');

    expect(rootHelp.status, rootHelp.stderr).toBe(0);
    expect(loopHelp.status, loopHelp.stderr).toBe(0);
    expect(rootHelp.stdout).toMatch(/^\s+loop \[args\.\.\.\]\s+Manage the self-contained/mu);
    expect(loopHelp.stdout).toContain('Usage: owner loop <command> [options]');
    expect(loopHelp.stdout).toContain('root move <artifact-root>');
    expect(loopHelp.stdout).toContain('doctor [<change-name>]');
  });

  it('exposes Claude/Codex target controls without removed integration flags', () => {
    const initHelp = runCli('init', '--help');
    const updateHelp = runCli('update', '--help');
    const doctorHelp = runCli('doctor', '--help');

    expect(initHelp.status, initHelp.stderr).toBe(0);
    expect(updateHelp.status, updateHelp.stderr).toBe(0);
    expect(doctorHelp.status, doctorHelp.stderr).toBe(0);
    expect(initHelp.stdout).toContain('--platform <platform>');
    expect(initHelp.stdout).not.toContain('codegraph');
    expect(updateHelp.stdout).toContain('--self-update');
    expect(updateHelp.stdout).toContain('--skip-self-update');
    expect(updateHelp.stdout).not.toContain('codegraph');
    expect(doctorHelp.stdout).not.toContain('CodeGraph');
  });

  it('documents ambient resume probe controls', () => {
    const help = runCli('resume-probe', '--help');

    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('--utterance');
    expect(help.stdout).toContain('--stdin');
    expect(help.stdout).toContain('--json');
    expect(help.stdout).toContain('--no-workflow-work');
    expect(help.stdout).toContain('--already-in-owner-flow');
  });
});
