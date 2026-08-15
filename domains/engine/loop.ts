import { createHash } from 'crypto';
import type { ActionOutcome, EngineAction, RunState } from './types.js';
import { checkAction } from './guardrails.js';
import {
  resolveDeterministicNext,
  resolveDeterministicStep,
  staticDeterministicResolver,
  type DeterministicResolver,
} from './resolver.js';
import type { SkillPackage, SkillStep } from '../skill/types.js';

export interface Decision {
  state: RunState;
  action: EngineAction | null;
  reason?: string;
}

function actionId(runId: string, iteration: number, stepId: string | null): string {
  return createHash('sha256')
    .update(`${runId}:${iteration}:${stepId ?? 'adaptive'}`)
    .digest('hex')
    .slice(0, 16);
}

function stepFor(pkg: SkillPackage, id: string | null): SkillStep | undefined {
  return pkg.definition.orchestration.steps?.find((step) => step.id === id);
}

export function startRun(pkg: SkillPackage, runId: string, skillHash: string): RunState {
  return {
    runId,
    skill: pkg.definition.metadata.name,
    skillVersion: pkg.definition.metadata.version,
    skillHash,
    orchestration: pkg.definition.orchestration.mode,
    currentStep: pkg.definition.orchestration.entry ?? null,
    iteration: 0,
    pending: null,
    pendingRef: '.owner/pending-action.json',
    trajectoryRef: '.owner/trajectory.jsonl',
    contextRef: '.owner/context.md',
    artifactsRef: '.owner/artifacts.json',
    checkpointRef: '.owner/checkpoint.json',
    status: 'running',
    retries: {},
  };
}

export function decide(
  pkg: SkillPackage,
  state: RunState,
  confirmations: ReadonlySet<string>,
): Decision {
  return decideWithResolver(pkg, state, confirmations, staticDeterministicResolver, undefined);
}

export function decideWithResolver<TContext>(
  pkg: SkillPackage,
  state: RunState,
  confirmations: ReadonlySet<string>,
  resolver: DeterministicResolver<TContext>,
  context: TContext,
): Decision {
  if (state.status !== 'running') return { state, action: null, reason: `Run is ${state.status}` };
  if (state.pending)
    return { state, action: null, reason: `Action already pending: ${state.pending}` };
  if (state.orchestration === 'adaptive') {
    return { state, action: null, reason: 'Adaptive orchestration requires an Agent candidate' };
  }
  const resolvedStep = resolveDeterministicStep(resolver, pkg, state, context);
  if (!resolvedStep && state.currentStep === null) {
    return { state: { ...state, status: 'completed' }, action: null };
  }
  if (!resolvedStep) {
    return {
      state: { ...state, status: 'failed' },
      action: null,
      reason: `Unknown current step: ${state.currentStep}`,
    };
  }
  const step = stepFor(pkg, resolvedStep.id);
  if (!step) {
    return {
      state: { ...state, status: 'failed' },
      action: null,
      reason: `Resolver returned unknown current step: ${resolvedStep.id}`,
    };
  }
  const resolvedState = state.currentStep === step.id ? state : { ...state, currentStep: step.id };
  const action: EngineAction = {
    ...step.action,
    id: actionId(resolvedState.runId, resolvedState.iteration, step.id),
    stepId: step.id,
  };
  return acceptAction(pkg, resolvedState, action, confirmations);
}

function acceptAction(
  pkg: SkillPackage,
  state: RunState,
  action: EngineAction,
  confirmations: ReadonlySet<string>,
): Decision {
  const guard = checkAction(action, state, pkg.guardrails, confirmations);
  if (!guard.allowed) return { state, action: null, reason: guard.reason };
  return { state: { ...state, pending: action.id, status: 'waiting' }, action };
}

export function acceptAdaptiveAction(
  pkg: SkillPackage,
  state: RunState,
  action: EngineAction,
  confirmations: ReadonlySet<string>,
): Decision {
  if (state.orchestration !== 'adaptive') {
    return { state, action: null, reason: 'Run is not adaptive' };
  }
  if (state.status !== 'running') {
    return { state, action: null, reason: `Run is ${state.status}` };
  }
  if (state.pending) {
    return { state, action: null, reason: `Action already pending: ${state.pending}` };
  }
  return acceptAction(pkg, state, action, confirmations);
}

export function recordOutcome(
  pkg: SkillPackage,
  state: RunState,
  outcome: ActionOutcome,
): RunState {
  return recordOutcomeWithResolver(pkg, state, outcome, staticDeterministicResolver, undefined);
}

export function recordOutcomeWithResolver<TContext>(
  pkg: SkillPackage,
  state: RunState,
  outcome: ActionOutcome,
  resolver: DeterministicResolver<TContext>,
  context: TContext,
): RunState {
  if (!state.pending || state.pending !== outcome.actionId) {
    throw new Error(`Outcome does not match pending action: ${outcome.actionId}`);
  }
  const resolvedStep =
    state.orchestration === 'deterministic'
      ? resolveDeterministicStep(resolver, pkg, state, context)
      : undefined;
  const step = resolvedStep ? stepFor(pkg, resolvedStep.id) : undefined;
  if (state.orchestration === 'deterministic' && !resolvedStep) {
    throw new Error(`Unknown current step: ${state.currentStep ?? '(missing)'}`);
  }
  if (state.orchestration === 'deterministic' && !step) {
    throw new Error(`Resolver returned unknown current step: ${resolvedStep!.id}`);
  }
  if (outcome.status === 'failed') {
    const retries = {
      ...state.retries,
      [outcome.actionId]: (state.retries[outcome.actionId] ?? 0) + 1,
    };
    return { ...state, pending: null, status: 'running', retries };
  }
  const next =
    state.orchestration === 'deterministic'
      ? resolveDeterministicNext(resolver, pkg, state, step!, outcome, context)
      : state.currentStep;
  if (next !== null && state.orchestration === 'deterministic' && !stepFor(pkg, next)) {
    throw new Error(`Resolver returned unknown next step: ${next}`);
  }
  return {
    ...state,
    currentStep: next,
    iteration: state.iteration + 1,
    pending: null,
    status: next === null && state.orchestration === 'deterministic' ? 'completed' : 'running',
  };
}
