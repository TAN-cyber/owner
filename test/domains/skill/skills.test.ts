import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { parse } from 'yaml';

import {
  copyOwnerRulesForPlatform,
  copyOwnerSkillsForPlatform,
  createWorkingDirs,
  detectInstalledWorkflowSelection,
  getAssetsDir,
  getManagedSkillPathsForSelection,
  installOwnerHooksForPlatform,
  mergeProjectConfig,
  readManifest,
} from '../../../domains/skill/platform-install.js';
import { PLATFORMS } from '../../../platform/install/platforms.js';

describe('Owner Skill distribution', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-skills-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('ships only the Loop, Pipeline, shared entry, and Pipeline phase Skills', async () => {
    expect(path.basename(getAssetsDir())).toBe('assets');
    const manifest = await readManifest();
    const skillNames = manifest.skills.flatMap((relativePath) => {
      const match = /^([^/]+)\/SKILL\.md$/u.exec(relativePath);
      return match?.[1] ? [match[1]] : [];
    });

    expect(skillNames).toEqual([
      'owner',
      'owner-pipeline',
      'owner-loop',
      'owner-open',
      'owner-design',
      'owner-build',
      'owner-verify',
      'owner-archive',
      'owner-hotfix',
      'owner-tweak',
    ]);
    expect(JSON.stringify(manifest)).not.toMatch(
      /owner-any|dashboard|codegraph|factory|bundle|creator|publish/iu,
    );
  });

  it('selects exactly the files required by each workflow', async () => {
    const manifest = await readManifest();
    const loop = getManagedSkillPathsForSelection(manifest, 'loop');
    const pipeline = getManagedSkillPathsForSelection(manifest, 'pipeline');
    const both = getManagedSkillPathsForSelection(manifest, 'both');

    expect(loop).toContain('owner/SKILL.md');
    expect(loop).toContain('owner-loop/SKILL.md');
    expect(loop).not.toContain('owner-pipeline/SKILL.md');
    expect(pipeline).toContain('owner/SKILL.md');
    expect(pipeline).toContain('owner-pipeline/SKILL.md');
    expect(pipeline).not.toContain('owner-loop/SKILL.md');
    expect(new Set(both)).toEqual(new Set([...loop, ...pipeline]));
  });

  it.each(PLATFORMS)('copies both workflows to $name', async (platform) => {
    const result = await copyOwnerSkillsForPlatform(
      tmpDir,
      platform,
      false,
      'skills',
      'project',
      'copy',
      'both',
    );
    const skillsRoot = path.join(tmpDir, platform.skillsDir, 'skills');

    expect(result.failed).toBe(0);
    expect(result.copied).toBeGreaterThan(0);
    await expect(fs.access(path.join(skillsRoot, 'owner', 'SKILL.md'))).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(skillsRoot, 'owner-loop', 'SKILL.md')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(skillsRoot, 'owner-pipeline', 'SKILL.md')),
    ).resolves.toBeUndefined();
    await expect(detectInstalledWorkflowSelection(skillsRoot)).resolves.toBe('both');
  });

  it('copies the Chinese Loop workflow without adding Pipeline', async () => {
    const claude = PLATFORMS.find((platform) => platform.id === 'claude')!;
    const result = await copyOwnerSkillsForPlatform(
      tmpDir,
      claude,
      false,
      'skills-zh',
      'project',
      'copy',
      'loop',
    );
    const skillsRoot = path.join(tmpDir, '.claude', 'skills');

    expect(result.failed).toBe(0);
    await expect(
      fs.readFile(path.join(skillsRoot, 'owner-loop', 'SKILL.md'), 'utf8'),
    ).resolves.toContain('Loop');
    await expect(
      fs.access(path.join(skillsRoot, 'owner-pipeline', 'SKILL.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(detectInstalledWorkflowSelection(skillsRoot)).resolves.toBe('loop');
  });

  it.each(PLATFORMS)('installs one plain Markdown workflow Rule for $name', async (platform) => {
    await expect(
      copyOwnerRulesForPlatform(tmpDir, platform, true, 'en', 'project', 'both'),
    ).resolves.toEqual({ copied: 1, skipped: 0, failed: 0 });

    const rulesBase = platform.rulesBaseDir
      ? path.join(tmpDir, platform.rulesBaseDir)
      : path.join(tmpDir, platform.skillsDir);
    await expect(
      fs.access(path.join(rulesBase, 'rules', 'owner-workflow-guard.md')),
    ).resolves.toBeUndefined();
  });

  it.each(PLATFORMS)('installs an idempotent project Router Hook for $name', async (platform) => {
    await expect(installOwnerHooksForPlatform(tmpDir, platform, 'project')).resolves.toEqual({
      status: 'installed',
    });
    await expect(installOwnerHooksForPlatform(tmpDir, platform, 'project')).resolves.toEqual({
      status: 'installed',
    });

    const configDir = platform.configDir ?? platform.skillsDir;
    const configFile = platform.hookConfigFile ?? 'settings.local.json';
    const config = JSON.parse(await fs.readFile(path.join(tmpDir, configDir, configFile), 'utf8'));
    const managedHooks = config.hooks.PreToolUse.flatMap(
      (group: { hooks?: Array<{ command?: string }> }) => group.hooks ?? [],
    ).filter((hook: { command?: string }) => hook.command?.includes('owner-hook-router.mjs'));

    expect(managedHooks).toHaveLength(1);
    expect(managedHooks[0].command).toContain(`--platform "${platform.id}"`);
  });

  it('keeps blocking Hooks project-scoped', async () => {
    for (const platform of PLATFORMS) {
      await expect(installOwnerHooksForPlatform(tmpDir, platform, 'global')).resolves.toEqual({
        status: 'skipped',
        reason: 'blocking Hooks are project-scoped',
      });
    }
  });

  it('creates Pipeline artifact directories without activating a workflow', async () => {
    await createWorkingDirs(tmpDir);

    await expect(
      fs.access(path.join(tmpDir, 'docs', 'openspec', 'changes')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(tmpDir, 'docs', 'superpowers', 'specs')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(tmpDir, 'docs', 'superpowers', 'plans')),
    ).resolves.toBeUndefined();
    await expect(fs.access(path.join(tmpDir, '.owner', 'config.yaml'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('merges a dual-workflow project config without losing extension fields', async () => {
    const configDir = path.join(tmpDir, '.owner');
    const configPath = path.join(configDir, 'config.yaml');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      configPath,
      [
        'schema: owner.project.v1',
        'default_workflow: loop',
        'workflows: [loop, pipeline]',
        'loop:',
        '  artifact_root: docs',
        '  language: en',
        'pipeline:',
        '  artifact_layout: docs',
        '  language: en',
        'custom_extension: keep',
        '',
      ].join('\n'),
      'utf8',
    );

    await mergeProjectConfig(tmpDir, 'zh-CN', 'docs', true, true);
    const config = parse(await fs.readFile(configPath, 'utf8'));

    expect(config).toMatchObject({
      default_workflow: 'loop',
      workflows: ['loop', 'pipeline'],
      loop: { artifact_root: 'docs', language: 'en' },
      pipeline: { artifact_layout: 'docs', language: 'zh-CN' },
      custom_extension: 'keep',
    });
  });
});
