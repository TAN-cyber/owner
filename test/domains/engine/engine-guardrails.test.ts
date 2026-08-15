import { describe, expect, it } from 'vitest';
import { checkAction } from '../../../domains/engine/guardrails.js';
import type { EngineAction, RunState } from '../../../domains/engine/types.js';
import type { GuardrailDefinition } from '../../../domains/skill/types.js';

const guardrails: GuardrailDefinition = {
  allowedSkills: ['writing-plans'],
  allowedAgents: ['reviewer'],
  allowedTools: ['read-only'],
  maxIterations: 2,
  maxRetriesPerAction: 1,
  confirmationRequiredFor: ['read-only'],
};

const state = (): RunState => ({
  runId: 'r',
  skill: 'demo',
  skillVersion: '1',
  skillHash: 'a'.repeat(64),
  orchestration: 'adaptive',
  currentStep: null,
  iteration: 0,
  pending: null,
  pendingRef: '.owner/pending-action.json',
  trajectoryRef: '.owner/trajectory.jsonl',
  contextRef: '.owner/context.md',
  artifactsRef: '.owner/artifacts.json',
  checkpointRef: '.owner/checkpoint.json',
  status: 'running',
  retries: {},
});

const action = (over: Partial<EngineAction> = {}): EngineAction => ({
  id: 'a1',
  stepId: null,
  type: 'invoke_skill',
  ref: 'writing-plans',
  ...over,
});

describe('checkAction', () => {
  it('allows authorized actions', () => {
    expect(checkAction(action(), state(), guardrails, new Set())).toEqual({ allowed: true });
  });

  it('rejects unauthorized refs, budgets and missing confirmation', () => {
    expect(checkAction(action({ ref: 'unknown' }), state(), guardrails, new Set())).toEqual({
      allowed: false,
      reason: 'Skill is not allowed: unknown',
    });
    expect(checkAction(action(), { ...state(), iteration: 2 }, guardrails, new Set()).allowed).toBe(
      false,
    );
    expect(
      checkAction(action({ type: 'call_tool', ref: 'read-only' }), state(), guardrails, new Set()),
    ).toEqual({ allowed: false, reason: 'User confirmation required for: read-only' });
    expect(
      checkAction(action({ type: 'handoff', ref: 'unknown' }), state(), guardrails, new Set()),
    ).toEqual({ allowed: false, reason: 'Agent is not allowed: unknown' });
  });
});
