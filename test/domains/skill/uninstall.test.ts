import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { installOwnerHooksForPlatform } from '../../../domains/skill/platform-install.js';
import { removeOwnerHooksForPlatform } from '../../../domains/skill/uninstall.js';
import { PLATFORMS } from '../../../platform/install/platforms.js';

describe('removeOwnerHooksForPlatform', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-hook-uninstall-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it.each([
    { id: 'claude', configPath: ['.claude', 'settings.local.json'] },
    { id: 'codex', configPath: ['.codex', 'hooks.json'] },
  ])('fails closed when canonical $id Hook JSON is malformed', async ({ id, configPath }) => {
    const platform = PLATFORMS.find((candidate) => candidate.id === id)!;
    const settingsPath = path.join(tmpDir, ...configPath);
    const malformedSettings = '{\r\n  "hooks": {\r\n';
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, malformedSettings, 'utf8');

    await expect(removeOwnerHooksForPlatform(tmpDir, platform, 'project')).resolves.toEqual({
      removed: 0,
      failed: 1,
    });
    await expect(fs.readFile(settingsPath, 'utf8')).resolves.toBe(malformedSettings);
  });

  it.each(['claude', 'codex'])('preserves user Hook metadata for %s', async (id) => {
    const platform = PLATFORMS.find((candidate) => candidate.id === id)!;
    const settingsPath = path.join(
      tmpDir,
      id === 'claude' ? '.claude' : '.codex',
      id === 'claude' ? 'settings.local.json' : 'hooks.json',
    );
    await installOwnerHooksForPlatform(tmpDir, platform, 'project');
    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    settings.userSetting = 'keep';
    settings.hooks.PostToolUse = [
      { matcher: 'Read', hooks: [{ type: 'command', command: 'echo post' }] },
    ];
    settings.hooks.PreToolUse[0].description = 'user-owned metadata';
    await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');

    await expect(removeOwnerHooksForPlatform(tmpDir, platform, 'project')).resolves.toEqual({
      removed: 1,
      failed: 0,
    });

    const updated = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    expect(updated.userSetting).toBe('keep');
    expect(updated.hooks.PostToolUse).toEqual(settings.hooks.PostToolUse);
    expect(updated.hooks.PreToolUse[0]).toMatchObject({
      description: 'user-owned metadata',
      hooks: [],
    });
  });

  it('counts malformed historical Codex hooks after canonical cleanup succeeds', async () => {
    const codex = PLATFORMS.find((platform) => platform.id === 'codex')!;
    const canonicalPath = path.join(tmpDir, '.codex', 'hooks.json');
    const legacyPath = path.join(tmpDir, '.codex', 'settings.local.json');
    const malformedLegacy = '{\n  "hooks": {\n';

    await installOwnerHooksForPlatform(tmpDir, codex, 'project');
    await fs.writeFile(legacyPath, malformedLegacy, 'utf8');

    await expect(removeOwnerHooksForPlatform(tmpDir, codex, 'project')).resolves.toEqual({
      removed: 1,
      failed: 1,
    });
    const cleanedCanonical = JSON.parse(await fs.readFile(canonicalPath, 'utf8'));
    expect(cleanedCanonical.hooks.PreToolUse[0].hooks).toEqual([]);
    await expect(fs.readFile(legacyPath, 'utf8')).resolves.toBe(malformedLegacy);
  });

  it('counts unreadable historical Codex Hook access after canonical cleanup', async () => {
    const codex = PLATFORMS.find((platform) => platform.id === 'codex')!;
    const canonicalPath = path.join(tmpDir, '.codex', 'hooks.json');
    const legacyPath = path.join(tmpDir, '.codex', 'settings.local.json');
    await installOwnerHooksForPlatform(tmpDir, codex, 'project');
    const canonicalSource = await fs.readFile(canonicalPath, 'utf8');
    await fs.writeFile(legacyPath, canonicalSource, 'utf8');
    const access = fs.access.bind(fs);
    const permissionError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const accessSpy = vi.spyOn(fs, 'access').mockImplementation(async (filePath, mode) => {
      if (path.resolve(String(filePath)) === path.resolve(legacyPath)) throw permissionError;
      await access(filePath, mode);
    });

    try {
      await expect(removeOwnerHooksForPlatform(tmpDir, codex, 'project')).resolves.toEqual({
        removed: 1,
        failed: 1,
      });
    } finally {
      accessSpy.mockRestore();
    }

    const cleanedCanonical = JSON.parse(await fs.readFile(canonicalPath, 'utf8'));
    expect(cleanedCanonical.hooks.PreToolUse[0].hooks).toEqual([]);
    await expect(fs.readFile(legacyPath, 'utf8')).resolves.toBe(canonicalSource);
  });
});
