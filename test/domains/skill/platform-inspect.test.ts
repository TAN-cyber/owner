import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SUPPORTED_PLATFORMS } from '../../../platform/install/platforms.js';
import {
  copyOwnerSkillsForPlatform,
  installOwnerHooksForPlatform,
} from '../../../domains/skill/platform-install.js';
import {
  getPlatformRuleDestinations,
  inspectOwnerHooksForPlatform,
} from '../../../domains/skill/platform-inspect.js';

describe('Claude Code and Codex platform inspection', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-platform-inspect-'));
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it.each(SUPPORTED_PLATFORMS)('resolves markdown Rule paths for $name', async (platform) => {
    const destinations = await getPlatformRuleDestinations(projectRoot, platform, 'project');

    expect(destinations).toContain(
      path.join(
        projectRoot,
        platform.rulesBaseDir ?? platform.skillsDir,
        'rules',
        'owner-workflow-guard.md',
      ),
    );
  });

  it.each(SUPPORTED_PLATFORMS)('recognizes one installed Router for $name', async (platform) => {
    await copyOwnerSkillsForPlatform(projectRoot, platform, true, 'skills', 'project');
    await expect(installOwnerHooksForPlatform(projectRoot, platform, 'project')).resolves.toEqual({
      status: 'installed',
    });

    await expect(inspectOwnerHooksForPlatform(projectRoot, platform, 'project')).resolves.toEqual({
      present: true,
    });
  });

  it('rejects malformed Claude Code Hook JSON without rewriting it', async () => {
    const claude = SUPPORTED_PLATFORMS.find(({ id }) => id === 'claude')!;
    const settingsPath = path.join(projectRoot, '.claude', 'settings.local.json');
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, '{invalid', 'utf8');

    const result = await inspectOwnerHooksForPlatform(projectRoot, claude, 'project');

    expect(result).toMatchObject({ present: false, error: expect.any(String) });
    await expect(fs.readFile(settingsPath, 'utf8')).resolves.toBe('{invalid');
  });

  it('reports a missing manifest-owned Hook script', async () => {
    const claude = SUPPORTED_PLATFORMS.find(({ id }) => id === 'claude')!;
    await installOwnerHooksForPlatform(projectRoot, claude, 'project');

    await expect(
      inspectOwnerHooksForPlatform(projectRoot, claude, 'project'),
    ).resolves.toMatchObject({
      present: false,
      managedPresent: true,
      error: expect.stringContaining('managed Hook script missing'),
    });
  });

  it('detects a managed Codex Router left in the legacy settings file', async () => {
    const codex = SUPPORTED_PLATFORMS.find(({ id }) => id === 'codex')!;
    await copyOwnerSkillsForPlatform(projectRoot, codex, true, 'skills', 'project');
    await installOwnerHooksForPlatform(projectRoot, codex, 'project');
    await fs.rename(
      path.join(projectRoot, '.codex', 'hooks.json'),
      path.join(projectRoot, '.codex', 'settings.local.json'),
    );

    await expect(
      inspectOwnerHooksForPlatform(projectRoot, codex, 'project'),
    ).resolves.toMatchObject({
      present: false,
      managedPresent: true,
      legacyPresent: true,
    });
  });
});
