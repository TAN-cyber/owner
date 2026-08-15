import { describe, expect, it } from 'vitest';
import {
  acceptAdaptiveAction,
  decide,
  recordOutcome,
  startRun,
} from '../../../domains/engine/loop.js';
import type { SkillPackage } from '../../../domains/skill/types.js';

function deterministic(): SkillPackage {
  return {
    root: '/repo/demo',
    definition: {
      apiVersion: 'owner/v1alpha1',
      kind: 'Skill',
      metadata: { name: 'demo', version: '1', description: 'Demo' },
      goal: { statement: 'Done', inputs: [], outputs: [], success: ['done'] },
      orchestration: {
        mode: 'deterministic',
        entry: 'plan',
        steps: [
          {
            id: 'plan',
            action: { type: 'invoke_skill', ref: 'writing-plans' },
            next: 'finish',
          },
          { id: 'finish', action: { type: 'checkpoint' } },
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
      maxRetriesPerAction: 1,
      confirmationRequiredFor: [],
    },
    evals: [],
  };
}

describe('Skill Engine loop', () => {
  it('uses one loop for deterministic steps', () => {
    const pkg = deterministic();
    let state = startRun(pkg, 'run-1', 'a'.repeat(64));
    const first = decide(pkg, state, new Set());
    expect(first.action).toMatchObject({
      type: 'invoke_skill',
      ref: 'writing-plans',
      stepId: 'plan',
    });
    state = first.state;
    state = recordOutcome(pkg, state, {
      actionId: first.action!.id,
      status: 'succeeded',
      summary: 'plan written',
    });
    expect(state.currentStep).toBe('finish');
    expect(state.iteration).toBe(1);
  });

  it('accepts a guardrail-checked adaptive candidate', () => {
    const pkg = deterministic();
    pkg.definition.orchestration = { mode: 'adaptive' };
    const state = startRun(pkg, 'run-2', 'b'.repeat(64));
    const result = acceptAdaptiveAction(
      pkg,
      state,
      { id: 'candidate', stepId: null, type: 'invoke_skill', ref: 'writing-plans' },
      new Set(),
    );
    expect(result.action?.id).toBe('candidate');
    expect(result.state.pending).toBe('candidate');
  });

  it('fails closed when a candidate violates guardrails', () => {
    const pkg = deterministic();
    pkg.definition.orchestration = { mode: 'adaptive' };
    const state = startRun(pkg, 'run-3', 'c'.repeat(64));
    const result = acceptAdaptiveAction(
      pkg,
      state,
      { id: 'candidate', stepId: null, type: 'invoke_skill', ref: 'unknown' },
      new Set(),
    );
    expect(result.action).toBeNull();
    expect(result.reason).toBe('Skill is not allowed: unknown');
  });

  it('fails closed when a deterministic Run references an unknown step', () => {
    const pkg = deterministic();
    const state = startRun(pkg, 'run-4', 'd'.repeat(64));
    state.currentStep = 'missing';

    const result = decide(pkg, state, new Set());

    expect(result.action).toBeNull();
    expect(result.state.status).toBe('failed');
    expect(result.reason).toBe('Unknown current step: missing');
  });

  it('rejects outcomes when the deterministic current step is corrupt', () => {
    const pkg = deterministic();
    const state = startRun(pkg, 'run-5', 'e'.repeat(64));
    const decision = decide(pkg, state, new Set());
    decision.state.currentStep = 'missing';

    expect(() =>
      recordOutcome(pkg, decision.state, {
        actionId: decision.action!.id,
        status: 'succeeded',
        summary: 'done',
      }),
    ).toThrow('Unknown current step: missing');
  });

  it('does not accept adaptive candidates after the Run stops', () => {
    const pkg = deterministic();
    pkg.definition.orchestration = { mode: 'adaptive' };
    const state = startRun(pkg, 'run-6', 'f'.repeat(64));
    state.status = 'completed';

    const result = acceptAdaptiveAction(
      pkg,
      state,
      { id: 'candidate', stepId: null, type: 'invoke_skill', ref: 'writing-plans' },
      new Set(),
    );

    expect(result.action).toBeNull();
    expect(result.reason).toBe('Run is completed');
  });

  it('does not overwrite an existing pending adaptive action', () => {
    const pkg = deterministic();
    pkg.definition.orchestration = { mode: 'adaptive' };
    const state = startRun(pkg, 'run-7', '0'.repeat(64));
    state.pending = 'existing';

    const result = acceptAdaptiveAction(
      pkg,
      state,
      { id: 'candidate', stepId: null, type: 'invoke_skill', ref: 'writing-plans' },
      new Set(),
    );

    expect(result.action).toBeNull();
    expect(result.reason).toBe('Action already pending: existing');
    expect(result.state.pending).toBe('existing');
  });
});
