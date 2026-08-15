import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  createSkillSnapshot,
  hashSkillPackage,
  readSkillSnapshot,
} from '../../../domains/skill/snapshot.js';
import type { SkillPackage } from '../../../domains/skill/types.js';

const pkg = (root: string): SkillPackage => ({
  root,
  definition: {
    apiVersion: 'owner/v1alpha1',
    kind: 'Skill',
    metadata: { name: 'demo', version: '1', description: 'Demo' },
    goal: { statement: 'Done', inputs: [], outputs: [], success: ['done'] },
    orchestration: { mode: 'adaptive' },
    skills: [],
    agents: [],
    tools: [],
  },
  guardrails: {
    allowedSkills: [],
    allowedAgents: [],
    allowedTools: [],
    maxIterations: 5,
    maxRetriesPerAction: 1,
    confirmationRequiredFor: [],
  },
  evals: [],
});

const runtimePkg = (root: string): SkillPackage => ({
  ...pkg(root),
  packageKind: 'runtime',
});

function withScriptTool(root: string): SkillPackage {
  const value = pkg(root);
  value.definition.tools.push({
    id: 'build',
    kind: 'script',
    source: 'scripts/build.sh',
    sideEffect: 'write',
  });
  value.guardrails.allowedTools.push('build');
  return value;
}

describe('Skill snapshots', () => {
  let root: string;
  let changeDir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-snapshot-'));
    changeDir = path.join(root, 'change');
    await fs.mkdir(path.join(root, 'skill'), { recursive: true });
    await fs.writeFile(path.join(root, 'skill', 'SKILL.md'), '# Demo\n');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('is stable across object key order', async () => {
    const first = pkg(path.join(root, 'skill'));
    const second = structuredClone(first);
    second.guardrails = {
      maxRetriesPerAction: 1,
      maxIterations: 5,
      allowedTools: [],
      allowedSkills: [],
      allowedAgents: [],
      confirmationRequiredFor: [],
    };
    expect(await hashSkillPackage(first)).toBe(await hashSkillPackage(second));
  });

  it('includes SKILL.md content in the package hash', async () => {
    const value = pkg(path.join(root, 'skill'));
    const before = await hashSkillPackage(value);

    await fs.writeFile(path.join(value.root, 'SKILL.md'), '# Changed\n');

    expect(await hashSkillPackage(value)).not.toBe(before);
  });

  it('includes declared script Tool content in the package hash', async () => {
    const value = withScriptTool(path.join(root, 'skill'));
    await fs.mkdir(path.join(value.root, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(value.root, 'scripts', 'build.sh'), 'echo first\n');
    const before = await hashSkillPackage(value);

    await fs.writeFile(path.join(value.root, 'scripts', 'build.sh'), 'echo second\n');

    expect(await hashSkillPackage(value)).not.toBe(before);
  });

  it('writes a self-contained normalized snapshot', async () => {
    const value = withScriptTool(path.join(root, 'skill'));
    await fs.mkdir(path.join(value.root, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(value.root, 'scripts', 'build.sh'), 'echo build\n');

    const result = await createSkillSnapshot(value, changeDir);

    expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
    await expect(fs.access(path.join(result.snapshotDir, 'package.json'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(result.snapshotDir, 'SKILL.md'))).resolves.toBeUndefined();
    await expect(
      fs.readFile(path.join(result.snapshotDir, 'scripts', 'build.sh'), 'utf8'),
    ).resolves.toBe('echo build\n');
  });

  it('keeps published snapshots immutable when the source Skill changes', async () => {
    const value = pkg(path.join(root, 'skill'));
    const first = await createSkillSnapshot(value, changeDir);

    await fs.writeFile(path.join(value.root, 'SKILL.md'), '# Changed\n');
    const second = await createSkillSnapshot(value, changeDir);

    expect(second.hash).not.toBe(first.hash);
    expect(second.snapshotDir).not.toBe(first.snapshotDir);
    await expect(fs.readFile(path.join(first.snapshotDir, 'SKILL.md'), 'utf8')).resolves.toBe(
      '# Demo\n',
    );
    await expect(fs.readFile(path.join(second.snapshotDir, 'SKILL.md'), 'utf8')).resolves.toBe(
      '# Changed\n',
    );
  });

  it('rejects an existing snapshot whose content no longer matches its hash', async () => {
    const value = pkg(path.join(root, 'skill'));
    const result = await createSkillSnapshot(value, changeDir);
    await fs.writeFile(path.join(result.snapshotDir, 'SKILL.md'), '# Corrupt\n');

    await expect(createSkillSnapshot(value, changeDir)).rejects.toThrow(
      `Existing Skill snapshot is invalid: ${result.hash}`,
    );
  });

  it('rejects missing declared script Tool sources', async () => {
    const value = withScriptTool(path.join(root, 'skill'));

    await expect(createSkillSnapshot(value, changeDir)).rejects.toThrow(
      'Script tool build does not exist: scripts/build.sh',
    );
  });

  it('rejects directories used as script Tool sources', async () => {
    const value = withScriptTool(path.join(root, 'skill'));
    await fs.mkdir(path.join(value.root, 'scripts', 'build.sh'), { recursive: true });

    await expect(createSkillSnapshot(value, changeDir)).rejects.toThrow(
      'Script tool build is not a file: scripts/build.sh',
    );
  });

  it('rejects script Tool symlinks that escape the Skill package', async () => {
    const value = withScriptTool(path.join(root, 'skill'));
    const outside = path.join(root, 'outside');
    const scripts = path.join(value.root, 'scripts');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'build.sh'), 'echo outside\n');
    await fs.symlink(outside, scripts, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(createSkillSnapshot(value, changeDir)).rejects.toThrow(
      'Script tool build resolves outside the Skill package',
    );
  });

  it('snapshots YAML-only runtime packages without SKILL.md', async () => {
    const runtimeRoot = path.join(root, 'runtime-pipeline');
    await fs.mkdir(runtimeRoot, { recursive: true });
    const value = runtimePkg(runtimeRoot);

    const snapshot = await createSkillSnapshot(value, changeDir);

    expect(snapshot.hash).toMatch(/^[a-f0-9]{64}$/);
    await expect(fs.access(path.join(snapshot.snapshotDir, 'SKILL.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const document = JSON.parse(
      await fs.readFile(path.join(snapshot.snapshotDir, 'package.json'), 'utf8'),
    );
    expect(document.packageKind).toBe('runtime');
  });

  it('restores runtime package snapshots without requiring SKILL.md', async () => {
    const runtimeRoot = path.join(root, 'runtime-restore');
    await fs.mkdir(runtimeRoot, { recursive: true });
    const value = runtimePkg(runtimeRoot);
    const snapshot = await createSkillSnapshot(value, changeDir);

    const restored = await readSkillSnapshot(changeDir, snapshot.hash);

    expect(restored.packageKind).toBe('runtime');
    expect(restored.definition.metadata.name).toBe(value.definition.metadata.name);
    await expect(fs.access(path.join(restored.root, 'SKILL.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('still rejects ordinary Skill snapshots when SKILL.md is missing', async () => {
    const value = pkg(path.join(root, 'skill'));
    await fs.rm(path.join(value.root, 'SKILL.md'));

    await expect(createSkillSnapshot(value, changeDir)).rejects.toThrow(
      'SKILL.md does not exist: SKILL.md',
    );
  });

  it('restores a SkillPackage from an immutable snapshot', async () => {
    const value = withScriptTool(path.join(root, 'skill'));
    await fs.mkdir(path.join(value.root, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(value.root, 'scripts', 'build.sh'), 'echo build\n');
    const snapshot = await createSkillSnapshot(value, changeDir);

    await fs.writeFile(path.join(value.root, 'SKILL.md'), '# Source changed\n');
    const restored = await readSkillSnapshot(changeDir, snapshot.hash);

    expect(restored.definition).toEqual(value.definition);
    expect(restored.root).toBe(snapshot.snapshotDir);
    await expect(fs.readFile(path.join(restored.root, 'SKILL.md'), 'utf8')).resolves.toBe(
      '# Demo\n',
    );
  });

  it('rejects a snapshot with a modified package document', async () => {
    const value = pkg(path.join(root, 'skill'));
    const snapshot = await createSkillSnapshot(value, changeDir);
    const packagePath = path.join(snapshot.snapshotDir, 'package.json');
    const document = JSON.parse(await fs.readFile(packagePath, 'utf8'));
    document.definition.metadata.version = '2';
    await fs.writeFile(packagePath, JSON.stringify(document, null, 2) + '\n');

    await expect(readSkillSnapshot(changeDir, snapshot.hash)).rejects.toThrow(
      `Skill snapshot is invalid or missing: ${snapshot.hash}`,
    );
  });
});
