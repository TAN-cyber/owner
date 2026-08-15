import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { mkdir, mkdtemp, rm, lstat, readFile, realpath, symlink, writeFile } from 'fs/promises';
import os from 'os';
import {
  copyOwnerSkillsForPlatform,
  getCentralSkillsDir,
  prepareManagedSkillCopyTarget,
} from '../../../domains/skill/platform-install.js';
import { fileExists } from '../../../platform/fs/file-system.js';
import { PLATFORMS, type Platform } from '../../../platform/install/platforms.js';

const mockPlatform: Platform = {
  id: 'claude',
  name: 'Claude Code',
  skillsDir: '.claude',
  globalSkillsDir: '.claude',
  openspecToolId: 'claude',
  rulesDir: 'rules',
  rulesFormat: 'md',
  supportsHooks: true,
  hookFormat: 'claude-code',
};

const codexPlatform = PLATFORMS.find((platform) => platform.id === 'codex');

const RETIRED_LOOP_BUNDLES = [
  'owner-loop/scripts/owner-loop-checkpoint.mjs',
  'owner-loop/scripts/owner-loop-check.mjs',
  'owner-loop/scripts/owner-loop-evidence.mjs',
  'owner-loop/scripts/owner-loop-receipt.mjs',
] as const;

if (!codexPlatform) {
  throw new Error('Codex platform definition is missing');
}

describe('symlink install mode', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'owner-symlink-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('getCentralSkillsDir', () => {
    it('returns .owner/skills for project scope', () => {
      const result = getCentralSkillsDir(tmpDir, 'project');
      expect(result).toBe(path.join(tmpDir, '.owner', 'skills'));
    });

    it('returns .owner/skills for global scope', () => {
      const result = getCentralSkillsDir(tmpDir, 'global');
      expect(result).toBe(path.join(tmpDir, '.owner', 'skills'));
    });
  });

  describe('prepareManagedSkillCopyTarget', () => {
    it('detaches a fully managed Skill-root symlink without changing its target', async () => {
      await copyOwnerSkillsForPlatform(tmpDir, mockPlatform, true, 'skills', 'project', 'symlink');
      const platformSkills = path.join(tmpDir, '.claude', 'skills');
      const centralOwner = path.join(tmpDir, '.owner', 'skills', 'skills', 'owner', 'SKILL.md');
      const centralContent = await readFile(centralOwner, 'utf8');

      await prepareManagedSkillCopyTarget(tmpDir, mockPlatform, 'project');

      expect((await lstat(platformSkills)).isSymbolicLink()).toBe(false);
      expect(await fileExists(path.join(platformSkills, 'owner', 'SKILL.md'))).toBe(false);
      expect(await readFile(centralOwner, 'utf8')).toBe(centralContent);
    });

    it('detaches managed entry symlinks while preserving unrelated Skills', async () => {
      const centralOwner = path.join(tmpDir, '.owner', 'skills', 'skills', 'owner');
      const platformSkills = path.join(tmpDir, '.claude', 'skills');
      const personalSkill = path.join(platformSkills, 'personal', 'SKILL.md');
      await mkdir(centralOwner, { recursive: true });
      await writeFile(path.join(centralOwner, 'SKILL.md'), '# Central Owner\n', 'utf8');
      await mkdir(path.dirname(personalSkill), { recursive: true });
      await writeFile(personalSkill, '# Personal\n', 'utf8');
      await symlink(
        centralOwner,
        path.join(platformSkills, 'owner'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );

      await prepareManagedSkillCopyTarget(tmpDir, mockPlatform, 'project');

      expect(await fileExists(path.join(platformSkills, 'owner'))).toBe(false);
      expect(await readFile(personalSkill, 'utf8')).toBe('# Personal\n');
      expect(await readFile(path.join(centralOwner, 'SKILL.md'), 'utf8')).toBe('# Central Owner\n');
    });

    it('refuses to detach a shared Skill-root symlink with unmanaged entries', async () => {
      await copyOwnerSkillsForPlatform(tmpDir, mockPlatform, true, 'skills', 'project', 'symlink');
      const platformSkills = path.join(tmpDir, '.claude', 'skills');
      const openSpecSkill = path.join(tmpDir, '.owner', 'skills', 'skills', 'openspec', 'SKILL.md');
      await mkdir(path.dirname(openSpecSkill), { recursive: true });
      await writeFile(openSpecSkill, '# OpenSpec\n', 'utf8');

      await expect(prepareManagedSkillCopyTarget(tmpDir, mockPlatform, 'project')).rejects.toThrow(
        /unmanaged entries: openspec/iu,
      );

      expect((await lstat(platformSkills)).isSymbolicLink()).toBe(true);
      expect(await readFile(openSpecSkill, 'utf8')).toBe('# OpenSpec\n');
    });
  });

  describe('copyOwnerSkillsForPlatform install modes', () => {
    it.each(['copy', 'symlink'] as const)(
      'removes only retired Loop bundles from the %s storage root after a successful install',
      async (installMode) => {
        const storageRoot =
          installMode === 'copy'
            ? path.join(tmpDir, '.claude', 'skills')
            : path.join(tmpDir, '.owner', 'skills', 'skills');
        const userFile = path.join(storageRoot, 'owner-loop', 'scripts', 'user-helper.mjs');
        await mkdir(path.dirname(userFile), { recursive: true });
        for (const relativePath of RETIRED_LOOP_BUNDLES) {
          await writeFile(path.join(storageRoot, ...relativePath.split('/')), 'legacy bundle\n');
        }
        await writeFile(userFile, 'keep user content\n');

        const result = await copyOwnerSkillsForPlatform(
          tmpDir,
          mockPlatform,
          true,
          'skills',
          'project',
          installMode,
          'loop',
        );

        expect(result.failed).toBe(0);
        for (const relativePath of RETIRED_LOOP_BUNDLES) {
          await expect(
            lstat(path.join(storageRoot, ...relativePath.split('/'))),
          ).rejects.toMatchObject({ code: 'ENOENT' });
        }
        await expect(readFile(userFile, 'utf8')).resolves.toBe('keep user content\n');
        expect(
          await fileExists(path.join(storageRoot, 'owner-loop', 'scripts', 'owner-loop-next.mjs')),
        ).toBe(true);
      },
    );

    it('leaves retired Loop paths untouched during a Pipeline-only install', async () => {
      const retiredPath = path.join(
        tmpDir,
        '.claude',
        'skills',
        ...RETIRED_LOOP_BUNDLES[0].split('/'),
      );
      await mkdir(path.dirname(retiredPath), { recursive: true });
      await writeFile(retiredPath, 'keep Loop installation\n');

      const result = await copyOwnerSkillsForPlatform(
        tmpDir,
        mockPlatform,
        true,
        'skills',
        'project',
        'copy',
        'pipeline',
      );

      expect(result.failed).toBe(0);
      await expect(readFile(retiredPath, 'utf8')).resolves.toBe('keep Loop installation\n');
    });

    it('recognizes retired bundles when replacing a beta17 copy tree with managed symlinks', async () => {
      const installedRoot = path.join(tmpDir, '.claude', 'skills');
      for (const relativePath of RETIRED_LOOP_BUNDLES) {
        const target = path.join(installedRoot, ...relativePath.split('/'));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, 'legacy bundle\n');
      }

      const result = await copyOwnerSkillsForPlatform(
        tmpDir,
        mockPlatform,
        true,
        'skills',
        'project',
        'symlink',
        'loop',
      );

      expect(result.failed).toBe(0);
      expect((await lstat(path.join(installedRoot, 'owner-loop'))).isSymbolicLink()).toBe(true);
      for (const relativePath of RETIRED_LOOP_BUNDLES) {
        await expect(
          lstat(path.join(installedRoot, ...relativePath.split('/'))),
        ).rejects.toMatchObject({ code: 'ENOENT' });
      }
    });

    it('copies Codex skills to .agents without writing to legacy .codex skills', async () => {
      const result = await copyOwnerSkillsForPlatform(
        tmpDir,
        codexPlatform,
        false,
        'skills',
        'project',
        'copy',
      );

      expect(result.failed).toBe(0);
      expect(await fileExists(path.join(tmpDir, '.agents', 'skills', 'owner', 'SKILL.md'))).toBe(
        true,
      );
      expect(await fileExists(path.join(tmpDir, '.codex', 'skills', 'owner', 'SKILL.md'))).toBe(
        false,
      );
    });

    it('links Codex managed skills under .agents and preserves unrelated skills', async () => {
      const unrelatedSkill = path.join(tmpDir, '.agents', 'skills', 'third-party', 'SKILL.md');
      await mkdir(path.dirname(unrelatedSkill), { recursive: true });
      await writeFile(unrelatedSkill, '# Third-party Skill\n', 'utf-8');

      const result = await copyOwnerSkillsForPlatform(
        tmpDir,
        codexPlatform,
        true,
        'skills',
        'project',
        'symlink',
      );

      expect(result.failed).toBe(0);
      expect(await readFile(unrelatedSkill, 'utf-8')).toBe('# Third-party Skill\n');

      const ownerSkillLink = path.join(tmpDir, '.agents', 'skills', 'owner');
      expect((await lstat(ownerSkillLink)).isSymbolicLink()).toBe(true);
      expect(await realpath(ownerSkillLink)).toBe(
        await realpath(path.join(tmpDir, '.owner', 'skills', 'skills', 'owner')),
      );
      expect(await fileExists(path.join(tmpDir, '.codex', 'skills', 'owner', 'SKILL.md'))).toBe(
        false,
      );
    });

    it('copies skills to central store and creates symlink', async () => {
      const result = await copyOwnerSkillsForPlatform(
        tmpDir,
        mockPlatform,
        false,
        'skills',
        'project',
        'symlink',
      );

      expect(result.copied).toBeGreaterThan(0);
      expect(result.failed).toBe(0);

      // Verify central store has actual files
      const centralSkillPath = path.join(tmpDir, '.owner', 'skills', 'skills', 'owner', 'SKILL.md');
      expect(await fileExists(centralSkillPath)).toBe(true);

      // Verify platform dir is a symlink
      const platformSkillsDir = path.join(tmpDir, '.claude', 'skills');
      const stat = await lstat(platformSkillsDir);
      expect(stat.isSymbolicLink()).toBe(true);

      // Verify symlink points to central store
      const linkedPath = await realpath(platformSkillsDir);
      const expectedTarget = await realpath(path.join(tmpDir, '.owner', 'skills', 'skills'));
      expect(linkedPath).toBe(expectedTarget);
    });

    it('links only Pipeline workflow assets for a Pipeline install', async () => {
      const result = await copyOwnerSkillsForPlatform(
        tmpDir,
        mockPlatform,
        true,
        'skills',
        'project',
        'symlink',
        'pipeline',
      );

      expect(result.failed).toBe(0);
      await expect(
        readFile(path.join(tmpDir, '.claude', 'skills', 'owner', 'SKILL.md'), 'utf8'),
      ).resolves.toContain('name: owner');
      await expect(
        readFile(path.join(tmpDir, '.claude', 'skills', 'owner-pipeline', 'SKILL.md'), 'utf8'),
      ).resolves.toContain('name: owner-pipeline');
      await expect(
        lstat(path.join(tmpDir, '.claude', 'skills', 'owner-loop')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('skips existing files in central store when overwrite is false', async () => {
      // First install
      await copyOwnerSkillsForPlatform(tmpDir, mockPlatform, false, 'skills', 'project', 'symlink');

      // Second install without overwrite
      const result = await copyOwnerSkillsForPlatform(
        tmpDir,
        mockPlatform,
        false,
        'skills',
        'project',
        'symlink',
      );

      expect(result.skipped).toBeGreaterThan(0);
      expect(result.copied).toBe(0);
    });

    it('overwrites files in central store when overwrite is true', async () => {
      // First install
      await copyOwnerSkillsForPlatform(tmpDir, mockPlatform, false, 'skills', 'project', 'symlink');

      // Second install with overwrite
      const result = await copyOwnerSkillsForPlatform(
        tmpDir,
        mockPlatform,
        true,
        'skills',
        'project',
        'symlink',
      );

      expect(result.copied).toBeGreaterThan(0);
    });

    it('links managed skills into an existing skills directory with unrelated user skills', async () => {
      const existingSkill = path.join(tmpDir, '.claude', 'skills', 'personal-skill', 'SKILL.md');
      await mkdir(path.dirname(existingSkill), { recursive: true });
      await writeFile(existingSkill, '# Personal Skill\n', 'utf-8');

      const result = await copyOwnerSkillsForPlatform(
        tmpDir,
        mockPlatform,
        true,
        'skills',
        'project',
        'symlink',
      );

      expect(result.failed).toBe(0);
      expect(await readFile(existingSkill, 'utf-8')).toBe('# Personal Skill\n');

      const platformSkillsDir = path.join(tmpDir, '.claude', 'skills');
      const stat = await lstat(platformSkillsDir);
      expect(stat.isSymbolicLink()).toBe(false);

      const ownerSkillLink = path.join(platformSkillsDir, 'owner');
      const ownerSkillStat = await lstat(ownerSkillLink);
      expect(ownerSkillStat.isSymbolicLink()).toBe(true);
      expect(await realpath(ownerSkillLink)).toBe(
        await realpath(path.join(tmpDir, '.owner', 'skills', 'skills', 'owner')),
      );
      expect(await fileExists(path.join(ownerSkillLink, 'SKILL.md'))).toBe(true);
    });

    it('does not replace an existing managed skill directory that contains unmanaged files', async () => {
      const existingNestedFile = path.join(tmpDir, '.claude', 'skills', 'owner', 'local-notes.md');
      await mkdir(path.dirname(existingNestedFile), { recursive: true });
      await writeFile(existingNestedFile, '# Local notes\n', 'utf-8');

      const result = await copyOwnerSkillsForPlatform(
        tmpDir,
        mockPlatform,
        true,
        'skills',
        'project',
        'symlink',
      );

      expect(result.failed).toBe(1);
      expect(await readFile(existingNestedFile, 'utf-8')).toBe('# Local notes\n');

      const ownerSkillStat = await lstat(path.join(tmpDir, '.claude', 'skills', 'owner'));
      expect(ownerSkillStat.isSymbolicLink()).toBe(false);
    });

    it('uses copy behavior when mode is copy (default)', async () => {
      const result = await copyOwnerSkillsForPlatform(
        tmpDir,
        mockPlatform,
        false,
        'skills',
        'project',
        'copy',
      );

      expect(result.copied).toBeGreaterThan(0);

      // Verify platform dir is NOT a symlink
      const platformSkillsDir = path.join(tmpDir, '.claude', 'skills');
      const stat = await lstat(platformSkillsDir);
      expect(stat.isSymbolicLink()).toBe(false);

      // Verify actual file exists in platform dir
      const skillPath = path.join(tmpDir, '.claude', 'skills', 'owner', 'SKILL.md');
      expect(await fileExists(skillPath)).toBe(true);
    });

    it('defaults to copy mode when installMode is not specified', async () => {
      const result = await copyOwnerSkillsForPlatform(
        tmpDir,
        mockPlatform,
        false,
        'skills',
        'project',
      );

      expect(result.copied).toBeGreaterThan(0);

      // Verify platform dir is NOT a symlink
      const platformSkillsDir = path.join(tmpDir, '.claude', 'skills');
      const stat = await lstat(platformSkillsDir);
      expect(stat.isSymbolicLink()).toBe(false);
    });
  });
});
