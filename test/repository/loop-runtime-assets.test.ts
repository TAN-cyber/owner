import { execFileSync, spawnSync } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import manifest from '../../assets/manifest.json';

const runtime = path.resolve('assets', 'skills', 'owner-loop', 'scripts', 'owner-loop-runtime.mjs');
const builder = path.resolve('scripts', 'build', 'build-loop-runtime.mjs');

async function writeRuntimeWithRetry(contents: Buffer): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.writeFile(runtime, contents);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'UNKNOWN' && code !== 'EPERM') throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  throw lastError;
}

describe('Loop runtime release asset', () => {
  it('publishes the Loop Skill, references, and runtime from the manifest', () => {
    for (const relative of [
      'owner-loop/SKILL.md',
      'owner-loop/reference/artifacts.md',
      'owner-loop/reference/clarification.md',
      'owner-loop/reference/commands.md',
      'owner-loop/reference/recovery.md',
      'owner-loop/reference/workspace.md',
      'owner-loop/scripts/owner-loop-runtime.mjs',
      'owner-loop/scripts/owner-loop-hook-guard.mjs',
    ]) {
      expect(manifest.skills).toContain(relative);
    }
  });

  it('ships one fresh self-contained Node runtime', async () => {
    const source = await fs.readFile(runtime, 'utf8');

    expect(source.startsWith('#!/usr/bin/env node\n')).toBe(true);
    for (const command of [
      'init',
      'hook-guard',
      'root',
      'new',
      'list',
      'show',
      'status',
      'select',
      'next',
      'archive',
      'doctor',
    ]) {
      expect(source).toContain(command);
    }
    expect(source).not.toMatch(/domains\/owner-pipeline|openspec|superpowers|requiredSkillCalls/iu);
    expect(source).not.toMatch(/PIPELINE_RUN_STORAGE/u);
    expect(source).toContain('.owner/config.yaml');
    expect(source).toContain('Hook write target was not attributed to the guarded project');
    expect(source).not.toContain('owner.loop.controller-trust-store.v1');
    expect(source).not.toContain('owner.loop.creation-authorization.v1');
    expect(source).not.toContain('owner.loop.review-trust-policy.v2');
    expect(source).not.toContain('implementation-attestation');
    expect(source).not.toContain('independent-review');
    expect(source).not.toContain('waiver-receipt');
    expect(source).not.toContain('trust authorize');
    expect(source).toContain('new <change-name> [--language en|zh-CN]');
    const help = execFileSync(process.execPath, [runtime, '--help'], { encoding: 'utf8' });
    expect(help).toContain('skill-coordinated steps');
    expect(help).not.toMatch(/checkpoint|receipt|evidence|preflight|sha256|--result|--report/iu);
    execFileSync(process.execPath, [builder, '--check'], { stdio: 'pipe' });
  });

  it('ships one self-contained bundle per command launcher', async () => {
    const scriptsDir = path.resolve('assets', 'skills', 'owner-loop', 'scripts');
    // Each per-command launcher must be a self-contained esbuild bundle: it
    // starts with the Node shebang and never re-imports the shared runtime,
    // so loading e.g. the hook-guard launcher only evaluates that command's
    // dependency graph.
    const commandScripts = [
      'owner-loop-hook-guard.mjs',
      'owner-loop-init.mjs',
      'owner-loop-root.mjs',
      'owner-loop-new.mjs',
      'owner-loop-spec.mjs',
      'owner-loop-show.mjs',
      'owner-loop-status.mjs',
      'owner-loop-select.mjs',
      'owner-loop-next.mjs',
      'owner-loop-archive.mjs',
      'owner-loop-doctor.mjs',
    ];
    for (const script of commandScripts) {
      const source = await fs.readFile(path.join(scriptsDir, script), 'utf8');
      expect(source.startsWith('#!/usr/bin/env node\n')).toBe(true);
      expect(source).not.toMatch(/from\s+['"]\.\/owner-loop-runtime\.mjs['"]/u);
    }
    for (const retired of [
      'owner-loop-checkpoint.mjs',
      'owner-loop-check.mjs',
      'owner-loop-evidence.mjs',
      'owner-loop-receipt.mjs',
    ]) {
      expect(manifest.skills).not.toContain(`owner-loop/scripts/${retired}`);
      await expect(fs.access(path.join(scriptsDir, retired))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
    execFileSync(process.execPath, [builder, '--check'], { stdio: 'pipe' });
  });

  it('keeps command syntax and defaults in CLI help instead of Skill references', async () => {
    const help = await fs.readFile(
      path.resolve('domains', 'owner-loop', 'loop-cli-help.ts'),
      'utf8',
    );
    const english = await fs.readFile(
      path.resolve('assets', 'skills', 'owner-loop', 'reference', 'commands.md'),
      'utf8',
    );
    const chinese = await fs.readFile(
      path.resolve('assets', 'skills-zh', 'owner-loop', 'reference', 'commands.md'),
      'utf8',
    );

    expect(help).toContain('owner loop new <change-name> [--language en|zh-CN]');
    expect(help).toContain('defaults to docs');
    for (const reference of [english, chinese]) {
      expect(reference).toContain('owner loop <command> --help');
      expect(reference).not.toContain('owner loop new <change-name> [--language en|zh-CN]');
    }
  });

  it('detects a stale generated runtime', async () => {
    const original = await fs.readFile(runtime);
    try {
      await writeRuntimeWithRetry(Buffer.concat([original, Buffer.from('\n// stale fixture\n')]));
      const result = spawnSync(process.execPath, [builder, '--check'], { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Loop runtime script is stale');
    } finally {
      await writeRuntimeWithRetry(original);
    }
  });
});
