import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { promises as fs } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import os from 'os';

const { rmdirMock, writeFileMock } = vi.hoisted(() => ({
  rmdirMock: vi.fn(),
  writeFileMock: vi.fn(),
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  rmdirMock.mockImplementation(actual.rmdir);
  writeFileMock.mockImplementation(actual.writeFile);
  return { ...actual, rmdir: rmdirMock, writeFile: writeFileMock };
});

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockedExecFileSync = vi.mocked(execFileSync);

import {
  PLATFORMS,
  getPlatformSkillsDir,
  type Platform,
} from '../../platform/install/platforms.js';
import {
  removeLegacyOwnerSkillsForPlatform,
  removeOwnerSkillsForPlatform,
  removeOwnerRulesForPlatform,
  removeOwnerHooksForPlatform,
  removeSuperpowersSkillsForPlatforms,
  removeWorkingDirs,
} from '../../domains/skill/uninstall.js';
import {
  copyOwnerSkillsForPlatform,
  copyOwnerRulesForPlatform,
  installOwnerHooksForPlatform,
} from '../../domains/skill/platform-install.js';
import { installOwnerProjectInstructions } from '../../domains/skill/project-instructions.js';
import { fileExists, removeFile, removeDir, isDirEmpty } from '../../platform/fs/file-system.js';
import {
  getProjectRegistryPath,
  upsertProjectInstallation,
} from '../../platform/install/project-registry.js';

describe('uninstall', () => {
  let tmpDir: string;

  beforeEach(async () => {
    rmdirMock.mockReset();
    rmdirMock.mockImplementation(fs.rmdir);
    writeFileMock.mockReset();
    writeFileMock.mockImplementation(fs.writeFile);
    mockedExecFileSync.mockReset();
    const temporaryRoot = await fs.realpath(os.tmpdir());
    tmpDir = path.join(
      temporaryRoot,
      `owner-uninstall-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('removes only managed Codex skills from canonical and legacy roots', async () => {
    const codexPlatform = PLATFORMS.find((platform) => platform.id === 'codex')!;
    await copyOwnerSkillsForPlatform(tmpDir, codexPlatform, true, 'skills', 'project');
    const legacyOwner = path.join(tmpDir, '.codex', 'skills', 'owner');
    await fs.mkdir(legacyOwner, { recursive: true });
    await fs.writeFile(path.join(legacyOwner, 'SKILL.md'), '# Owner\n');
    for (const root of ['.agents', '.codex']) {
      const personal = path.join(tmpDir, root, 'skills', 'personal', 'SKILL.md');
      await fs.mkdir(path.dirname(personal), { recursive: true });
      await fs.writeFile(personal, '# Personal\n');
    }

    await removeOwnerSkillsForPlatform(tmpDir, codexPlatform, 'project');

    await expect(fs.access(path.join(tmpDir, '.agents', 'skills', 'owner'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.access(legacyOwner)).rejects.toMatchObject({ code: 'ENOENT' });
    for (const root of ['.agents', '.codex']) {
      await expect(
        fs.readFile(path.join(tmpDir, root, 'skills', 'personal', 'SKILL.md'), 'utf8'),
      ).resolves.toBe('# Personal\n');
    }
  });

  it.each(['canonical', 'external'] as const)(
    'unlinks a legacy Codex managed Skill junction without modifying its %s target',
    async (targetKind) => {
      const codexPlatform = PLATFORMS.find((platform) => platform.id === 'codex')!;
      const target =
        targetKind === 'canonical'
          ? path.join(tmpDir, '.agents', 'skills', 'owner')
          : path.join(tmpDir, 'external', 'owner');
      const legacyLink = path.join(tmpDir, '.codex', 'skills', 'owner');
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(target, 'SKILL.md'), '# Target Owner\n');
      await fs.writeFile(path.join(target, 'keep.txt'), 'keep\n');
      await fs.mkdir(path.dirname(legacyLink), { recursive: true });
      await fs.symlink(target, legacyLink, process.platform === 'win32' ? 'junction' : 'dir');

      await removeLegacyOwnerSkillsForPlatform(tmpDir, codexPlatform, 'project');

      await expect(fs.lstat(legacyLink)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.readFile(path.join(target, 'SKILL.md'), 'utf8')).resolves.toBe(
        '# Target Owner\n',
      );
      await expect(fs.readFile(path.join(target, 'keep.txt'), 'utf8')).resolves.toBe('keep\n');
    },
  );

  it.each(['canonical', 'external'] as const)(
    'unlinks a nested legacy Codex managed junction without modifying its %s target',
    async (targetKind) => {
      const codexPlatform = PLATFORMS.find((platform) => platform.id === 'codex')!;
      const target =
        targetKind === 'canonical'
          ? path.join(tmpDir, '.agents', 'skills', 'owner', 'scripts')
          : path.join(tmpDir, 'external', 'owner-scripts');
      const legacyOwner = path.join(tmpDir, '.codex', 'skills', 'owner');
      const legacyLink = path.join(legacyOwner, 'scripts');
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(target, 'owner-state.mjs'), 'target state\n');
      await fs.writeFile(path.join(target, 'keep.txt'), 'keep\n');
      await fs.mkdir(legacyOwner, { recursive: true });
      await fs.writeFile(path.join(legacyOwner, 'SKILL.md'), '# Legacy Owner\n');
      await fs.symlink(target, legacyLink, process.platform === 'win32' ? 'junction' : 'dir');

      await removeLegacyOwnerSkillsForPlatform(tmpDir, codexPlatform, 'project');

      await expect(fs.lstat(legacyLink)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.readFile(path.join(target, 'owner-state.mjs'), 'utf8')).resolves.toBe(
        'target state\n',
      );
      await expect(fs.readFile(path.join(target, 'keep.txt'), 'utf8')).resolves.toBe('keep\n');
    },
  );

  it.each(['.agents', '.codex'] as const)(
    'refuses to clean a shared Codex skills-root junction at %s',
    async (root) => {
      const codexPlatform = PLATFORMS.find((platform) => platform.id === 'codex')!;
      const target = path.join(tmpDir, 'external', root.slice(1), 'skills');
      const targetOwner = path.join(target, 'owner');
      const personal = path.join(target, 'personal', 'SKILL.md');
      const skillsLink = path.join(tmpDir, root, 'skills');
      await fs.mkdir(targetOwner, { recursive: true });
      await fs.writeFile(path.join(targetOwner, 'SKILL.md'), '# Target Owner\n');
      await fs.writeFile(path.join(targetOwner, 'keep.txt'), 'keep\n');
      await fs.mkdir(path.dirname(personal), { recursive: true });
      await fs.writeFile(personal, '# Personal\n');
      await fs.mkdir(path.dirname(skillsLink), { recursive: true });
      await fs.symlink(target, skillsLink, process.platform === 'win32' ? 'junction' : 'dir');

      const result = await removeOwnerSkillsForPlatform(tmpDir, codexPlatform, 'project');

      expect(result.failed).toBeGreaterThan(0);
      await expect(fs.lstat(skillsLink)).resolves.toMatchObject({});
      await expect(fs.readFile(path.join(targetOwner, 'SKILL.md'), 'utf8')).resolves.toBe(
        '# Target Owner\n',
      );
      await expect(fs.readFile(path.join(targetOwner, 'keep.txt'), 'utf8')).resolves.toBe('keep\n');
      await expect(fs.readFile(personal, 'utf8')).resolves.toBe('# Personal\n');
    },
  );

  it.each(['.agents', '.codex'] as const)(
    'refuses to clean a shared Codex platform-root junction at %s',
    async (root) => {
      const codexPlatform = PLATFORMS.find((platform) => platform.id === 'codex')!;
      const target = path.join(tmpDir, 'external', `${root.slice(1)}-root`);
      const owner = path.join(target, 'skills', 'owner', 'SKILL.md');
      const personal = path.join(target, 'skills', 'personal', 'SKILL.md');
      await fs.mkdir(path.dirname(owner), { recursive: true });
      await fs.mkdir(path.dirname(personal), { recursive: true });
      await fs.writeFile(owner, '# Owner\n');
      await fs.writeFile(personal, '# Personal\n');
      await fs.symlink(
        target,
        path.join(tmpDir, root),
        process.platform === 'win32' ? 'junction' : 'dir',
      );

      const result = await removeOwnerSkillsForPlatform(tmpDir, codexPlatform, 'project');

      expect(result.failed).toBeGreaterThan(0);
      await expect(fs.lstat(path.join(tmpDir, root))).resolves.toMatchObject({});
      await expect(fs.readFile(owner, 'utf8')).resolves.toBe('# Owner\n');
      await expect(fs.readFile(personal, 'utf8')).resolves.toBe('# Personal\n');
    },
  );

  it('counts a Skill removal failure and continues removing independent managed Skills', async () => {
    const codexPlatform = PLATFORMS.find((platform) => platform.id === 'codex')!;
    await copyOwnerSkillsForPlatform(tmpDir, codexPlatform, true, 'skills', 'project');
    const blockedSkill = path.join(tmpDir, '.agents', 'skills', 'owner', 'SKILL.md');
    const removableSkill = path.join(tmpDir, '.agents', 'skills', 'owner-open', 'SKILL.md');
    const userSkill = path.join(tmpDir, '.agents', 'skills', 'personal', 'SKILL.md');
    await fs.mkdir(path.dirname(userSkill), { recursive: true });
    await fs.writeFile(userSkill, '# Personal\n');
    const unlink = fs.unlink.bind(fs);
    const permissionError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const unlinkSpy = vi.spyOn(fs, 'unlink').mockImplementation(async (filePath) => {
      if (path.resolve(String(filePath)) === path.resolve(blockedSkill)) throw permissionError;
      await unlink(filePath);
    });

    try {
      await expect(
        removeOwnerSkillsForPlatform(tmpDir, codexPlatform, 'project'),
      ).resolves.toMatchObject({ failed: 1 });
    } finally {
      unlinkSpy.mockRestore();
    }

    await expect(fs.readFile(blockedSkill, 'utf8')).resolves.toContain('# Owner');
    await expect(fs.access(removableSkill)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(userSkill, 'utf8')).resolves.toBe('# Personal\n');
  });

  it('counts a Rule removal failure and continues removing independent managed Rules', async () => {
    const claudePlatform = PLATFORMS.find((platform) => platform.id === 'claude')!;
    const rulesDir = path.join(tmpDir, '.claude', 'rules');
    const blockedRule = path.join(rulesDir, 'owner-workflow-guard.md');
    const removableRule = path.join(rulesDir, 'owner-phase-guard.md');
    const userRule = path.join(rulesDir, 'personal.md');
    await fs.mkdir(rulesDir, { recursive: true });
    await fs.writeFile(blockedRule, '# Blocked Rule\n');
    await fs.writeFile(removableRule, '# Removable Rule\n');
    await fs.writeFile(userRule, '# Personal Rule\n');
    const unlink = fs.unlink.bind(fs);
    const permissionError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const unlinkSpy = vi.spyOn(fs, 'unlink').mockImplementation(async (filePath) => {
      if (path.resolve(String(filePath)) === path.resolve(blockedRule)) throw permissionError;
      await unlink(filePath);
    });

    try {
      await expect(removeOwnerRulesForPlatform(tmpDir, claudePlatform, 'project')).resolves.toEqual(
        { removed: 1, failed: 1 },
      );
    } finally {
      unlinkSpy.mockRestore();
    }

    await expect(fs.readFile(blockedRule, 'utf8')).resolves.toBe('# Blocked Rule\n');
    await expect(fs.access(removableRule)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(userRule, 'utf8')).resolves.toBe('# Personal Rule\n');
  });

  it('counts an empty Rule-directory removal failure after removing managed Rules', async () => {
    const claudePlatform = PLATFORMS.find((platform) => platform.id === 'claude')!;
    const rulesDir = path.join(tmpDir, '.claude', 'rules');
    await fs.mkdir(rulesDir, { recursive: true });
    await fs.writeFile(path.join(rulesDir, 'owner-workflow-guard.md'), '# Rule\n');
    await fs.writeFile(path.join(rulesDir, 'owner-phase-guard.md'), '# Legacy Rule\n');
    const rm = fs.rm.bind(fs);
    const permissionError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const rmSpy = vi.spyOn(fs, 'rm').mockImplementation(async (dirPath, options) => {
      if (path.resolve(String(dirPath)) === path.resolve(rulesDir)) throw permissionError;
      await rm(dirPath, options);
    });

    try {
      await expect(removeOwnerRulesForPlatform(tmpDir, claudePlatform, 'project')).resolves.toEqual(
        { removed: 2, failed: 1 },
      );
    } finally {
      rmSpy.mockRestore();
    }

    await expect(fs.readdir(rulesDir)).resolves.toEqual([]);
  });

  describe('file-system utilities', () => {
    describe('removeFile', () => {
      it('removes an existing file and returns true', async () => {
        const filePath = path.join(tmpDir, 'test.txt');
        await fs.writeFile(filePath, 'hello', 'utf-8');
        expect(await fileExists(filePath)).toBe(true);

        const result = await removeFile(filePath);
        expect(result).toBe(true);
        expect(await fileExists(filePath)).toBe(false);
      });

      it('returns false for non-existent file', async () => {
        const result = await removeFile(path.join(tmpDir, 'nope.txt'));
        expect(result).toBe(false);
      });
    });

    describe('removeDir', () => {
      it('removes an existing directory and returns true', async () => {
        const dirPath = path.join(tmpDir, 'subdir');
        await fs.mkdir(dirPath, { recursive: true });
        await fs.writeFile(path.join(dirPath, 'file.txt'), 'data', 'utf-8');

        const result = await removeDir(dirPath);
        expect(result).toBe(true);
        expect(await fileExists(dirPath)).toBe(false);
      });

      it('returns false for non-existent directory', async () => {
        const result = await removeDir(path.join(tmpDir, 'nope'));
        expect(result).toBe(false);
      });

      it('removes a symlinked directory without deleting its target', async () => {
        if (process.platform === 'win32') return; // requires elevated permissions
        // Data-safety: a symlinked skills/rules/hooks dir must be unlinked in
        // place, never recursively removed through to its resolved target.
        const realDir = path.join(tmpDir, 'real-target');
        const realFile = path.join(realDir, 'keep-me.txt');
        await fs.mkdir(realDir, { recursive: true });
        await fs.writeFile(realFile, 'data', 'utf-8');

        const symlinkDir = path.join(tmpDir, 'skills-symlink');
        await fs.symlink(realDir, symlinkDir, 'dir');

        const result = await removeDir(symlinkDir);

        expect(result).toBe(true);
        expect(await fileExists(symlinkDir)).toBe(false);
        expect(await fileExists(realDir)).toBe(true);
        expect(await fileExists(realFile)).toBe(true);
      });
    });

    describe('isDirEmpty', () => {
      it('returns true for empty directory', async () => {
        const dirPath = path.join(tmpDir, 'empty');
        await fs.mkdir(dirPath, { recursive: true });
        expect(await isDirEmpty(dirPath)).toBe(true);
      });

      it('returns false for non-empty directory', async () => {
        const dirPath = path.join(tmpDir, 'notempty');
        await fs.mkdir(dirPath, { recursive: true });
        await fs.writeFile(path.join(dirPath, 'file.txt'), 'data', 'utf-8');
        expect(await isDirEmpty(dirPath)).toBe(false);
      });

      it('returns true for non-existent directory', async () => {
        expect(await isDirEmpty(path.join(tmpDir, 'nope'))).toBe(true);
      });

      it('returns false when the path is not a directory', async () => {
        // readdir on a file throws ENOTDIR (a non-ENOENT error); isDirEmpty
        // must report false so callers never treat an unreadable path as empty.
        const filePath = path.join(tmpDir, 'a-file.txt');
        await fs.writeFile(filePath, 'data', 'utf-8');
        expect(await isDirEmpty(filePath)).toBe(false);
      });
    });
  });

  describe('removeOwnerSkillsForPlatform', () => {
    const claudePlatform: Platform = PLATFORMS.find((p) => p.id === 'claude')!;

    const retiredLoopBundles = [
      'owner-loop/scripts/owner-loop-checkpoint.mjs',
      'owner-loop/scripts/owner-loop-check.mjs',
      'owner-loop/scripts/owner-loop-evidence.mjs',
      'owner-loop/scripts/owner-loop-receipt.mjs',
    ] as const;

    it('removes installed Owner skills', async () => {
      await copyOwnerSkillsForPlatform(tmpDir, claudePlatform, true, 'skills', 'project');

      const skillsDir = path.join(tmpDir, '.claude', 'skills');
      const entriesBefore = await fs.readdir(skillsDir);
      const ownerEntries = entriesBefore.filter((e) => e.startsWith('owner'));
      expect(ownerEntries.length).toBeGreaterThan(0);

      const result = await removeOwnerSkillsForPlatform(tmpDir, claudePlatform, 'project');
      expect(result.removed).toBeGreaterThan(0);

      for (const entry of ownerEntries) {
        expect(await fileExists(path.join(skillsDir, entry))).toBe(false);
      }
    });

    it('handles already-removed skills gracefully', async () => {
      const result = await removeOwnerSkillsForPlatform(tmpDir, claudePlatform, 'project');
      expect(result.removed).toBe(0);
      expect(result.failed).toBe(0);
    });

    it('removes retired Loop bundles from copy and central stores without deleting user files', async () => {
      const roots = [
        path.join(tmpDir, '.claude', 'skills'),
        path.join(tmpDir, '.owner', 'skills', 'skills'),
      ];
      for (const root of roots) {
        const userFile = path.join(root, 'owner-loop', 'scripts', 'user-helper.mjs');
        await fs.mkdir(path.dirname(userFile), { recursive: true });
        await fs.writeFile(userFile, 'keep user content\n', 'utf8');
        for (const relativePath of retiredLoopBundles) {
          const target = path.join(root, ...relativePath.split('/'));
          await fs.writeFile(target, 'legacy bundle\n', 'utf8');
        }
      }

      const result = await removeOwnerSkillsForPlatform(tmpDir, claudePlatform, 'project');

      expect(result.failed).toBe(0);
      expect(result.removed).toBe(retiredLoopBundles.length * roots.length);
      for (const root of roots) {
        for (const relativePath of retiredLoopBundles) {
          await expect(
            fs.access(path.join(root, ...relativePath.split('/'))),
          ).rejects.toMatchObject({ code: 'ENOENT' });
        }
        await expect(
          fs.readFile(path.join(root, 'owner-loop', 'scripts', 'user-helper.mjs'), 'utf8'),
        ).resolves.toBe('keep user content\n');
      }
    });

    it('removes only the selected workflow Skills and keeps their shared entry', async () => {
      await copyOwnerSkillsForPlatform(
        tmpDir,
        claudePlatform,
        true,
        'skills',
        'project',
        'copy',
        'both',
      );
      const skillsDir = path.join(tmpDir, '.claude', 'skills');

      const result = await removeOwnerSkillsForPlatform(
        tmpDir,
        claudePlatform,
        'project',
        ['pipeline'],
        ['loop'],
      );

      expect(result.failed).toBe(0);
      expect(await fileExists(path.join(skillsDir, 'owner-pipeline', 'SKILL.md'))).toBe(false);
      expect(await fileExists(path.join(skillsDir, 'owner-loop', 'SKILL.md'))).toBe(true);
      expect(await fileExists(path.join(skillsDir, 'owner', 'SKILL.md'))).toBe(true);
    });
  });

  describe('removeSuperpowersSkillsForPlatforms', () => {
    it('removes listed Superpowers Skills from selected platforms in one CLI call', async () => {
      const claudePlatform = PLATFORMS.find((platform) => platform.id === 'claude')!;
      const codexPlatform = PLATFORMS.find((platform) => platform.id === 'codex')!;
      mockedExecFileSync.mockImplementation((_command, args) => {
        if (args[1] === 'list') {
          return JSON.stringify([
            { name: 'brainstorming', source: 'obra/superpowers', agents: ['Claude Code'] },
            {
              name: 'writing-plans',
              source: 'obra/superpowers',
              agents: ['Claude Code', 'Cursor'],
            },
            { name: 'personal', source: 'me/personal', agents: ['Claude Code'] },
            { name: 'using-superpowers', source: 'obra/superpowers', agents: ['Cursor'] },
          ]) as never;
        }
        return '' as never;
      });

      for (const name of ['brainstorming', 'writing-plans', 'using-superpowers']) {
        await fs.mkdir(path.join(tmpDir, '.agents', 'skills', name), { recursive: true });
      }

      const result = await removeSuperpowersSkillsForPlatforms(
        tmpDir,
        [claudePlatform, codexPlatform],
        'project',
        { removeSharedStorage: true },
      );

      expect(result).toEqual({ removed: 3, failed: 0 });
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        expect.any(String),
        ['skills', 'remove', 'brainstorming', '--agent', 'claude-code', 'codex', '--yes'],
        expect.objectContaining({ cwd: tmpDir }),
      );
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        expect.any(String),
        ['skills', 'remove', 'writing-plans', '--agent', 'claude-code', 'codex', '--yes'],
        expect.objectContaining({ cwd: tmpDir }),
      );
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        expect.any(String),
        ['skills', 'remove', 'using-superpowers', '--agent', 'claude-code', 'codex', '--yes'],
        expect.anything(),
      );
      await expect(
        fs.access(path.join(tmpDir, '.agents', 'skills', 'brainstorming')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('uses the project Skills lock when the CLI has lost Superpowers source metadata', async () => {
      const codexPlatform = PLATFORMS.find((platform) => platform.id === 'codex')!;
      await fs.mkdir(path.join(tmpDir, '.agents', 'skills', 'brainstorming'), { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, 'skills-lock.json'),
        JSON.stringify({
          version: 1,
          skills: { brainstorming: { source: 'obra/superpowers' } },
        }),
        'utf8',
      );
      mockedExecFileSync.mockImplementation((_command, args) => {
        if (args[1] === 'list') {
          return JSON.stringify([{ name: 'brainstorming', source: null }]) as never;
        }
        return '' as never;
      });

      const result = await removeSuperpowersSkillsForPlatforms(tmpDir, [codexPlatform], 'project', {
        removeSharedStorage: true,
      });

      expect(result).toEqual({ removed: 1, failed: 0 });
      await expect(
        fs.access(path.join(tmpDir, '.agents', 'skills', 'brainstorming')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  describe('removeOwnerRulesForPlatform', () => {
    it('removes rules for a platform that supports them', async () => {
      const claudePlatform: Platform = PLATFORMS.find((p) => p.id === 'claude')!;

      await copyOwnerRulesForPlatform(tmpDir, claudePlatform, true, 'zh', 'project');

      const rulePath = path.join(tmpDir, '.claude', 'rules', 'owner-workflow-guard.md');
      expect(await fileExists(rulePath)).toBe(true);

      const result = await removeOwnerRulesForPlatform(tmpDir, claudePlatform, 'project');
      expect(result.removed).toBeGreaterThan(0);
      expect(await fileExists(rulePath)).toBe(false);
    });

    it('counts a Rule-directory inspection permission failure without deleting user Rules', async () => {
      const claudePlatform: Platform = PLATFORMS.find((p) => p.id === 'claude')!;
      const rulesDir = path.join(tmpDir, '.claude', 'rules');
      const userRule = path.join(rulesDir, 'personal.md');
      await fs.mkdir(rulesDir, { recursive: true });
      await fs.writeFile(userRule, '# Personal Rule\n');
      const readdir = fs.readdir.bind(fs);
      const permissionError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
      const readdirSpy = vi.spyOn(fs, 'readdir').mockImplementation(async (dirPath, options) => {
        if (path.resolve(String(dirPath)) === path.resolve(rulesDir)) throw permissionError;
        return readdir(dirPath, options as never);
      });

      try {
        await expect(
          removeOwnerRulesForPlatform(tmpDir, claudePlatform, 'project'),
        ).resolves.toEqual({ removed: 0, failed: 1 });
      } finally {
        readdirSpy.mockRestore();
      }

      await expect(fs.readFile(userRule, 'utf8')).resolves.toBe('# Personal Rule\n');
    });
  });

  describe('removeOwnerHooksForPlatform', () => {
    it('removes Codex hooks from canonical and historical files while preserving user config', async () => {
      const codex = PLATFORMS.find((platform) => platform.id === 'codex')!;
      const canonicalPath = path.join(tmpDir, '.codex', 'hooks.json');
      const legacyPath = path.join(tmpDir, '.codex', 'settings.local.json');
      const userHandler = { type: 'command', command: 'node my-user-hook.mjs' };

      await installOwnerHooksForPlatform(tmpDir, codex, 'project');
      const canonical = JSON.parse(await fs.readFile(canonicalPath, 'utf8'));
      const ownerHandler = canonical.hooks.PreToolUse[0].hooks[0];
      canonical.hooks.PreToolUse[0].hooks.push(userHandler);
      await fs.writeFile(canonicalPath, JSON.stringify(canonical, null, 2), 'utf8');
      await fs.writeFile(
        legacyPath,
        JSON.stringify(
          {
            model: 'gpt-5',
            hooks: {
              PreToolUse: [{ matcher: 'Write|Edit', hooks: [ownerHandler, userHandler] }],
            },
          },
          null,
          2,
        ),
        'utf8',
      );

      const result = await removeOwnerHooksForPlatform(tmpDir, codex, 'project');

      expect(result).toEqual({ removed: 2, failed: 0 });
      const cleanedCanonical = JSON.parse(await fs.readFile(canonicalPath, 'utf8'));
      expect(cleanedCanonical.hooks.PreToolUse[0].hooks).toEqual([userHandler]);
      const cleanedLegacy = JSON.parse(await fs.readFile(legacyPath, 'utf8'));
      expect(cleanedLegacy.model).toBe('gpt-5');
      expect(cleanedLegacy.hooks.PreToolUse[0].hooks).toEqual([userHandler]);
    });

    it('removes quoted Codex hook commands whose script path contains spaces', async () => {
      const codex = PLATFORMS.find((platform) => platform.id === 'codex')!;
      const canonicalPath = path.join(tmpDir, '.codex', 'hooks.json');
      const managedPath = 'C:/Users/Jane Doe/.agents/skills/owner/scripts/owner-hook-guard.mjs';
      await fs.mkdir(path.dirname(canonicalPath), { recursive: true });
      await fs.writeFile(
        canonicalPath,
        JSON.stringify(
          {
            hooks: {
              PreToolUse: [
                {
                  matcher: 'Write|Edit',
                  hooks: [
                    {
                      type: 'command',
                      command: `node "${managedPath}" --project-root "C:/Users/Jane Doe"`,
                    },
                  ],
                },
              ],
            },
          },
          null,
          2,
        ),
        'utf8',
      );

      await expect(removeOwnerHooksForPlatform(tmpDir, codex, 'project')).resolves.toEqual({
        removed: 1,
        failed: 0,
      });
      const cleaned = JSON.parse(await fs.readFile(canonicalPath, 'utf8'));
      expect(cleaned.hooks.PreToolUse[0].hooks).toEqual([]);
    });

    it('continues Codex cleanup across files and counts every write failure', async () => {
      const codex = {
        ...PLATFORMS.find((platform) => platform.id === 'codex')!,
        legacyHookConfigFiles: ['settings.local.json', 'settings.backup.json'],
      };
      const canonicalPath = path.join(tmpDir, '.codex', 'hooks.json');
      const legacyPath = path.join(tmpDir, '.codex', 'settings.local.json');
      const backupPath = path.join(tmpDir, '.codex', 'settings.backup.json');
      const userHandler = { type: 'command', command: 'node my-user-hook.mjs' };

      await installOwnerHooksForPlatform(tmpDir, codex, 'project');
      const canonical = JSON.parse(await fs.readFile(canonicalPath, 'utf8'));
      const ownerHandler = canonical.hooks.PreToolUse[0].hooks[0];
      canonical.hooks.PreToolUse[0].hooks.push(userHandler);
      await fs.writeFile(canonicalPath, JSON.stringify(canonical, null, 2), 'utf8');
      await fs.writeFile(
        legacyPath,
        JSON.stringify(
          {
            hooks: {
              PreToolUse: [{ matcher: 'Write|Edit', hooks: [ownerHandler, userHandler] }],
            },
          },
          null,
          2,
        ),
        'utf8',
      );
      await fs.copyFile(legacyPath, backupPath);
      writeFileMock
        .mockRejectedValueOnce(new Error('simulated canonical write failure'))
        .mockImplementationOnce(fs.writeFile)
        .mockRejectedValueOnce(new Error('simulated backup write failure'));

      const result = await removeOwnerHooksForPlatform(tmpDir, codex, 'project');

      expect(result).toEqual({ removed: 1, failed: 2 });
      const unchangedCanonical = JSON.parse(await fs.readFile(canonicalPath, 'utf8'));
      expect(unchangedCanonical.hooks.PreToolUse[0].hooks).toEqual([ownerHandler, userHandler]);
      const cleanedLegacy = JSON.parse(await fs.readFile(legacyPath, 'utf8'));
      expect(cleanedLegacy.hooks.PreToolUse[0].hooks).toEqual([userHandler]);
      const unchangedBackup = JSON.parse(await fs.readFile(backupPath, 'utf8'));
      expect(unchangedBackup.hooks.PreToolUse[0].hooks).toEqual([ownerHandler, userHandler]);
    });

    it('removes Claude Code hooks while preserving non-Owner hooks', async () => {
      const claudePlatform: Platform = PLATFORMS.find((p) => p.id === 'claude')!;

      const settingsDir = path.join(tmpDir, '.claude');
      await fs.mkdir(settingsDir, { recursive: true });
      const settingsPath = path.join(settingsDir, 'settings.local.json');
      const settings = {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Write|Edit',
              hooks: [
                {
                  type: 'command',
                  command: 'bash .claude/skills/owner/scripts/owner-hook-guard.sh',
                },
                { type: 'command', command: 'bash my-custom-hook.sh' },
              ],
            },
          ],
        },
      };
      await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');

      await installOwnerHooksForPlatform(tmpDir, claudePlatform, 'project');

      const result = await removeOwnerHooksForPlatform(tmpDir, claudePlatform, 'project');
      expect(result.removed).toBeGreaterThan(0);

      const updatedContent = await fs.readFile(settingsPath, 'utf-8');
      const updated = JSON.parse(updatedContent);
      expect(updated.hooks.PreToolUse).toBeDefined();
      expect(updated.hooks.PreToolUse.length).toBeGreaterThan(0);

      const allCommands = updated.hooks.PreToolUse.flatMap((g: Record<string, unknown>) =>
        (g.hooks as Array<Record<string, unknown>>).map((h: Record<string, unknown>) => h.command),
      );
      expect(allCommands).toContain('bash my-custom-hook.sh');
      expect(allCommands.some((c: string) => c.includes('owner-hook-guard'))).toBe(false);
    });

    it('preserves empty hook groups after removal', async () => {
      const claudePlatform: Platform = PLATFORMS.find((p) => p.id === 'claude')!;
      const settingsDir = path.join(tmpDir, '.claude');
      await fs.mkdir(settingsDir, { recursive: true });
      const settingsPath = path.join(settingsDir, 'settings.local.json');

      const settings = {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Write|Edit',
              hooks: [
                {
                  type: 'command',
                  command: 'bash .claude/skills/owner/scripts/owner-hook-guard.sh',
                },
              ],
            },
          ],
        },
      };
      await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');

      const result = await removeOwnerHooksForPlatform(tmpDir, claudePlatform, 'project');
      expect(result.removed).toBe(1);

      const updatedContent = await fs.readFile(settingsPath, 'utf-8');
      const updated = JSON.parse(updatedContent);
      expect(updated.hooks.PreToolUse).toEqual([{ matcher: 'Write|Edit', hooks: [] }]);
    });
  });

  describe('removeWorkingDirs', () => {
    async function writeLoopProjectConfig(
      artifactRoot: string,
      workflows: 'loop' | 'both' = 'loop',
    ): Promise<string> {
      const configPath = path.join(tmpDir, '.owner', 'config.yaml');
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        [
          'schema: owner.project.v1',
          'default_workflow: loop',
          `workflows: [loop${workflows === 'both' ? ', pipeline' : ''}]`,
          'loop:',
          `  artifact_root: ${artifactRoot}`,
          ...(workflows === 'both' ? ['pipeline:', '  artifact_layout: docs'] : []),
          '',
        ].join('\n'),
        'utf8',
      );
      return configPath;
    }

    async function createLoopWorkingTree(artifactRoot: string): Promise<string> {
      const loopRoot = path.join(tmpDir, ...artifactRoot.split('/'), 'owner');
      for (const directory of [
        'specs',
        'changes',
        'archive',
        'runtime/locks',
        'runtime/transactions',
      ]) {
        await fs.mkdir(path.join(loopRoot, ...directory.split('/')), { recursive: true });
      }
      return loopRoot;
    }

    it('removes .owner directory', async () => {
      const ownerDir = path.join(tmpDir, '.owner');
      await fs.mkdir(ownerDir, { recursive: true });
      await fs.writeFile(path.join(ownerDir, 'config.yaml'), 'test: true', 'utf-8');

      const result = await removeWorkingDirs(tmpDir);
      expect(result.removed).toBeGreaterThan(0);
      expect(await fileExists(ownerDir)).toBe(false);
    });

    it('removes empty docs/superpowers directories', async () => {
      const specsDir = path.join(tmpDir, 'docs', 'superpowers', 'specs');
      const plansDir = path.join(tmpDir, 'docs', 'superpowers', 'plans');
      await fs.mkdir(specsDir, { recursive: true });
      await fs.mkdir(plansDir, { recursive: true });

      await removeWorkingDirs(tmpDir);

      expect(await fileExists(path.join(tmpDir, 'docs'))).toBe(false);
    });

    it('removes an empty configured docs layout', async () => {
      const configPath = path.join(tmpDir, '.owner', 'config.yaml');
      const docsRoot = path.join(tmpDir, 'docs');
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, 'pipeline:\n  artifact_layout: docs\n', 'utf8');
      await fs.mkdir(path.join(docsRoot, 'openspec', 'changes', 'archive'), { recursive: true });
      await fs.mkdir(path.join(docsRoot, 'openspec', 'specs'), { recursive: true });
      await fs.mkdir(path.join(docsRoot, 'superpowers', 'reports'), { recursive: true });

      const result = await removeWorkingDirs(tmpDir);

      expect(result).toEqual({ removed: 1, failed: 0 });
      expect(await fileExists(path.join(tmpDir, '.owner'))).toBe(false);
      expect(await fileExists(docsRoot)).toBe(false);
    });

    it.each(['docs', 'legacy'] as const)(
      'preserves a real OpenSpec %s root with config.yaml while removing independent Owner-owned trees',
      async (artifactLayout) => {
        const configPath = path.join(tmpDir, '.owner', 'config.yaml');
        const openSpecRoot =
          artifactLayout === 'docs'
            ? path.join(tmpDir, 'docs', 'openspec')
            : path.join(tmpDir, 'openspec');
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(
          configPath,
          [
            'schema: owner.project.v1',
            'default_workflow: pipeline',
            'workflows: [pipeline]',
            'pipeline:',
            `  artifact_layout: ${artifactLayout}`,
            '',
          ].join('\n'),
          'utf8',
        );
        await fs.mkdir(path.join(openSpecRoot, 'changes', 'archive'), { recursive: true });
        await fs.mkdir(path.join(openSpecRoot, 'specs'), { recursive: true });
        await fs.writeFile(path.join(openSpecRoot, 'config.yaml'), 'schema: spec-driven\n', 'utf8');
        await fs.writeFile(path.join(openSpecRoot, 'specs', 'user.md'), '# Keep\n', 'utf8');
        await fs.mkdir(path.join(tmpDir, 'docs', 'superpowers', 'specs'), {
          recursive: true,
        });
        await fs.mkdir(path.join(tmpDir, 'docs', 'superpowers', 'plans'), {
          recursive: true,
        });

        const result = await removeWorkingDirs(tmpDir);

        expect(result).toEqual({ removed: 1, failed: 0 });
        await expect(fs.stat(path.join(tmpDir, '.owner'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
        await expect(fs.readFile(path.join(openSpecRoot, 'config.yaml'), 'utf8')).resolves.toBe(
          'schema: spec-driven\n',
        );
        await expect(
          fs.readFile(path.join(openSpecRoot, 'specs', 'user.md'), 'utf8'),
        ).resolves.toBe('# Keep\n');
        await expect(fs.stat(path.join(tmpDir, 'docs', 'superpowers'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      },
    );

    it('removes the standard empty Loop-only docs tree', async () => {
      await writeLoopProjectConfig('docs');
      const loopRoot = await createLoopWorkingTree('docs');

      const result = await removeWorkingDirs(tmpDir);

      expect(result).toEqual({ removed: 1, failed: 0 });
      expect(await fileExists(path.join(tmpDir, '.owner'))).toBe(false);
      expect(await fileExists(loopRoot)).toBe(false);
      expect(await fileExists(path.join(tmpDir, 'docs'))).toBe(false);
    });

    it('removes the standard empty Loop tree from an explicit artifact root', async () => {
      await writeLoopProjectConfig('product-artifacts');
      const loopRoot = await createLoopWorkingTree('product-artifacts');

      const result = await removeWorkingDirs(tmpDir);

      expect(result).toEqual({ removed: 1, failed: 0 });
      expect(await fileExists(path.join(tmpDir, '.owner'))).toBe(false);
      expect(await fileExists(loopRoot)).toBe(false);
    });

    it('removes the combined empty Pipeline and Loop docs tree', async () => {
      await writeLoopProjectConfig('docs', 'both');
      await createLoopWorkingTree('docs');
      await fs.mkdir(path.join(tmpDir, 'docs', 'openspec', 'changes', 'archive'), {
        recursive: true,
      });
      await fs.mkdir(path.join(tmpDir, 'docs', 'openspec', 'specs'), { recursive: true });
      await fs.mkdir(path.join(tmpDir, 'docs', 'superpowers', 'reports'), { recursive: true });

      const result = await removeWorkingDirs(tmpDir);

      expect(result).toEqual({ removed: 1, failed: 0 });
      expect(await fileExists(path.join(tmpDir, '.owner'))).toBe(false);
      expect(await fileExists(path.join(tmpDir, 'docs'))).toBe(false);
    });

    it.each(['artifact', 'unknown', 'special'] as const)(
      'preserves Loop working directories containing %s content',
      async (contentKind) => {
        const configPath = await writeLoopProjectConfig('docs');
        const loopRoot = await createLoopWorkingTree('docs');
        const external = path.join(tmpDir, 'external-loop-content');
        await fs.mkdir(external, { recursive: true });
        await fs.writeFile(path.join(external, 'marker.txt'), 'external marker\n', 'utf8');

        let retainedPath: string;
        if (contentKind === 'artifact') {
          retainedPath = path.join(loopRoot, 'changes', 'active-change.json');
          await fs.writeFile(retainedPath, '{}\n', 'utf8');
        } else if (contentKind === 'unknown') {
          retainedPath = path.join(loopRoot, 'user-notes');
          await fs.mkdir(retainedPath);
        } else {
          retainedPath = path.join(loopRoot, 'runtime', 'locks');
          await fs.rmdir(retainedPath);
          await fs.symlink(
            external,
            retainedPath,
            process.platform === 'win32' ? 'junction' : 'dir',
          );
        }

        const result = await removeWorkingDirs(tmpDir);

        const configRemoved = contentKind !== 'special';
        if (configRemoved) {
          expect(result).toEqual({
            removed: 1,
            failed: 0,
            preserved: [retainedPath],
          });
        } else {
          expect(result).toMatchObject({ removed: 0, failed: 1 });
          expect(result.reason).toContain('Refusing to remove non-directory working object');
        }
        if (configRemoved) {
          await expect(fs.stat(configPath)).rejects.toMatchObject({ code: 'ENOENT' });
        } else {
          await expect(fs.stat(configPath)).resolves.toBeDefined();
        }
        await expect(fs.lstat(loopRoot)).resolves.toBeDefined();
        await expect(fs.lstat(retainedPath)).resolves.toBeDefined();
        await expect(fs.readFile(path.join(external, 'marker.txt'), 'utf8')).resolves.toBe(
          'external marker\n',
        );
      },
    );

    it('rejects a managed-directory replacement after inspection without reading the junction target', async () => {
      const configPath = await writeLoopProjectConfig('docs');
      const loopRoot = await createLoopWorkingTree('docs');
      const changesDir = path.join(loopRoot, 'changes');
      const preservedChanges = path.join(tmpDir, 'preserved-loop-changes');
      const external = path.join(tmpDir, 'external-replacement');
      const marker = path.join(external, 'marker.txt');
      await fs.mkdir(external, { recursive: true });
      await fs.writeFile(marker, 'external marker\n', 'utf8');
      let replaced = false;
      const readdirSpy = vi.spyOn(fs, 'readdir');
      let callsBeforeReplacement = 0;

      try {
        const result = await removeWorkingDirs(tmpDir, {
          testHooks: {
            afterPlanInspection: async () => {
              callsBeforeReplacement = readdirSpy.mock.calls.length;
              replaced = true;
              await fs.rename(changesDir, preservedChanges);
              await fs.symlink(
                external,
                changesDir,
                process.platform === 'win32' ? 'junction' : 'dir',
              );
            },
          },
        });

        expect(replaced).toBe(true);
        expect(result).toMatchObject({ removed: 0, failed: 1 });
        expect(
          readdirSpy.mock.calls
            .slice(callsBeforeReplacement)
            .some(([target]) => path.resolve(String(target)) === path.resolve(changesDir)),
        ).toBe(false);
        await expect(fs.stat(configPath)).resolves.toBeDefined();
        await expect(fs.lstat(loopRoot)).resolves.toBeDefined();
        expect((await fs.lstat(changesDir)).isSymbolicLink()).toBe(true);
        await expect(fs.stat(preservedChanges)).resolves.toBeDefined();
        await expect(fs.readFile(marker, 'utf8')).resolves.toBe('external marker\n');
      } finally {
        readdirSpy.mockRestore();
      }
    });

    it('preserves non-empty docs directories', async () => {
      const configPath = path.join(tmpDir, '.owner', 'config.yaml');
      const legacyRoot = path.join(tmpDir, 'openspec');
      const specsDir = path.join(tmpDir, 'docs', 'superpowers', 'specs');
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, 'pipeline:\n  artifact_layout: legacy\n', 'utf8');
      await fs.mkdir(path.join(legacyRoot, 'changes', 'archive'), { recursive: true });
      await fs.mkdir(path.join(legacyRoot, 'specs'), { recursive: true });
      await fs.mkdir(specsDir, { recursive: true });
      await fs.writeFile(path.join(specsDir, 'important.md'), 'keep me', 'utf-8');

      const result = await removeWorkingDirs(tmpDir);

      expect(result).toEqual({
        removed: 1,
        failed: 0,
        preserved: [path.join(specsDir, 'important.md')],
      });
      expect(await fileExists(configPath)).toBe(false);
      expect(await fileExists(legacyRoot)).toBe(true);
      expect(await fileExists(path.join(tmpDir, 'docs'))).toBe(true);
      expect(await fileExists(path.join(specsDir, 'important.md'))).toBe(true);
    });

    it('completes cleanup when a prior uninstall removed config and existing docs remain', async () => {
      const preservedDocument = path.join(tmpDir, 'docs', 'ARCHITECTURE.md');
      await fs.mkdir(path.dirname(preservedDocument), { recursive: true });
      await fs.writeFile(preservedDocument, 'keep me', 'utf8');

      const result = await removeWorkingDirs(tmpDir);

      expect(result).toEqual({ removed: 0, failed: 0, preserved: [preservedDocument] });
      await expect(fs.readFile(preservedDocument, 'utf8')).resolves.toBe('keep me');
    });

    it('preserves every working directory when legacy and docs OpenSpec roots both exist', async () => {
      const configPath = path.join(tmpDir, '.owner', 'config.yaml');
      const legacyRoot = path.join(tmpDir, 'openspec');
      const docsRoot = path.join(tmpDir, 'docs', 'openspec');
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, 'pipeline:\n  artifact_layout: legacy\n', 'utf8');
      await fs.mkdir(path.join(legacyRoot, 'changes', 'archive'), { recursive: true });
      await fs.mkdir(path.join(docsRoot, 'changes', 'archive'), { recursive: true });

      const result = await removeWorkingDirs(tmpDir);

      expect(result).toMatchObject({ removed: 0, failed: 1 });
      await expect(fs.stat(configPath)).resolves.toBeDefined();
      await expect(fs.stat(legacyRoot)).resolves.toBeDefined();
      await expect(fs.stat(docsRoot)).resolves.toBeDefined();
    });

    it('preserves every working directory while a Pipeline root move is pending', async () => {
      const ownerDir = path.join(tmpDir, '.owner');
      const configPath = path.join(ownerDir, 'config.yaml');
      const journalPath = path.join(ownerDir, 'pipeline-root-move.json');
      const legacyRoot = path.join(tmpDir, 'openspec');
      await fs.mkdir(ownerDir, { recursive: true });
      await fs.writeFile(configPath, 'pipeline:\n  artifact_layout: legacy\n', 'utf8');
      await fs.writeFile(journalPath, '{}\n', 'utf8');
      await fs.mkdir(path.join(legacyRoot, 'changes', 'archive'), { recursive: true });
      await fs.mkdir(path.join(legacyRoot, 'specs'), { recursive: true });

      const result = await removeWorkingDirs(tmpDir);

      expect(result).toMatchObject({ removed: 0, failed: 1 });
      await expect(fs.stat(configPath)).resolves.toBeDefined();
      await expect(fs.stat(journalPath)).resolves.toBeDefined();
      await expect(fs.stat(legacyRoot)).resolves.toBeDefined();
    });

    it('preserves every working directory when .owner contains unknown user content', async () => {
      const ownerDir = path.join(tmpDir, '.owner');
      const configPath = path.join(ownerDir, 'config.yaml');
      const userFile = path.join(ownerDir, 'user-notes.md');
      const legacyRoot = path.join(tmpDir, 'openspec');
      await fs.mkdir(ownerDir, { recursive: true });
      await fs.writeFile(configPath, 'pipeline:\n  artifact_layout: legacy\n', 'utf8');
      await fs.writeFile(userFile, 'keep me\n', 'utf8');
      await fs.mkdir(path.join(legacyRoot, 'changes', 'archive'), { recursive: true });
      await fs.mkdir(path.join(legacyRoot, 'specs'), { recursive: true });

      const result = await removeWorkingDirs(tmpDir);

      expect(result).toMatchObject({ removed: 0, failed: 1 });
      await expect(fs.stat(configPath)).resolves.toBeDefined();
      await expect(fs.stat(userFile)).resolves.toBeDefined();
      await expect(fs.stat(legacyRoot)).resolves.toBeDefined();
    });

    it('preserves every working directory when Pipeline config is invalid', async () => {
      const configPath = path.join(tmpDir, '.owner', 'config.yaml');
      const legacyRoot = path.join(tmpDir, 'openspec');
      const docsRoot = path.join(tmpDir, 'docs', 'openspec');
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, 'pipeline: invalid\n', 'utf8');
      await fs.mkdir(legacyRoot, { recursive: true });
      await fs.mkdir(docsRoot, { recursive: true });

      const result = await removeWorkingDirs(tmpDir);

      expect(result).toMatchObject({ removed: 0, failed: 1 });
      await expect(fs.stat(configPath)).resolves.toBeDefined();
      await expect(fs.stat(legacyRoot)).resolves.toBeDefined();
      await expect(fs.stat(docsRoot)).resolves.toBeDefined();
    });

    it('preserves every working directory when the full project config is malformed', async () => {
      const configPath = path.join(tmpDir, '.owner', 'config.yaml');
      const legacyRoot = path.join(tmpDir, 'openspec');
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, 'schema: [broken\n', 'utf8');
      await fs.mkdir(legacyRoot, { recursive: true });

      const result = await removeWorkingDirs(tmpDir);

      expect(result).toMatchObject({ removed: 0, failed: 1 });
      await expect(fs.stat(configPath)).resolves.toBeDefined();
      await expect(fs.stat(legacyRoot)).resolves.toBeDefined();
    });

    it('preserves special layout objects instead of following or unlinking them', async () => {
      const configPath = path.join(tmpDir, '.owner', 'config.yaml');
      const target = path.join(tmpDir, 'user-open-spec-target');
      const link = path.join(tmpDir, 'openspec');
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, 'pipeline:\n  artifact_layout: legacy\n', 'utf8');
      await fs.mkdir(target, { recursive: true });
      await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');

      const result = await removeWorkingDirs(tmpDir);

      expect(result).toMatchObject({ removed: 0, failed: 1 });
      await expect(fs.stat(configPath)).resolves.toBeDefined();
      expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
      await expect(fs.stat(target)).resolves.toBeDefined();
    });

    it('uses bounded bottom-up removal instead of recursive working-tree deletion', async () => {
      const source = await fs.readFile(path.resolve('domains/skill/uninstall.ts'), 'utf8');
      const start = source.indexOf('async function removeWorkingDirs');
      const end = source.indexOf('\\nexport {', start);
      const implementation = source.slice(start, end);

      expect(implementation).toContain('removeManagedWorkingTree');
      expect(implementation).not.toContain('removeDir(directory)');
    });
  });

  describe('full uninstall cycle', () => {
    it('installs and then completely removes Owner for Claude Code', async () => {
      const claudePlatform: Platform = PLATFORMS.find((p) => p.id === 'claude')!;

      // Install everything
      await copyOwnerSkillsForPlatform(tmpDir, claudePlatform, true, 'skills', 'project');
      await copyOwnerRulesForPlatform(tmpDir, claudePlatform, true, 'zh', 'project');
      await installOwnerHooksForPlatform(tmpDir, claudePlatform, 'project');

      // Verify installation
      const skillsDir = path.join(tmpDir, '.claude', 'skills');
      const skillEntries = (await fs.readdir(skillsDir)).filter((e) => e.startsWith('owner'));
      expect(skillEntries.length).toBeGreaterThan(0);

      const rulePath = path.join(tmpDir, '.claude', 'rules', 'owner-workflow-guard.md');
      expect(await fileExists(rulePath)).toBe(true);

      // Uninstall everything
      const skillsResult = await removeOwnerSkillsForPlatform(tmpDir, claudePlatform, 'project');
      expect(skillsResult.removed).toBeGreaterThan(0);

      const rulesResult = await removeOwnerRulesForPlatform(tmpDir, claudePlatform, 'project');
      expect(rulesResult.removed).toBeGreaterThan(0);

      const hooksResult = await removeOwnerHooksForPlatform(tmpDir, claudePlatform, 'project');
      expect(hooksResult.removed).toBeGreaterThan(0);

      // Verify complete removal
      for (const entry of skillEntries) {
        expect(await fileExists(path.join(skillsDir, entry))).toBe(false);
      }
      expect(await fileExists(rulePath)).toBe(false);
    });
  });
});

// --- uninstallCommand interactive selection tests ---

vi.mock('@inquirer/prompts', () => ({
  select: vi.fn().mockResolvedValue(true),
  checkbox: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../app/commands/platform-select-prompt.js', () => ({
  platformSelectPrompt: vi.fn(),
}));

import { select, checkbox } from '@inquirer/prompts';
import { platformSelectPrompt } from '../../app/commands/platform-select-prompt.js';
import { uninstallCommand } from '../../app/commands/uninstall.js';

const mockedSelect = vi.mocked(select);
const mockedCheckbox = vi.mocked(checkbox);
const mockedPlatformSelectPrompt = vi.mocked(platformSelectPrompt);

describe('uninstallCommand interactive selection', () => {
  let tmpDir: string;

  let homedirSpy: MockInstance<typeof os.homedir>;

  beforeEach(async () => {
    mockedSelect.mockReset();
    mockedCheckbox.mockReset();
    mockedPlatformSelectPrompt.mockReset();
    mockedSelect.mockResolvedValue(true as never);
    mockedPlatformSelectPrompt.mockImplementation(async (config) =>
      config.choices.filter((choice) => choice.checked === true).map((choice) => choice.value),
    );
    const temporaryRoot = await fs.realpath(os.tmpdir());
    tmpDir = path.join(
      temporaryRoot,
      `owner-uninstall-cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(tmpDir, { recursive: true });

    const fakeHome = path.join(tmpDir, 'fake-home');
    await fs.mkdir(fakeHome, { recursive: true });
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  });

  afterEach(async () => {
    homedirSpy.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('uninstalls an explicitly scoped canonical global Codex install without a detection path', async () => {
    const fakeHome = path.join(tmpDir, 'fake-home');
    const codexPlatform = PLATFORMS.find((platform) => platform.id === 'codex')!;
    await copyOwnerSkillsForPlatform(fakeHome, codexPlatform, true, 'skills', 'global');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let jsonOutput: string;
    try {
      await uninstallCommand(tmpDir, { scope: 'global', force: true, json: true });
      jsonOutput = log.mock.calls.map((call) => call.join(' ')).join('\n');
    } finally {
      log.mockRestore();
    }

    expect(JSON.parse(jsonOutput).targets).toEqual([
      expect.objectContaining({ scope: 'global', platform: 'codex' }),
    ]);
    await expect(
      fs.access(path.join(fakeHome, '.agents', 'skills', 'owner')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not apply project registry recovery targets to an explicit global uninstall', async () => {
    const fakeHome = path.join(tmpDir, 'global-scope-recovery-home');
    const claude = PLATFORMS.find((platform) => platform.id === 'claude')!;
    const projectSkill = path.join(tmpDir, '.claude', 'skills', 'owner', 'SKILL.md');
    await copyOwnerSkillsForPlatform(tmpDir, claude, true, 'skills', 'project');
    await upsertProjectInstallation(tmpDir, [{ platform: 'claude', language: 'en' }], 'init', {
      homeDir: fakeHome,
    });
    homedirSpy.mockRestore();
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await uninstallCommand(tmpDir, { scope: 'global', force: true, json: true });
      const result = JSON.parse(log.mock.calls.map((call) => call.join(' ')).join('\n'));
      expect(result.targets).toEqual([]);
    } finally {
      log.mockRestore();
    }

    await expect(fs.access(projectSkill)).resolves.toBeUndefined();
    const registry = JSON.parse(await fs.readFile(getProjectRegistryPath(fakeHome), 'utf8')) as {
      projects: unknown[];
    };
    expect(registry.projects).toHaveLength(1);
  });

  it('does not auto-detect Codex from a shared canonical global Skill root', async () => {
    const fakeHome = path.join(tmpDir, 'fake-home');
    const codexPlatform = PLATFORMS.find((platform) => platform.id === 'codex')!;
    await copyOwnerSkillsForPlatform(fakeHome, codexPlatform, true, 'skills', 'global');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await uninstallCommand(tmpDir, { force: true, json: true });
    } finally {
      log.mockRestore();
    }

    await expect(
      fs.access(path.join(fakeHome, '.agents', 'skills', 'owner')),
    ).resolves.toBeUndefined();
  });

  it('uninstalls all indexed projects with --all-projects --force --json', async () => {
    const fakeHome = path.join(tmpDir, 'fake-home-all-uninstall');
    const projectA = path.join(tmpDir, 'project-a');
    const projectB = path.join(tmpDir, 'project-b');
    const claudePlatform = PLATFORMS.find((p) => p.id === 'claude')!;

    for (const project of [projectA, projectB]) {
      await copyOwnerSkillsForPlatform(project, claudePlatform, true, 'skills', 'project');
      await upsertProjectInstallation(project, [{ platform: 'claude', language: 'en' }], 'init', {
        homeDir: fakeHome,
      });
    }

    homedirSpy.mockRestore();
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let jsonOutput: string;
    try {
      await uninstallCommand(projectA, { allProjects: true, force: true, json: true });
      jsonOutput = log.mock.calls.map((c) => c.join(' ')).join('\n');
    } finally {
      log.mockRestore();
    }

    const result = JSON.parse(jsonOutput);
    expect(result.mode).toBe('all-projects');
    expect(
      result.projects.every((project: { status: string }) => project.status === 'uninstalled'),
    ).toBe(true);
    await expect(
      fs.access(path.join(projectA, '.claude', 'skills', 'owner')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      fs.access(path.join(projectB, '.claude', 'skills', 'owner')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const registry = JSON.parse(await fs.readFile(getProjectRegistryPath(fakeHome), 'utf-8'));
    expect(registry.projects).toEqual([]);
  });

  it('applies one workflow selection across all indexed projects', async () => {
    const fakeHome = path.join(tmpDir, 'fake-home-all-workflow-selection');
    const projectA = path.join(tmpDir, 'project-a-workflow-selection');
    const projectB = path.join(tmpDir, 'project-b-workflow-selection');
    const claudePlatform = PLATFORMS.find((p) => p.id === 'claude')!;

    for (const project of [projectA, projectB]) {
      await copyOwnerSkillsForPlatform(project, claudePlatform, true, 'skills', 'project');
      await upsertProjectInstallation(project, [{ platform: 'claude', language: 'en' }], 'init', {
        homeDir: fakeHome,
      });
    }

    homedirSpy.mockRestore();
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    mockedSelect.mockResolvedValue(true as never);
    mockedCheckbox.mockResolvedValueOnce(['loop'] as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await uninstallCommand(projectA, { allProjects: true });
    } finally {
      log.mockRestore();
    }

    expect(mockedCheckbox).toHaveBeenCalledTimes(1);
    for (const project of [projectA, projectB]) {
      await expect(
        fs.access(path.join(project, '.claude', 'skills', 'owner-loop', 'SKILL.md')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        fs.access(path.join(project, '.claude', 'skills', 'owner-pipeline', 'SKILL.md')),
      ).resolves.toBeUndefined();
    }
  });

  it('applies one detected-platform choice across all indexed projects', async () => {
    const fakeHome = path.join(tmpDir, 'fake-home-all-platform-selection');
    const projectA = path.join(tmpDir, 'project-a-platform-selection');
    const projectB = path.join(tmpDir, 'project-b-platform-selection');
    const claudePlatform = PLATFORMS.find((p) => p.id === 'claude')!;
    const codexPlatform = PLATFORMS.find((p) => p.id === 'codex')!;

    for (const project of [projectA, projectB]) {
      await copyOwnerSkillsForPlatform(project, claudePlatform, true, 'skills', 'project');
      await copyOwnerSkillsForPlatform(project, codexPlatform, true, 'skills', 'project');
      await upsertProjectInstallation(
        project,
        [
          { platform: 'claude', language: 'en' },
          { platform: 'codex', language: 'en' },
        ],
        'init',
        { homeDir: fakeHome },
      );
    }

    homedirSpy.mockRestore();
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    mockedSelect.mockResolvedValue(true as never);
    mockedPlatformSelectPrompt.mockResolvedValueOnce(['claude']);
    mockedCheckbox.mockResolvedValueOnce(['loop'] as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await uninstallCommand(projectA, { allProjects: true });
    } finally {
      log.mockRestore();
    }

    for (const project of [projectA, projectB]) {
      await expect(
        fs.access(path.join(project, '.claude', 'skills', 'owner-loop', 'SKILL.md')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        fs.access(path.join(project, '.agents', 'skills', 'owner-loop', 'SKILL.md')),
      ).resolves.toBeUndefined();
    }
  });

  it('removes Hook then Rule but keeps the Skill retry anchor when canonical Hook cleanup fails', async () => {
    const fakeHome = path.join(tmpDir, 'hook-failure-home');
    const codex = PLATFORMS.find((platform) => platform.id === 'codex')!;
    await fs.mkdir(path.join(tmpDir, '.codex'), { recursive: true });
    await copyOwnerSkillsForPlatform(tmpDir, codex, true, 'skills', 'project');
    await copyOwnerRulesForPlatform(tmpDir, codex, true, 'en', 'project');
    await fs.writeFile(path.join(tmpDir, '.codex', 'hooks.json'), '[]\n', 'utf8');
    await upsertProjectInstallation(tmpDir, [{ platform: 'codex', language: 'en' }], 'init', {
      homeDir: fakeHome,
    });
    homedirSpy.mockRestore();
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await uninstallCommand(tmpDir, { force: true, json: true });
      const result = JSON.parse(log.mock.calls.map((call) => call.join(' ')).join('\n'));
      expect(result.targets[0]).toMatchObject({
        platform: 'codex',
        hooksFailed: 1,
        rulesRemoved: 1,
        skillsRemoved: 0,
      });
      expect(result.summary.totalFailures).toBeGreaterThan(0);
    } finally {
      log.mockRestore();
    }

    await expect(
      fs.access(path.join(tmpDir, '.agents', 'skills', 'owner', 'SKILL.md')),
    ).resolves.toBeUndefined();
  });

  it('keeps the Skill retry anchor when canonical Rule cleanup fails after Hook removal', async () => {
    const fakeHome = path.join(tmpDir, 'rule-failure-home');
    const codex = PLATFORMS.find((platform) => platform.id === 'codex')!;
    await fs.mkdir(path.join(tmpDir, '.codex'), { recursive: true });
    await copyOwnerSkillsForPlatform(tmpDir, codex, true, 'skills', 'project');
    await copyOwnerRulesForPlatform(tmpDir, codex, true, 'en', 'project');
    await installOwnerHooksForPlatform(tmpDir, codex, 'project');
    const rulePath = path.join(tmpDir, '.codex', 'rules', 'owner-phase-guard.md');
    const unlink = fs.unlink.bind(fs);
    const permissionError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const unlinkSpy = vi.spyOn(fs, 'unlink').mockImplementation(async (filePath) => {
      if (path.resolve(String(filePath)) === path.resolve(rulePath)) throw permissionError;
      await unlink(filePath);
    });
    await upsertProjectInstallation(tmpDir, [{ platform: 'codex', language: 'en' }], 'init', {
      homeDir: fakeHome,
    });
    homedirSpy.mockRestore();
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await uninstallCommand(tmpDir, { force: true, json: true });
      const result = JSON.parse(log.mock.calls.map((call) => call.join(' ')).join('\n'));
      expect(result.targets[0]).toMatchObject({
        platform: 'codex',
        hooksRemoved: 1,
        rulesFailed: 1,
        skillsRemoved: 0,
      });
    } finally {
      unlinkSpy.mockRestore();
      log.mockRestore();
    }

    await expect(
      fs.access(path.join(tmpDir, '.agents', 'skills', 'owner', 'SKILL.md')),
    ).resolves.toBeUndefined();
  });

  it('counts working-directory cleanup failure and keeps the project registry entry', async () => {
    const fakeHome = path.join(tmpDir, 'working-dir-failure-home');
    const claude = PLATFORMS.find((platform) => platform.id === 'claude')!;
    await copyOwnerSkillsForPlatform(tmpDir, claude, true, 'skills', 'project');
    await fs.mkdir(path.join(tmpDir, '.owner'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.owner', 'config.yaml'), 'test: true\n', 'utf8');
    await upsertProjectInstallation(tmpDir, [{ platform: 'claude', language: 'en' }], 'init', {
      homeDir: fakeHome,
    });
    homedirSpy.mockRestore();
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    const rmdir = fs.rmdir.bind(fs);
    const permissionError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    rmdirMock.mockImplementation(async (targetPath, options) => {
      if (path.resolve(String(targetPath)) === path.resolve(path.join(tmpDir, '.owner'))) {
        throw permissionError;
      }
      await rmdir(targetPath, options);
    });

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await uninstallCommand(tmpDir, { force: true, json: true });
      const result = JSON.parse(log.mock.calls.map((call) => call.join(' ')).join('\n'));
      expect(result.summary.totalFailures).toBe(1);
    } finally {
      rmdirMock.mockImplementation(rmdir);
      log.mockRestore();
    }

    const registry = JSON.parse(await fs.readFile(getProjectRegistryPath(fakeHome), 'utf8')) as {
      projects: unknown[];
    };
    expect(registry.projects).toHaveLength(1);
    await expect(fs.readFile(path.join(tmpDir, '.owner', 'config.yaml'), 'utf8')).resolves.toBe(
      'test: true\n',
    );
  });

  it('retries registered project cleanup after the Skill target was removed on the first attempt', async () => {
    const fakeHome = path.join(tmpDir, 'working-dir-retry-home');
    const claude = PLATFORMS.find((platform) => platform.id === 'claude')!;
    await copyOwnerSkillsForPlatform(tmpDir, claude, true, 'skills', 'project');
    await fs.mkdir(path.join(tmpDir, '.owner'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.owner', 'config.yaml'), 'test: true\n', 'utf8');
    await upsertProjectInstallation(tmpDir, [{ platform: 'claude', language: 'en' }], 'init', {
      homeDir: fakeHome,
    });
    homedirSpy.mockRestore();
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    const rmdir = fs.rmdir.bind(fs);
    let ownerRemovalAttempts = 0;
    const permissionError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    rmdirMock.mockImplementation(async (targetPath, options) => {
      if (path.resolve(String(targetPath)) === path.resolve(path.join(tmpDir, '.owner'))) {
        ownerRemovalAttempts++;
        if (ownerRemovalAttempts === 1) throw permissionError;
      }
      await rmdir(targetPath, options);
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await uninstallCommand(tmpDir, { force: true, json: true });
      const firstResult = JSON.parse(log.mock.calls.map((call) => call.join(' ')).join('\n'));
      expect(firstResult.summary.totalFailures).toBe(1);
      const retainedRegistry = JSON.parse(
        await fs.readFile(getProjectRegistryPath(fakeHome), 'utf8'),
      ) as { projects: unknown[] };
      expect(retainedRegistry.projects).toHaveLength(1);
      log.mockClear();
      await uninstallCommand(tmpDir, { force: true, json: true });
      const retryResult = JSON.parse(log.mock.calls.map((call) => call.join(' ')).join('\n'));
      expect(retryResult.summary).toMatchObject({ targetsProcessed: 1, totalFailures: 0 });
      expect(retryResult.workingDirsRemoved).toBe(1);
    } finally {
      log.mockRestore();
      rmdirMock.mockImplementation(rmdir);
    }

    expect(ownerRemovalAttempts).toBe(2);
    await expect(fs.access(path.join(tmpDir, '.owner'))).rejects.toMatchObject({ code: 'ENOENT' });
    const registry = JSON.parse(await fs.readFile(getProjectRegistryPath(fakeHome), 'utf8')) as {
      projects: unknown[];
    };
    expect(registry.projects).toEqual([]);
  });

  it('matches a registered current project through its canonical symlink identity', async () => {
    const fakeHome = path.join(tmpDir, 'canonical-recovery-home');
    const realProject = path.join(tmpDir, 'canonical-real-project');
    const projectAlias = path.join(tmpDir, 'canonical-project-alias');
    await fs.mkdir(path.join(realProject, '.owner'), { recursive: true });
    await fs.writeFile(path.join(realProject, '.owner', 'config.yaml'), 'test: true\n', 'utf8');
    await fs.symlink(realProject, projectAlias, process.platform === 'win32' ? 'junction' : 'dir');
    await upsertProjectInstallation(realProject, [{ platform: 'claude', language: 'en' }], 'init', {
      homeDir: fakeHome,
    });
    homedirSpy.mockRestore();
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await uninstallCommand(projectAlias, { currentProject: true, force: true, json: true });
      const result = JSON.parse(log.mock.calls.map((call) => call.join(' ')).join('\n'));
      expect(result.summary).toMatchObject({ targetsProcessed: 1, totalFailures: 0 });
      expect(result.workingDirsRemoved).toBe(1);
    } finally {
      log.mockRestore();
    }

    await expect(fs.access(path.join(realProject, '.owner'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const registry = JSON.parse(await fs.readFile(getProjectRegistryPath(fakeHome), 'utf8')) as {
      projects: unknown[];
    };
    expect(registry.projects).toEqual([]);
  });

  it('keeps detected global and recovered project targets separate for the same platform', async () => {
    const fakeHome = path.join(tmpDir, 'detected-global-recovery-project-home');
    const codex = PLATFORMS.find((platform) => platform.id === 'codex')!;
    await copyOwnerSkillsForPlatform(tmpDir, codex, true, 'skills', 'project');
    await fs.rm(path.join(tmpDir, '.agents', 'skills'), { recursive: true, force: true });
    await copyOwnerSkillsForPlatform(fakeHome, codex, true, 'skills', 'global');
    await upsertProjectInstallation(tmpDir, [{ platform: 'codex', language: 'en' }], 'init', {
      homeDir: fakeHome,
    });
    homedirSpy.mockRestore();
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await uninstallCommand(tmpDir, { currentProject: true, force: true, json: true });
      const result = JSON.parse(log.mock.calls.map((call) => call.join(' ')).join('\n'));
      expect(result.summary).toMatchObject({ targetsProcessed: 1, totalFailures: 0 });
      expect(
        result.targets.map((target: { scope: string; platform: string }) => ({
          scope: target.scope,
          platform: target.platform,
        })),
      ).toEqual([{ scope: 'project', platform: 'codex' }]);
    } finally {
      log.mockRestore();
    }

    await expect(
      fs.access(path.join(fakeHome, getPlatformSkillsDir(codex, 'global'), 'skills', 'owner')),
    ).resolves.toBeUndefined();
    const registry = JSON.parse(await fs.readFile(getProjectRegistryPath(fakeHome), 'utf8')) as {
      projects: unknown[];
    };
    expect(registry.projects).toEqual([]);
  });

  it('runs follow-on cleanup for an all-projects registry entry with no remaining Skill target', async () => {
    const fakeHome = path.join(tmpDir, 'all-projects-stale-home');
    const project = path.join(tmpDir, 'all-projects-stale-project');
    await fs.mkdir(path.join(project, '.owner'), { recursive: true });
    await fs.writeFile(path.join(project, '.owner', 'config.yaml'), 'test: true\n', 'utf8');
    await fs.writeFile(
      path.join(project, 'AGENTS.md'),
      '<owner-ambient-resume>\nmanaged\n</owner-ambient-resume>\n',
      'utf8',
    );
    await upsertProjectInstallation(project, [{ platform: 'claude', language: 'en' }], 'init', {
      homeDir: fakeHome,
    });
    homedirSpy.mockRestore();
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await uninstallCommand(project, { allProjects: true, force: true, json: true });
      const result = JSON.parse(log.mock.calls.map((call) => call.join(' ')).join('\n'));
      expect(result.projects[0]).toMatchObject({
        projectPath: path.resolve(project),
        status: 'uninstalled',
        workingDirsRemoved: 1,
        projectInstructionsRemoved: 1,
      });
    } finally {
      log.mockRestore();
    }

    await expect(fs.access(path.join(project, '.owner'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(path.join(project, 'AGENTS.md'), 'utf8')).resolves.not.toContain(
      'owner-ambient-resume',
    );
    const registry = JSON.parse(await fs.readFile(getProjectRegistryPath(fakeHome), 'utf8')) as {
      projects: unknown[];
    };
    expect(registry.projects).toEqual([]);
  });

  it.each([true, false])(
    'reports canonical Codex cleanup refusal and preserves project state in %s output',
    async (json) => {
      const fakeHome = path.join(tmpDir, `failure-home-${json}`);
      const sharedSkills = path.join(tmpDir, `failure-shared-skills-${json}`);
      await fs.mkdir(path.join(sharedSkills, 'owner'), { recursive: true });
      await fs.writeFile(path.join(sharedSkills, 'owner', 'SKILL.md'), '# Owner\n');
      await fs.mkdir(path.join(tmpDir, '.agents'), { recursive: true });
      await fs.symlink(
        sharedSkills,
        path.join(tmpDir, '.agents', 'skills'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      await fs.mkdir(path.join(tmpDir, '.codex', 'rules'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, '.codex', 'rules', 'owner-phase-guard.md'), '# Rule\n');
      await fs.writeFile(
        path.join(tmpDir, 'AGENTS.md'),
        '<owner-ambient-resume>keep</owner-ambient-resume>\n',
      );
      await fs.mkdir(path.join(tmpDir, '.owner'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, '.owner', 'state'), 'keep\n');
      await upsertProjectInstallation(tmpDir, [{ platform: 'codex', language: 'en' }], 'init', {
        homeDir: fakeHome,
      });
      homedirSpy.mockRestore();
      homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        await uninstallCommand(tmpDir, { force: true, json });
        const output = log.mock.calls.map((call) => call.join(' ')).join('\n');
        if (json) {
          const result = JSON.parse(output);
          expect(result.targets[0].skillsFailed).toBeGreaterThan(0);
          expect(result.summary.totalFailures).toBeGreaterThan(0);
        } else {
          expect(output).toMatch(/incomplete|failed/iu);
        }
      } finally {
        log.mockRestore();
      }

      await expect(
        fs.access(path.join(tmpDir, '.codex', 'rules', 'owner-phase-guard.md')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.readFile(path.join(tmpDir, 'AGENTS.md'), 'utf8')).resolves.toContain(
        'owner-ambient-resume',
      );
      await expect(fs.readFile(path.join(tmpDir, '.owner', 'state'), 'utf8')).resolves.toBe(
        'keep\n',
      );
      const registry = JSON.parse(await fs.readFile(getProjectRegistryPath(fakeHome), 'utf8'));
      expect(registry.projects).toHaveLength(1);
    },
  );

  it('removes Rules before preserving a legacy-only Codex Skill root that refuses removal', async () => {
    const sharedSkills = path.join(tmpDir, 'legacy-only-shared-skills');
    await fs.mkdir(path.join(sharedSkills, 'owner'), { recursive: true });
    await fs.writeFile(path.join(sharedSkills, 'owner', 'SKILL.md'), '# Legacy Owner\n');
    await fs.mkdir(path.join(tmpDir, '.codex', 'rules'), { recursive: true });
    await fs.symlink(
      sharedSkills,
      path.join(tmpDir, '.codex', 'skills'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await fs.writeFile(
      path.join(tmpDir, '.codex', 'rules', 'owner-phase-guard.md'),
      '# Keep Rule\n',
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await uninstallCommand(tmpDir, { force: true, json: true });
      const result = JSON.parse(log.mock.calls.map((call) => call.join(' ')).join('\n'));
      expect(result.targets[0]).toMatchObject({ platform: 'codex', skillsFailed: 1 });
      expect(result.summary.totalFailures).toBeGreaterThan(0);
    } finally {
      log.mockRestore();
    }
    await expect(
      fs.access(path.join(tmpDir, '.codex', 'rules', 'owner-phase-guard.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(path.join(tmpDir, '.codex', 'skills'))).resolves.toMatchObject({});
  });

  it('does not mark all-projects uninstall complete when canonical cleanup is refused', async () => {
    const fakeHome = path.join(tmpDir, 'all-projects-failure-home');
    const project = path.join(tmpDir, 'all-projects-failure-project');
    const sharedSkills = path.join(tmpDir, 'all-projects-failure-skills');
    await fs.mkdir(path.join(sharedSkills, 'owner'), { recursive: true });
    await fs.writeFile(path.join(sharedSkills, 'owner', 'SKILL.md'), '# Owner\n');
    await fs.mkdir(path.join(project, '.agents'), { recursive: true });
    await fs.symlink(
      sharedSkills,
      path.join(project, '.agents', 'skills'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await fs.mkdir(path.join(project, '.codex'), { recursive: true });
    await upsertProjectInstallation(project, [{ platform: 'codex', language: 'en' }], 'init', {
      homeDir: fakeHome,
    });
    homedirSpy.mockRestore();
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await uninstallCommand(project, { allProjects: true, force: true, json: true });
      const result = JSON.parse(log.mock.calls.map((call) => call.join(' ')).join('\n'));
      expect(result.projects[0].status).toBe('failed');
      expect(result.projects[0].summary.totalFailures).toBeGreaterThan(0);
    } finally {
      log.mockRestore();
    }
    const registry = JSON.parse(await fs.readFile(getProjectRegistryPath(fakeHome), 'utf8'));
    expect(registry.projects).toHaveLength(1);
  });

  it('rejects --all-projects with --scope global during uninstall', async () => {
    await expect(
      uninstallCommand(tmpDir, { allProjects: true, scope: 'global', json: true, force: true }),
    ).rejects.toThrow('--all-projects cannot be combined with --scope global');
  });

  it('keeps JSON uninstall current-project by default when registry has projects', async () => {
    const fakeHome = path.join(tmpDir, 'fake-home-current-uninstall');
    const projectA = path.join(tmpDir, 'project-current-uninstall');
    const projectB = path.join(tmpDir, 'project-other-uninstall');
    const claudePlatform = PLATFORMS.find((p) => p.id === 'claude')!;

    await copyOwnerSkillsForPlatform(projectA, claudePlatform, true, 'skills', 'project');
    await copyOwnerSkillsForPlatform(projectB, claudePlatform, true, 'skills', 'project');
    await upsertProjectInstallation(projectA, [{ platform: 'claude', language: 'en' }], 'init', {
      homeDir: fakeHome,
    });
    await upsertProjectInstallation(projectB, [{ platform: 'claude', language: 'en' }], 'init', {
      homeDir: fakeHome,
    });

    homedirSpy.mockRestore();
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let jsonOutput: string;
    try {
      await uninstallCommand(projectA, { json: true, force: true });
      jsonOutput = log.mock.calls.map((c) => c.join(' ')).join('\n');
    } finally {
      log.mockRestore();
    }

    const result = JSON.parse(jsonOutput);
    expect(result.mode).toBeUndefined();
    expect(await fileExists(path.join(projectB, '.claude', 'skills', 'owner'))).toBe(true);
  });

  it('removes the current project from the registry after project-scope JSON uninstall', async () => {
    const fakeHome = path.join(tmpDir, 'fake-home-current-uninstall-refresh');
    const projectA = path.join(tmpDir, 'project-current-uninstall-refresh');
    const projectB = path.join(tmpDir, 'project-other-uninstall-refresh');
    const claudePlatform = PLATFORMS.find((p) => p.id === 'claude')!;

    await copyOwnerSkillsForPlatform(projectA, claudePlatform, true, 'skills', 'project');
    await copyOwnerSkillsForPlatform(projectB, claudePlatform, true, 'skills', 'project');
    await upsertProjectInstallation(projectA, [{ platform: 'claude', language: 'en' }], 'init', {
      homeDir: fakeHome,
    });
    await upsertProjectInstallation(projectB, [{ platform: 'claude', language: 'en' }], 'init', {
      homeDir: fakeHome,
    });

    homedirSpy.mockRestore();
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await uninstallCommand(projectA, { json: true, force: true });
    } finally {
      log.mockRestore();
    }

    const registry = JSON.parse(await fs.readFile(getProjectRegistryPath(fakeHome), 'utf-8')) as {
      projects: Array<{ path: string }>;
    };
    expect(registry.projects.map((project) => project.path)).toEqual([path.resolve(projectB)]);
    expect(await fileExists(path.join(projectB, '.claude', 'skills', 'owner'))).toBe(true);
  });

  it('auto-selects single target and uninstalls on confirmation', async () => {
    const claudePlatform = PLATFORMS.find((p) => p.id === 'claude')!;
    await copyOwnerSkillsForPlatform(tmpDir, claudePlatform, true, 'skills', 'project');

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await uninstallCommand(tmpDir, { force: false });
    } finally {
      log.mockRestore();
    }

    expect(mockedSelect).not.toHaveBeenCalled();
    expect(mockedCheckbox).toHaveBeenCalled();

    const skillsDir = path.join(tmpDir, '.claude', 'skills');
    const entries = (await fs.readdir(skillsDir)).filter((e) => e.startsWith('owner'));
    expect(entries.length).toBe(0);
  });

  it('removes only Pipeline Skills when the user keeps Loop', async () => {
    const claudePlatform = PLATFORMS.find((p) => p.id === 'claude')!;
    await copyOwnerSkillsForPlatform(
      tmpDir,
      claudePlatform,
      true,
      'skills',
      'project',
      'copy',
      'both',
    );
    await fs.mkdir(path.join(tmpDir, '.owner'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, '.owner', 'config.yaml'),
      [
        'schema: owner.project.v1',
        'default_workflow: pipeline',
        'workflows:',
        '  - loop',
        '  - pipeline',
        'ambient_resume: true',
        'loop:',
        '  artifact_root: docs',
        '  language: en',
        'pipeline:',
        '  artifact_layout: docs',
        '  language: en',
        '  context_compression: off',
        '  review_mode: standard',
        '  auto_transition: true',
      ].join('\n'),
      'utf8',
    );
    mockedSelect.mockResolvedValue(true as never);
    mockedCheckbox.mockResolvedValueOnce(['pipeline'] as never).mockResolvedValueOnce([] as never);

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await uninstallCommand(tmpDir);
    } finally {
      log.mockRestore();
    }

    const skillsDir = path.join(tmpDir, '.claude', 'skills');
    expect(await fileExists(path.join(skillsDir, 'owner-loop', 'SKILL.md'))).toBe(true);
    expect(await fileExists(path.join(skillsDir, 'owner-pipeline', 'SKILL.md'))).toBe(false);
    expect(await fileExists(path.join(skillsDir, 'owner', 'SKILL.md'))).toBe(true);
    const config = await fs.readFile(path.join(tmpDir, '.owner', 'config.yaml'), 'utf8');
    expect(config).toContain('default_workflow: loop');
    expect(config).not.toContain('pipeline:');
  });

  it('removes only Loop Skills when the user keeps Pipeline', async () => {
    const claudePlatform = PLATFORMS.find((p) => p.id === 'claude')!;
    await copyOwnerSkillsForPlatform(
      tmpDir,
      claudePlatform,
      true,
      'skills',
      'project',
      'copy',
      'both',
    );
    await fs.mkdir(path.join(tmpDir, '.owner'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, '.owner', 'config.yaml'),
      [
        'schema: owner.project.v1',
        'default_workflow: loop',
        'workflows:',
        '  - loop',
        '  - pipeline',
        'ambient_resume: true',
        'loop:',
        '  artifact_root: .owner/loop',
        '  language: en',
        'pipeline:',
        '  artifact_layout: docs',
        '  language: en',
        '  context_compression: off',
        '  review_mode: standard',
        '  auto_transition: true',
      ].join('\n'),
      'utf8',
    );
    mockedSelect.mockResolvedValue(true as never);
    mockedCheckbox.mockResolvedValueOnce(['loop'] as never);

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await uninstallCommand(tmpDir);
    } finally {
      log.mockRestore();
    }

    const skillsDir = path.join(tmpDir, '.claude', 'skills');
    expect(await fileExists(path.join(skillsDir, 'owner-loop', 'SKILL.md'))).toBe(false);
    expect(await fileExists(path.join(skillsDir, 'owner-pipeline', 'SKILL.md'))).toBe(true);
    expect(await fileExists(path.join(skillsDir, 'owner', 'SKILL.md'))).toBe(true);
    const config = await fs.readFile(path.join(tmpDir, '.owner', 'config.yaml'), 'utf8');
    expect(config).toContain('default_workflow: pipeline');
    expect(config).not.toContain('loop:');
  });

  it('applies one full workflow selection to every current-project target', async () => {
    const claudePlatform = PLATFORMS.find((platform) => platform.id === 'claude')!;
    const codexPlatform = PLATFORMS.find((platform) => platform.id === 'codex')!;
    await copyOwnerSkillsForPlatform(
      tmpDir,
      claudePlatform,
      true,
      'skills',
      'project',
      'copy',
      'both',
    );
    await copyOwnerSkillsForPlatform(
      tmpDir,
      codexPlatform,
      true,
      'skills',
      'project',
      'copy',
      'both',
    );
    await fs.mkdir(path.join(tmpDir, '.owner'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, '.owner', 'config.yaml'),
      [
        'schema: owner.project.v1',
        'default_workflow: loop',
        'workflows:',
        '  - loop',
        '  - pipeline',
        'ambient_resume: true',
        'loop:',
        '  artifact_root: docs',
        '  language: en',
        'pipeline:',
        '  artifact_layout: docs',
        '  language: en',
        '  context_compression: off',
        '  review_mode: standard',
        '  auto_transition: true',
      ].join('\n'),
      'utf8',
    );
    await installOwnerProjectInstructions(tmpDir, 'en');
    mockedCheckbox
      .mockResolvedValueOnce(['claude:project'] as never)
      .mockResolvedValueOnce(['loop', 'pipeline'] as never)
      .mockResolvedValueOnce([] as never);

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await uninstallCommand(tmpDir);
    } finally {
      log.mockRestore();
    }

    await expect(fs.access(path.join(tmpDir, '.owner', 'config.yaml'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.readFile(path.join(tmpDir, 'AGENTS.md'), 'utf8')).resolves.toBe('');
    await expect(
      fs.access(path.join(tmpDir, '.agents', 'skills', 'owner-loop', 'SKILL.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.access(path.join(tmpDir, '.agents', 'skills', 'owner-pipeline', 'SKILL.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes project instructions when uninstalling the only installed workflow', async () => {
    const claudePlatform = PLATFORMS.find((platform) => platform.id === 'claude')!;
    await copyOwnerSkillsForPlatform(
      tmpDir,
      claudePlatform,
      true,
      'skills',
      'project',
      'copy',
      'loop',
    );
    await fs.mkdir(path.join(tmpDir, '.owner'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, '.owner', 'config.yaml'),
      [
        'schema: owner.project.v1',
        'default_workflow: loop',
        'workflows:',
        '  - loop',
        'ambient_resume: true',
        'loop:',
        '  artifact_root: docs',
        '  language: en',
      ].join('\n'),
      'utf8',
    );
    await installOwnerProjectInstructions(tmpDir, 'en');

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await uninstallCommand(tmpDir, { force: true });
    } finally {
      log.mockRestore();
    }

    await expect(fs.readFile(path.join(tmpDir, 'AGENTS.md'), 'utf8')).resolves.not.toContain(
      'owner-ambient-resume',
    );
  });

  it('keeps OpenSpec Skills unless the Pipeline companion option is selected', async () => {
    const claudePlatform = PLATFORMS.find((p) => p.id === 'claude')!;
    await copyOwnerSkillsForPlatform(
      tmpDir,
      claudePlatform,
      true,
      'skills',
      'project',
      'copy',
      'both',
    );
    const openSpecSkill = path.join(tmpDir, '.claude', 'skills', 'openspec-propose', 'SKILL.md');
    await fs.mkdir(path.dirname(openSpecSkill), { recursive: true });
    await fs.writeFile(openSpecSkill, '# OpenSpec', 'utf8');
    mockedSelect.mockResolvedValue(true as never);
    mockedCheckbox.mockResolvedValueOnce(['pipeline'] as never).mockResolvedValueOnce([] as never);

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await uninstallCommand(tmpDir);
    } finally {
      log.mockRestore();
    }

    expect(await fileExists(openSpecSkill)).toBe(true);
  });

  it('removes OpenSpec Skills when the Pipeline companion option is selected', async () => {
    const claudePlatform = PLATFORMS.find((p) => p.id === 'claude')!;
    await copyOwnerSkillsForPlatform(
      tmpDir,
      claudePlatform,
      true,
      'skills',
      'project',
      'copy',
      'both',
    );
    const openSpecSkill = path.join(tmpDir, '.claude', 'skills', 'openspec-propose', 'SKILL.md');
    await fs.mkdir(path.dirname(openSpecSkill), { recursive: true });
    await fs.writeFile(openSpecSkill, '# OpenSpec', 'utf8');
    mockedSelect.mockResolvedValue(true as never);
    mockedCheckbox
      .mockResolvedValueOnce(['pipeline'] as never)
      .mockResolvedValueOnce(['openspec'] as never);

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await uninstallCommand(tmpDir);
    } finally {
      log.mockRestore();
    }

    expect(await fileExists(openSpecSkill)).toBe(false);
  });

  it('keeps Pipeline companion Skills during a non-interactive full uninstall', async () => {
    const claudePlatform = PLATFORMS.find((p) => p.id === 'claude')!;
    await copyOwnerSkillsForPlatform(
      tmpDir,
      claudePlatform,
      true,
      'skills',
      'project',
      'copy',
      'both',
    );
    const openSpecSkill = path.join(tmpDir, '.claude', 'skills', 'openspec-propose', 'SKILL.md');
    await fs.mkdir(path.dirname(openSpecSkill), { recursive: true });
    await fs.writeFile(openSpecSkill, '# OpenSpec', 'utf8');

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await uninstallCommand(tmpDir, { force: true });
    } finally {
      log.mockRestore();
    }

    expect(await fileExists(openSpecSkill)).toBe(true);
  });

  it('uninstalls every current-project target after the workflow selection', async () => {
    const claudePlatform = PLATFORMS.find((p) => p.id === 'claude')!;
    await copyOwnerSkillsForPlatform(tmpDir, claudePlatform, true, 'skills', 'project');

    mockedCheckbox.mockResolvedValueOnce(['loop', 'pipeline'] as never);

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await uninstallCommand(tmpDir, { force: false });
    } finally {
      log.mockRestore();
    }

    const skillsDir = path.join(tmpDir, '.claude', 'skills');
    const entries = (await fs.readdir(skillsDir)).filter((e) => e.startsWith('owner'));
    expect(entries.length).toBe(0);
    expect(mockedCheckbox).toHaveBeenCalledTimes(2);
  });

  it('applies one workflow selection to every current-project platform', async () => {
    const claudePlatform = PLATFORMS.find((p) => p.id === 'claude')!;
    await copyOwnerSkillsForPlatform(tmpDir, claudePlatform, true, 'skills', 'project');
    const codexPlatform = PLATFORMS.find((p) => p.id === 'codex')!;
    await copyOwnerSkillsForPlatform(tmpDir, codexPlatform, true, 'skills', 'project');

    mockedCheckbox.mockResolvedValueOnce(['loop'] as never);

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await uninstallCommand(tmpDir, { force: false });
    } finally {
      log.mockRestore();
    }

    expect(mockedCheckbox).toHaveBeenCalledTimes(1);
    expect(mockedSelect).not.toHaveBeenCalled();

    expect(await fileExists(path.join(tmpDir, '.claude', 'skills', 'owner-loop', 'SKILL.md'))).toBe(
      false,
    );
    expect(
      await fileExists(path.join(tmpDir, '.claude', 'skills', 'owner-pipeline', 'SKILL.md')),
    ).toBe(true);
    expect(await fileExists(path.join(tmpDir, '.agents', 'skills', 'owner-loop', 'SKILL.md'))).toBe(
      false,
    );
    expect(
      await fileExists(path.join(tmpDir, '.agents', 'skills', 'owner-pipeline', 'SKILL.md')),
    ).toBe(true);
  });

  it('uses the init-style detected-platform batch selector before uninstalling', async () => {
    const claudePlatform = PLATFORMS.find((p) => p.id === 'claude')!;
    const codexPlatform = PLATFORMS.find((p) => p.id === 'codex')!;
    await copyOwnerSkillsForPlatform(tmpDir, claudePlatform, true, 'skills', 'project');
    await copyOwnerSkillsForPlatform(tmpDir, codexPlatform, true, 'skills', 'project');

    mockedPlatformSelectPrompt.mockResolvedValueOnce(['codex']);
    mockedCheckbox.mockResolvedValueOnce(['loop'] as never);

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await uninstallCommand(tmpDir, { force: false });
    } finally {
      log.mockRestore();
    }

    expect(mockedPlatformSelectPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Select platforms to uninstall:',
        selectedLabel: 'Selected platforms:',
        emptyLabel: 'None',
        required: true,
      }),
    );
    expect(mockedPlatformSelectPrompt.mock.calls[0]?.[0].choices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Claude Code (detected)',
          value: 'claude',
          checked: true,
        }),
        expect.objectContaining({ name: 'Codex (detected)', value: 'codex', checked: true }),
      ]),
    );
    expect(await fileExists(path.join(tmpDir, '.claude', 'skills', 'owner-loop', 'SKILL.md'))).toBe(
      true,
    );
    expect(await fileExists(path.join(tmpDir, '.agents', 'skills', 'owner-loop', 'SKILL.md'))).toBe(
      false,
    );
  });

  it('localizes current-project uninstall output from the project config language', async () => {
    const claudePlatform = PLATFORMS.find((p) => p.id === 'claude')!;
    await copyOwnerSkillsForPlatform(tmpDir, claudePlatform, true, 'skills', 'project');
    await fs.mkdir(path.join(tmpDir, '.owner'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, '.owner', 'config.yaml'),
      'config:\n  default_workflow: loop\n  workflows: [loop]\nloop:\n  artifact_root: .owner\n  language: zh-CN\n',
      'utf8',
    );

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let output: string;
    try {
      await uninstallCommand(tmpDir, { force: true });
      output = log.mock.calls.map((call) => call.join(' ')).join('\n');
    } finally {
      log.mockRestore();
    }

    expect(output).toContain('Owner 卸载');
    expect(output).toContain('Claude Code (项目):');
    expect(output).toContain('摘要：');
    expect(output).toContain('卸载完成。');
  });

  it('explains preserved working-directory content without marking uninstall incomplete', async () => {
    const claudePlatform = PLATFORMS.find((p) => p.id === 'claude')!;
    const retainedFile = path.join(tmpDir, 'docs', 'owner', 'user-notes.md');
    await copyOwnerSkillsForPlatform(tmpDir, claudePlatform, true, 'skills', 'project');
    await fs.mkdir(path.join(tmpDir, '.owner'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, '.owner', 'config.yaml'),
      [
        'config:',
        '  default_workflow: loop',
        '  workflows: [loop]',
        'loop:',
        '  artifact_root: docs/owner',
        '  language: zh-CN',
        '',
      ].join('\n'),
      'utf8',
    );
    await fs.mkdir(path.dirname(retainedFile), { recursive: true });
    await fs.writeFile(retainedFile, 'keep me', 'utf8');

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let output: string;
    try {
      await uninstallCommand(tmpDir, { force: true });
      output = log.mock.calls.map((call) => call.join(' ')).join('\n');
    } finally {
      log.mockRestore();
    }

    const retainedRelativePath = path.relative(tmpDir, retainedFile);
    expect(output).toContain(`工作目录：已保留已有内容： ${retainedRelativePath}`);
    expect(output).toContain('原因：这些内容不由 Owner 管理，因此未删除。');
    expect(output).toContain('影响：不影响 Owner 卸载完成，保留内容未被修改。');
    expect(output).toContain('卸载完成。');
    expect(output).not.toContain('清理失败：');
  });

  it('skips prompt with --force and uninstalls all', async () => {
    const claudePlatform = PLATFORMS.find((p) => p.id === 'claude')!;
    await copyOwnerSkillsForPlatform(tmpDir, claudePlatform, true, 'skills', 'project');

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await uninstallCommand(tmpDir, { force: true });
    } finally {
      log.mockRestore();
    }

    expect(mockedSelect).not.toHaveBeenCalled();
    expect(mockedCheckbox).not.toHaveBeenCalled();

    const skillsDir = path.join(tmpDir, '.claude', 'skills');
    const entries = (await fs.readdir(skillsDir)).filter((e) => e.startsWith('owner'));
    expect(entries.length).toBe(0);
  });

  it('skips prompt with --json and uninstalls all', async () => {
    const claudePlatform = PLATFORMS.find((p) => p.id === 'claude')!;
    await copyOwnerSkillsForPlatform(tmpDir, claudePlatform, true, 'skills', 'project');
    await fs.writeFile(
      path.join(tmpDir, 'AGENTS.md'),
      'before\n\n<owner-ambient-resume>\nbody\n</owner-ambient-resume>\nafter\n',
      'utf-8',
    );
    await fs.writeFile(
      path.join(tmpDir, 'CLAUDE.md'),
      '# Claude\n\n<owner-ambient-resume>\nbody\n</owner-ambient-resume>\n',
      'utf-8',
    );

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let jsonOutput;
    try {
      await uninstallCommand(tmpDir, { json: true });
      jsonOutput = log.mock.calls.map((c) => c.join(' ')).join('\n');
    } finally {
      log.mockRestore();
    }

    expect(mockedSelect).not.toHaveBeenCalled();
    expect(mockedCheckbox).not.toHaveBeenCalled();

    const result = JSON.parse(jsonOutput);
    expect(result.summary.targetsProcessed).toBeGreaterThan(0);
    expect(result.projectInstructionsRemoved).toBe(2);
  });

  it('prints message when no targets found', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let output;
    try {
      await uninstallCommand(tmpDir);
      output = log.mock.calls.map((c) => c.join(' ')).join('\n');
    } finally {
      log.mockRestore();
    }

    expect(output).toContain('No Owner installations found');
    expect(mockedSelect).not.toHaveBeenCalled();
  });

  it('returns stable JSON summary when no targets are found', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let jsonOutput: string;
    try {
      await uninstallCommand(tmpDir, { json: true });
      jsonOutput = log.mock.calls.map((c) => c.join(' ')).join('\n');
    } finally {
      log.mockRestore();
    }

    const result = JSON.parse(jsonOutput);
    expect(result).toMatchObject({
      targets: [],
      workingDirsRemoved: 0,
      summary: {
        targetsProcessed: 0,
        totalSkillsRemoved: 0,
        totalRulesRemoved: 0,
        totalHooksRemoved: 0,
      },
      projectInstructionsRemoved: 0,
    });
  });

  it('does not remove root managed project instructions with only global scope', async () => {
    const fakeHome = path.join(tmpDir, 'fake-home');
    await fs.mkdir(path.join(fakeHome, '.agents', 'skills', 'owner'), { recursive: true });
    await fs.writeFile(
      path.join(fakeHome, '.agents', 'skills', 'owner', 'SKILL.md'),
      '# Owner\n\nUse this skill.',
      'utf-8',
    );

    const agentsOriginal =
      'before\n\n<owner-ambient-resume>\nmanaged\n</owner-ambient-resume>\nafter\n';
    const claudeOriginal = '# User\n\n<owner-ambient-resume>\nmanaged\n</owner-ambient-resume>\n';
    await fs.writeFile(path.join(tmpDir, 'AGENTS.md'), agentsOriginal, 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'CLAUDE.md'), claudeOriginal, 'utf-8');

    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let jsonOutput: string;
    try {
      await uninstallCommand(tmpDir, { json: true, force: true, scope: 'global' });
      jsonOutput = log.mock.calls.map((c) => c.join(' ')).join('\n');
    } finally {
      log.mockRestore();
      homedirSpy.mockRestore();
    }

    const result = JSON.parse(jsonOutput);
    expect(result.projectInstructionsRemoved).toBe(0);

    const agents = await fs.readFile(path.join(tmpDir, 'AGENTS.md'), 'utf-8');
    const claude = await fs.readFile(path.join(tmpDir, 'CLAUDE.md'), 'utf-8');
    expect(agents).toBe(agentsOriginal);
    expect(claude).toBe(claudeOriginal);
  });

  it('removes only managed project instruction blocks and keeps user-authored content', async () => {
    const claudePlatform = PLATFORMS.find((p) => p.id === 'claude')!;
    await copyOwnerSkillsForPlatform(tmpDir, claudePlatform, true, 'skills', 'project');
    await fs.writeFile(
      path.join(tmpDir, 'AGENTS.md'),
      '# User\n\nKeep this.\n<owner-ambient-resume>\nmanaged\n</owner-ambient-resume>\n',
      'utf-8',
    );
    await fs.writeFile(
      path.join(tmpDir, 'CLAUDE.md'),
      '# User\n\nAlso keep this.\n<owner-ambient-resume>\nmanaged\n</owner-ambient-resume>\n',
      'utf-8',
    );

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await uninstallCommand(tmpDir, { force: true });
    } finally {
      log.mockRestore();
    }

    const agents = await fs.readFile(path.join(tmpDir, 'AGENTS.md'), 'utf-8');
    const claude = await fs.readFile(path.join(tmpDir, 'CLAUDE.md'), 'utf-8');
    expect(agents).toContain('Keep this.');
    expect(agents).not.toContain('<owner-ambient-resume>');
    expect(claude).toContain('Also keep this.');
    expect(claude).not.toContain('<owner-ambient-resume>');
  });
});
