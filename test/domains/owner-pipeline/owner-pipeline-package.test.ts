import { describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { loadRuntimePackage } from '../../../domains/skill/load.js';
import { validateSkillPackage } from '../../../domains/skill/validate.js';

const chinesePackageRoot = path.resolve('assets', 'skills-zh', 'owner', 'runtime', 'pipeline');
const englishPackageRoot = path.resolve('assets', 'skills', 'owner', 'runtime', 'pipeline');
const stableSteps = [
  'full.open',
  'full.design.handoff',
  'full.design.document',
  'full.build.plan',
  'full.build.plan-ready',
  'full.build.configure',
  'full.build.execute',
  'full.build.complete',
  'full.build.fix',
  'full.verify.run',
  'full.verify.branch',
  'full.archive.confirm',
  'full.archive.execute',
  'hotfix.open',
  'hotfix.build.execute',
  'hotfix.build.complete',
  'hotfix.verify.run',
  'hotfix.verify.branch',
  'hotfix.archive.confirm',
  'hotfix.archive.execute',
  'tweak.open',
  'tweak.build.execute',
  'tweak.build.complete',
  'tweak.verify.run',
  'tweak.verify.branch',
  'tweak.archive.confirm',
  'tweak.archive.execute',
  'completed',
];

describe('Chinese owner-pipeline package', () => {
  it('loads as one deterministic internal Skill with every stable step', async () => {
    const pkg = await loadRuntimePackage(chinesePackageRoot);

    expect(pkg.definition.metadata).toMatchObject({
      name: 'owner-pipeline',
      version: '1',
    });
    expect(pkg.definition.orchestration.mode).toBe('deterministic');
    expect(pkg.definition.orchestration.entry).toBe('full.open');
    expect(pkg.definition.orchestration.steps?.map((step) => step.id)).toEqual(stableSteps);
    expect(validateSkillPackage(pkg)).toEqual([]);
  });

  it('declares every invoked public Skill and never invokes itself', async () => {
    const pkg = await loadRuntimePackage(chinesePackageRoot);
    const declared = new Set(pkg.definition.skills.map((skill) => skill.id));
    const invoked = (pkg.definition.orchestration.steps ?? [])
      .filter((step) => step.action.type === 'invoke_skill')
      .map((step) => step.action.ref);

    expect(declared).toEqual(
      new Set([
        'owner-open',
        'owner-design',
        'owner-build',
        'owner-verify',
        'owner-archive',
        'owner-hotfix',
        'owner-tweak',
      ]),
    );
    expect(invoked.every((ref) => ref && declared.has(ref))).toBe(true);
    expect(invoked).not.toContain('owner-pipeline');
  });

  it('defines a completion eval for completed Run state', async () => {
    const pkg = await loadRuntimePackage(chinesePackageRoot);

    expect(pkg.evals).toContainEqual({
      id: 'pipeline-completed',
      scope: 'completion',
      type: 'state_equals',
      field: 'status',
      equals: 'completed',
    });
    expect(
      pkg.definition.orchestration.steps?.find((step) => step.id === 'completed')?.completionEvals,
    ).toEqual(['pipeline-completed']);
  });

  it('is a YAML-only runtime package without a user-facing SKILL.md', async () => {
    await expect(fs.access(path.join(chinesePackageRoot, 'SKILL.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('English owner-pipeline package', () => {
  it('matches the executable structure of the confirmed Chinese package', async () => {
    const [chinese, english] = await Promise.all([
      loadRuntimePackage(chinesePackageRoot),
      loadRuntimePackage(englishPackageRoot),
    ]);

    expect(validateSkillPackage(english)).toEqual([]);
    expect({
      metadata: {
        name: english.definition.metadata.name,
        version: english.definition.metadata.version,
      },
      orchestration: english.definition.orchestration,
      skills: english.definition.skills,
      agents: english.definition.agents,
      tools: english.definition.tools,
      guardrails: english.guardrails,
      evals: english.evals,
    }).toEqual({
      metadata: {
        name: chinese.definition.metadata.name,
        version: chinese.definition.metadata.version,
      },
      orchestration: chinese.definition.orchestration,
      skills: chinese.definition.skills,
      agents: chinese.definition.agents,
      tools: chinese.definition.tools,
      guardrails: chinese.guardrails,
      evals: chinese.evals,
    });
  });

  it('is a YAML-only runtime package without a user-facing English SKILL.md', async () => {
    await expect(fs.access(path.join(englishPackageRoot, 'SKILL.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
