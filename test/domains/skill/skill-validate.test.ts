import { describe, expect, it } from 'vitest';
import { validateSkillPackage } from '../../../domains/skill/validate.js';
import type { SkillPackage } from '../../../domains/skill/types.js';

function pkg(): SkillPackage {
  return {
    root: '/repo/demo',
    definition: {
      apiVersion: 'owner/v1alpha1',
      kind: 'Skill',
      metadata: { name: 'demo', version: '1.0.0', description: 'Demo' },
      goal: { statement: 'Done', inputs: [], outputs: [], success: ['done'] },
      orchestration: {
        mode: 'deterministic',
        entry: 'start',
        steps: [
          {
            id: 'start',
            action: { type: 'invoke_skill', ref: 'writing-plans' },
          },
        ],
      },
      skills: [{ id: 'writing-plans' }],
      agents: [],
      tools: [],
    },
    guardrails: {
      allowedSkills: ['writing-plans'],
      allowedAgents: [],
      allowedTools: [],
      maxIterations: 10,
      maxRetriesPerAction: 2,
      confirmationRequiredFor: [],
    },
    evals: [],
  };
}

describe('validateSkillPackage', () => {
  it('accepts a minimal deterministic package', () => {
    expect(validateSkillPackage(pkg())).toEqual([]);
  });

  it('rejects duplicate steps, unknown refs and invalid entry', () => {
    const value = pkg();
    value.definition.orchestration.entry = 'missing';
    value.definition.orchestration.steps!.push({
      id: 'start',
      action: { type: 'call_tool', ref: 'unknown' },
    });
    expect(validateSkillPackage(value)).toEqual(
      expect.arrayContaining([
        'orchestration.entry references unknown step: missing',
        'duplicate step id: start',
        'step start references undeclared tool: unknown',
      ]),
    );
  });

  it('requires adaptive packages to omit deterministic steps', () => {
    const value = pkg();
    value.definition.orchestration.mode = 'adaptive';
    expect(validateSkillPackage(value)).toContain(
      'adaptive orchestration must not define entry or steps',
    );
  });

  it('rejects inline script commands and escaping script paths', () => {
    const value = pkg();
    value.definition.tools.push({
      id: 'unsafe',
      kind: 'script',
      source: '../outside.sh',
      sideEffect: 'write',
    });
    value.guardrails.allowedTools.push('unsafe');
    expect(validateSkillPackage(value)).toContain(
      'script tool unsafe must reference a relative path inside the Skill package',
    );
  });
});
