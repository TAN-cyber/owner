import { describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import {
  getManagedSkillPaths,
  getManifestSkills,
  readManifest,
  type Manifest,
} from '../../../domains/skill/platform-install.js';

const manifest: Manifest = {
  version: '1.0.0',
  skills: ['owner/SKILL.md', 'owner-open/SKILL.md', 'owner/scripts/runtime.mjs'],
  internalSkills: ['owner/runtime/classic/skill.yaml'],
};

function userFacingSkillNames(value: Manifest): string[] {
  return value.skills.flatMap((skillPath) => {
    const parts = skillPath.split('/');
    return parts.length === 2 && parts[1] === 'SKILL.md' ? [parts[0]] : [];
  });
}

describe('internal Skill assets', () => {
  it('binds every Classic entry Skill to an explicit current change', async () => {
    const skillNames = [
      'owner-classic',
      'owner-open',
      'owner-design',
      'owner-build',
      'owner-verify',
      'owner-archive',
      'owner-hotfix',
      'owner-tweak',
    ];

    for (const name of skillNames) {
      const [chinese, english] = await Promise.all(
        ['assets/skills-zh', 'assets/skills'].map((root) =>
          fs.readFile(path.resolve(root, name, 'SKILL.md'), 'utf8'),
        ),
      );
      expect(chinese, `${name} Chinese selection protocol`).toContain(
        'owner state select <change-name>',
      );
      expect(english, `${name} English selection protocol`).toContain(
        'owner state select <change-name>',
      );
    }

    const [chineseRule, englishRule] = await Promise.all([
      fs.readFile(path.resolve('assets/skills/owner/rules/owner-phase-guard.md'), 'utf8'),
      fs.readFile(path.resolve('assets/skills/owner/rules/owner-phase-guard.en.md'), 'utf8'),
    ]);
    expect(chineseRule).toContain('多个 active change');
    expect(englishRule).toContain('multiple active changes');

    const [chineseBuild, englishBuild] = await Promise.all([
      fs.readFile(path.resolve('assets/skills-zh/owner-build/SKILL.md'), 'utf8'),
      fs.readFile(path.resolve('assets/skills/owner-build/SKILL.md'), 'utf8'),
    ]);
    expect(chineseBuild.match(/owner state select <change-name>/gu)).toHaveLength(2);
    expect(englishBuild.match(/owner state select <change-name>/gu)).toHaveLength(2);
  });

  it('includes internal Skills in managed lifecycle paths', () => {
    expect(getManagedSkillPaths(manifest)).toEqual([
      'owner/SKILL.md',
      'owner-open/SKILL.md',
      'owner/scripts/runtime.mjs',
      'owner/runtime/classic/skill.yaml',
    ]);
  });

  it('excludes internal Skills from user-facing command names', () => {
    expect(userFacingSkillNames(manifest)).toEqual(['owner', 'owner-open']);
  });

  it('declares the internalSkills collection in the shipped manifest', async () => {
    const shipped = await readManifest();

    expect(shipped.internalSkills).toEqual([
      'owner/runtime/classic/skill.yaml',
      'owner/runtime/classic/guardrails.yaml',
      'owner/runtime/classic/checks.yaml',
    ]);
    expect(userFacingSkillNames(shipped)).toContain('owner-classic');
    expect(userFacingSkillNames(shipped)).not.toContain('runtime');
    expect(await getManifestSkills()).toEqual(getManagedSkillPaths(shipped));
  });

  it('selects Native and Classic assets by workflow', async () => {
    const shipped = await readManifest();
    const native = await getManifestSkills('native');
    const classic = await getManifestSkills('classic');
    const both = await getManifestSkills('both');

    expect(native).toEqual(
      getManagedSkillPaths(shipped).filter(
        (skillPath) =>
          skillPath === 'owner/SKILL.md' ||
          skillPath === 'owner/scripts/owner-entry-runtime.mjs' ||
          skillPath === 'owner/scripts/owner-hook-router.mjs' ||
          skillPath.startsWith('owner-native/'),
      ),
    );
    expect(native).not.toContain('owner-classic/SKILL.md');
    expect(native).not.toContain('owner-classic/reference/scripts.md');
    expect(native).not.toContain('owner-open/SKILL.md');

    expect(classic).toContain('owner-classic/SKILL.md');
    expect(classic).toContain('owner-classic/reference/scripts.md');
    expect(classic).toContain('owner-open/SKILL.md');
    expect(classic).not.toContain('owner-native/SKILL.md');
    expect(both).toEqual(getManagedSkillPaths(shipped));
  });
});
