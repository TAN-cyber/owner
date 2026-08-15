import { describe, expect, it } from 'vitest';
import {
  decideWithResolver,
  recordOutcomeWithResolver,
  startRun,
} from '../../../domains/engine/loop.js';
import type { DeterministicResolver } from '../../../domains/engine/resolver.js';
import type { RunState } from '../../../domains/engine/types.js';
import type { SkillPackage, SkillStep } from '../../../domains/skill/types.js';

interface ResolverContext {
  selectedStep: string;
  nextStep: string | null;
}

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

function contextualResolver(): DeterministicResolver<ResolverContext> {
  return {
    resolveStep({ pkg, context }) {
      return pkg.definition.orchestration.steps?.find((step) => step.id === context.selectedStep);
    },
    resolveNext({ context }) {
      return context.nextStep;
    },
  };
}

describe('deterministic resolver extension', () => {
  it('lets an injected resolver select the current package step', () => {
    const pkg = deterministic();
    const state = startRun(pkg, 'run-resolver-1', 'a'.repeat(64));

    const decision = decideWithResolver(pkg, state, new Set(), contextualResolver(), {
      selectedStep: 'finish',
      nextStep: null,
    });

    expect(decision.action).toMatchObject({ type: 'checkpoint', stepId: 'finish' });
    expect(decision.state.currentStep).toBe('finish');
    expect(state.currentStep).toBe('plan');
  });

  it('lets an injected resolver select the next package step', () => {
    const pkg = deterministic();
    const initial = startRun(pkg, 'run-resolver-2', 'b'.repeat(64));
    const context = { selectedStep: 'plan', nextStep: 'plan' };
    const decision = decideWithResolver(pkg, initial, new Set(), contextualResolver(), context);

    const next = recordOutcomeWithResolver(
      pkg,
      decision.state,
      {
        actionId: decision.action!.id,
        status: 'succeeded',
        summary: 'repeat plan',
      },
      contextualResolver(),
      context,
    );

    expect(next.currentStep).toBe('plan');
    expect(next.status).toBe('running');
    expect(next.iteration).toBe(1);
  });

  it('passes immutable copies to resolver implementations', () => {
    const pkg = deterministic();
    const state = startRun(pkg, 'run-resolver-3', 'c'.repeat(64));
    const resolver: DeterministicResolver<ResolverContext> = {
      resolveStep(input) {
        expect(Object.isFrozen(input.pkg)).toBe(true);
        expect(Object.isFrozen(input.pkg.definition)).toBe(true);
        expect(Object.isFrozen(input.state)).toBe(true);
        expect(Object.isFrozen(input.state.retries)).toBe(true);
        expect(() => {
          (input.state as RunState).currentStep = 'finish';
        }).toThrow(TypeError);
        expect(() => {
          input.pkg.definition.metadata.name = 'mutated';
        }).toThrow(TypeError);
        return input.pkg.definition.orchestration.steps?.[0];
      },
      resolveNext() {
        return null;
      },
    };

    decideWithResolver(pkg, state, new Set(), resolver, {
      selectedStep: 'plan',
      nextStep: null,
    });

    expect(pkg.definition.metadata.name).toBe('demo');
    expect(state.currentStep).toBe('plan');
  });

  it('fails closed when a resolver returns an unknown current step', () => {
    const pkg = deterministic();
    const state = startRun(pkg, 'run-resolver-4', 'd'.repeat(64));
    const resolver: DeterministicResolver<ResolverContext> = {
      resolveStep() {
        return {
          id: 'missing',
          action: { type: 'checkpoint' },
        } satisfies SkillStep;
      },
      resolveNext() {
        return null;
      },
    };

    const decision = decideWithResolver(pkg, state, new Set(), resolver, {
      selectedStep: 'missing',
      nextStep: null,
    });

    expect(decision.action).toBeNull();
    expect(decision.state.status).toBe('failed');
    expect(decision.reason).toBe('Resolver returned unknown current step: missing');
  });

  it('rejects an unknown next step returned by a resolver', () => {
    const pkg = deterministic();
    const state = startRun(pkg, 'run-resolver-5', 'e'.repeat(64));
    const context = { selectedStep: 'plan', nextStep: 'missing' };
    const decision = decideWithResolver(pkg, state, new Set(), contextualResolver(), context);

    expect(() =>
      recordOutcomeWithResolver(
        pkg,
        decision.state,
        {
          actionId: decision.action!.id,
          status: 'succeeded',
          summary: 'invalid next',
        },
        contextualResolver(),
        context,
      ),
    ).toThrow('Resolver returned unknown next step: missing');
  });
});
