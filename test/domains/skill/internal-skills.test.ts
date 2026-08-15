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
  internalSkills: ['owner/runtime/pipeline/skill.yaml'],
};

function userFacingSkillNames(value: Manifest): string[] {
  return value.skills.flatMap((skillPath) => {
    const parts = skillPath.split('/');
    return parts.length === 2 && parts[1] === 'SKILL.md' ? [parts[0]] : [];
  });
}

describe('internal Skill assets', () => {
  it('binds every Pipeline entry Skill to an explicit current change', async () => {
    const skillNames = [
      'owner-pipeline',
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
      'owner/runtime/pipeline/skill.yaml',
    ]);
  });

  it('excludes internal Skills from user-facing command names', () => {
    expect(userFacingSkillNames(manifest)).toEqual(['owner', 'owner-open']);
  });

  it('declares the internalSkills collection in the shipped manifest', async () => {
    const shipped = await readManifest();

    expect(shipped.internalSkills).toEqual([
      'owner/runtime/pipeline/skill.yaml',
      'owner/runtime/pipeline/guardrails.yaml',
      'owner/runtime/pipeline/checks.yaml',
    ]);
    expect(userFacingSkillNames(shipped)).toContain('owner-pipeline');
    expect(userFacingSkillNames(shipped)).not.toContain('runtime');
    expect(await getManifestSkills()).toEqual(getManagedSkillPaths(shipped));
  });

  it('selects Loop and Pipeline assets by workflow', async () => {
    const shipped = await readManifest();
    const loop = await getManifestSkills('loop');
    const pipeline = await getManifestSkills('pipeline');
    const both = await getManifestSkills('both');

    expect(loop).toEqual(
      getManagedSkillPaths(shipped).filter(
        (skillPath) =>
          skillPath === 'owner/SKILL.md' ||
          skillPath === 'owner/scripts/owner-entry-runtime.mjs' ||
          skillPath === 'owner/scripts/owner-hook-router.mjs' ||
          skillPath.startsWith('owner-loop/'),
      ),
    );
    expect(loop).not.toContain('owner-pipeline/SKILL.md');
    expect(loop).not.toContain('owner-pipeline/reference/scripts.md');
    expect(loop).not.toContain('owner-open/SKILL.md');

    expect(pipeline).toContain('owner-pipeline/SKILL.md');
    expect(pipeline).toContain('owner-pipeline/reference/scripts.md');
    expect(pipeline).toContain('owner-open/SKILL.md');
    expect(pipeline).not.toContain('owner-loop/SKILL.md');
    expect(both).toEqual(getManagedSkillPaths(shipped));
  });
});
