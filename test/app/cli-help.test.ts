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
    const tagline = 'Resumable Native and Classic vibe coding for Claude Code and Codex';

    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain(tagline);
    expect(packageJson.description).toBe(tagline);
    expect(packageJson.version).toBe('0.1.0');
  });

  it('exposes only lifecycle, Native, and Classic command surfaces', () => {
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
      'native',
      'classic',
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

  it('exposes only the four stable Classic facade commands at the root', () => {
    const help = runCli('--help');

    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('Read and update Classic workflow state');
    expect(help.stdout).toContain('Check Classic workflow phase guards');
    expect(help.stdout).toContain('Create and inspect Classic workflow handoffs');
    expect(help.stdout).toContain('Archive completed Classic workflow changes');
    expect(help.stdout).not.toMatch(/^\s+(validate|intent|hook-guard)\b/mu);
  });

  it('documents the layout-aware Classic command group', () => {
    const help = runCli('classic', '--help');

    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('Usage: owner classic <command> [args]');
    expect(help.stdout).toContain('openspec -- <openspec-args...>');
    expect(help.stdout).toContain('root move docs --dry-run');
    expect(help.stdout).toContain('root move docs --apply');
  });

  it('keeps Native behind one isolated root command', () => {
    const rootHelp = runCli('--help');
    const nativeHelp = runCli('native', '--help');

    expect(rootHelp.status, rootHelp.stderr).toBe(0);
    expect(nativeHelp.status, nativeHelp.stderr).toBe(0);
    expect(rootHelp.stdout).toMatch(/^\s+native \[args\.\.\.\]\s+Manage the self-contained/mu);
    expect(nativeHelp.stdout).toContain('Usage: owner native <command> [options]');
    expect(nativeHelp.stdout).toContain('root move <artifact-root>');
    expect(nativeHelp.stdout).toContain('doctor [<change-name>]');
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
