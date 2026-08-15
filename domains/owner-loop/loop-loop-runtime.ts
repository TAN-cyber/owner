import { randomUUID } from 'node:crypto';

import { appendLoopPortableHistory, parseLoopPortableState } from './loop-portable-state.js';
import { toLoopPortableText } from './loop-portable-text.js';
import type {
  LoopBuilderCheckSummary,
  LoopPortableAcceptanceState,
  LoopPortableCheckSummary,
  LoopPortableHistoryEntry,
  LoopPortableState,
  LoopPortableVerificationState,
} from './loop-portable-types.js';
import {
  isLoopTrustedExecutionIdentity,
  LOOP_SKILL_COORDINATION,
  type LoopTrustedExecutionIdentity,
  type LoopTrustedVerifierEnvelope,
} from './loop-runner-protocol.js';
import {
  validateLoopTrustedVerifierEnvelope,
  type LoopVerifierResponse,
} from './loop-verifier-protocol.js';

export const LOOP_MAX_VERIFIER_EXECUTION_FAILURES = 3;
export const LOOP_MAX_REQUEST_CHECK_ROUNDS = 2;

export interface LoopBuilderCandidateInput {
  identity: LoopTrustedExecutionIdentity;
  summary: string;
  addressedAcceptanceIds: string[];
  checks?: Array<{ name: string; result: 'passed' | 'failed' | 'not-run'; note?: string | null }>;
  knownLimits?: string[];
  candidateId?: string;
  now?: Date;
}

function nextVersion(state: LoopPortableState): number {
  return state.state_version + 1;
}

function uniqueKnownIds(
  values: readonly string[],
  acceptance: readonly LoopPortableAcceptanceState[],
  label: string,
): string[] {
  const ids = [...values];
  if (new Set(ids).size !== ids.length) throw new Error(`${label} contains duplicate IDs`);
  const known = new Set(acceptance.map(({ id }) => id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) throw new Error(`${label} contains unknown IDs: ${unknown.join(', ')}`);
  return ids;
}

function pendingAcceptance(
  acceptance: readonly LoopPortableAcceptanceState[],
): LoopPortableAcceptanceState[] {
  return acceptance.map((entry) => ({ ...entry, result: 'pending', reason: null }));
}

function builderChecks(checks: LoopBuilderCandidateInput['checks']): LoopBuilderCheckSummary[] {
  return (checks ?? []).map((check) => ({
    name: toLoopPortableText(check.name),
    result: check.result,
    note: check.note ? toLoopPortableText(check.note) : null,
  }));
}

function historyEntry(options: {
  state: LoopPortableState;
  outcome: LoopPortableHistoryEntry['outcome'];
  unresolvedIds?: string[];
  summary: string;
  completedAt: string;
}): LoopPortableHistoryEntry {
  return {
    goal_cycle: options.state.loop.goal_cycle,
    iteration: options.state.loop.iteration,
    attempt: options.state.loop.attempt,
    outcome: options.outcome,
    unresolved_ids: options.unresolvedIds ?? [],
    summary: toLoopPortableText(options.summary),
    completed_at: options.completedAt,
  };
}

export function confirmLoopPortableAcceptance(options: {
  state: LoopPortableState;
  acceptance: Array<Pick<LoopPortableAcceptanceState, 'id' | 'source' | 'text'>>;
}): LoopPortableState {
  const state = parseLoopPortableState(options.state);
  if (state.phase !== 'shape' || state.status !== 'active') {
    throw new Error('Loop acceptance can only be confirmed from active Shape');
  }
  if (options.acceptance.length === 0) {
    throw new Error('Loop acceptance cannot be empty');
  }
  const ids = options.acceptance.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new Error('Loop acceptance IDs must be unique');
  return parseLoopPortableState({
    ...state,
    phase: 'build',
    state_version: nextVersion(state),
    loop: {
      ...state.loop,
      stage: 'building',
      iteration: 1,
      attempt: 0,
      next_action: 'submit-builder-candidate',
    },
    acceptance: options.acceptance.map((entry) => ({ ...entry, result: 'pending', reason: null })),
  });
}

export function submitLoopBuilderCandidate(options: {
  state: LoopPortableState;
  input: LoopBuilderCandidateInput;
}): LoopPortableState {
  const state = parseLoopPortableState(options.state);
  const { input } = options;
  if (state.phase !== 'build' || state.status !== 'active') {
    throw new Error('Loop candidate can only be submitted from active Build');
  }
  if (!isLoopTrustedExecutionIdentity(input.identity)) {
    throw new Error('Loop Builder identity must come from the trusted Runner channel');
  }
  const addressed = uniqueKnownIds(
    input.addressedAcceptanceIds,
    state.acceptance,
    'Loop Builder addressed acceptance',
  );
  const now = (input.now ?? new Date()).toISOString();
  return parseLoopPortableState({
    ...state,
    phase: 'verify',
    state_version: nextVersion(state),
    verification_result: 'pending',
    verification_report: null,
    verification: null,
    blockers: [],
    acceptance: pendingAcceptance(state.acceptance),
    builder_handoff: {
      candidate_id: input.candidateId ?? randomUUID(),
      identity_provider: input.identity.identityProvider,
      builder_execution_ref: input.identity.executionRef,
      iteration: state.loop.iteration,
      summary: toLoopPortableText(input.summary),
      addressed_acceptance_ids: addressed,
      checks: builderChecks(input.checks),
      checks_truncated: false,
      known_limits: (input.knownLimits ?? []).map((entry) => toLoopPortableText(entry)),
      known_limits_truncated: false,
      submitted_at: now,
    },
    loop: {
      ...state.loop,
      stage: 'verify-ready',
      attempt: 0,
      execution_failure_count: 0,
      next_action: 'run-required-checks-and-dispatch-verifier',
    },
  });
}

export function reserveLoopVerifierAttempt(stateInput: LoopPortableState): LoopPortableState {
  const state = parseLoopPortableState(stateInput);
  if (
    state.phase !== 'verify' ||
    state.status !== 'active' ||
    state.loop.stage !== 'verify-ready' ||
    state.builder_handoff === null
  ) {
    throw new Error('Loop Verifier attempt is not ready to dispatch');
  }
  return parseLoopPortableState({
    ...state,
    state_version: nextVersion(state),
    loop: {
      ...state.loop,
      attempt: state.loop.attempt + 1,
      next_action: 'await-verifier-result',
    },
  });
}

function progressCounters(state: LoopPortableState, unresolvedIds: string[]): number {
  const previous = state.loop.previous_unresolved_ids;
  if (previous.length === 0) return 0;
  const previousSet = new Set(previous);
  const currentSet = new Set(unresolvedIds);
  const strictSubset =
    currentSet.size < previousSet.size && [...currentSet].every((id) => previousSet.has(id));
  return strictSubset ? 0 : state.loop.no_progress_count + 1;
}

function verificationState(options: {
  state: LoopPortableState;
  envelope: LoopTrustedVerifierEnvelope<unknown>;
  response: Extract<LoopVerifierResponse, { kind: 'final-result' }>;
  checks: LoopPortableCheckSummary[];
  completedAt: string;
}): LoopPortableVerificationState {
  return {
    candidate_id: options.envelope.candidateId,
    identity_provider: options.envelope.identityProvider,
    verifier_execution_ref: options.envelope.verifierExecutionRef,
    iteration: options.state.loop.iteration,
    attempt: options.state.loop.attempt,
    assurance:
      options.envelope.identityProvider === LOOP_SKILL_COORDINATION
        ? 'skill-coordinated'
        : 'host-attested',
    verdict: options.response.result.verdict,
    checks: options.checks,
    summary: toLoopPortableText(options.response.result.summary),
    risks: options.response.result.risks.map((risk) => toLoopPortableText(risk)),
    risks_truncated: false,
    completed_at: options.completedAt,
  };
}

export function applyLoopVerifierEnvelope(options: {
  state: LoopPortableState;
  envelope: LoopTrustedVerifierEnvelope<unknown> | unknown;
  checks: LoopPortableCheckSummary[];
  maxVerifyFailures: number;
  now?: Date;
}): { state: LoopPortableState; response: LoopVerifierResponse } {
  const state = parseLoopPortableState(options.state);
  if (state.phase !== 'verify' || state.builder_handoff === null || state.loop.attempt < 1) {
    throw new Error('Loop change is not awaiting a Verifier result');
  }
  const response = validateLoopTrustedVerifierEnvelope({
    envelope: options.envelope,
    binding: {
      candidateId: state.builder_handoff.candidate_id,
      identityProvider: state.builder_handoff.identity_provider,
      builderExecutionRef: state.builder_handoff.builder_execution_ref,
      iteration: state.loop.iteration,
      attempt: state.loop.attempt,
      acceptanceIds: state.acceptance.map(({ id }) => id),
      requiredChecksPassed: options.checks.every(({ status }) => status === 'passed'),
    },
  });
  if (response.kind === 'request-checks') return { state, response };

  if (!Number.isSafeInteger(options.maxVerifyFailures) || options.maxVerifyFailures < 1) {
    throw new Error('Loop max Verify failures must be a positive integer');
  }
  const completedAt = (options.now ?? new Date()).toISOString();
  const acceptanceById = new Map(response.result.acceptance.map((entry) => [entry.id, entry]));
  const acceptance = state.acceptance.map((entry) => {
    const result = acceptanceById.get(entry.id)!;
    return {
      ...entry,
      result: result.result,
      reason: toLoopPortableText(result.reason),
    };
  });
  const unresolvedIds = acceptance
    .filter(({ result }) => result === 'failed' || result === 'blocked')
    .map(({ id }) => id);
  const verification = verificationState({
    state,
    envelope: options.envelope as LoopTrustedVerifierEnvelope<unknown>,
    response,
    checks: options.checks,
    completedAt,
  });

  if (response.result.verdict === 'pass') {
    const withHistory = appendLoopPortableHistory(
      { ...state, acceptance, verification } as LoopPortableState,
      historyEntry({
        state,
        outcome: 'pass',
        summary: response.result.summary,
        completedAt,
      }),
    );
    const skillCoordinated = state.builder_handoff.identity_provider === LOOP_SKILL_COORDINATION;
    return {
      response,
      state: parseLoopPortableState({
        ...withHistory,
        phase: skillCoordinated ? 'verify' : 'archive',
        status: skillCoordinated ? 'await-user' : 'active',
        state_version: nextVersion(state),
        verification_result: 'pass',
        verification_report: 'verification.md',
        blockers: skillCoordinated
          ? [
              {
                owner: 'user',
                reason: toLoopPortableText(
                  'The generic Skill bridge cannot prove an independent Verifier execution; user confirmation is required before Archive.',
                ),
                acceptance_ids: [],
                resolution_action: 'await-user',
              },
            ]
          : [],
        loop: {
          ...state.loop,
          stage: skillCoordinated ? 'await-user' : 'archive-ready',
          execution_failure_count: 0,
          previous_unresolved_ids: [],
          no_progress_count: 0,
          next_action: skillCoordinated ? 'confirm-skill-coordinated-pass' : 'archive',
        },
      }),
    };
  }

  if (response.result.verdict === 'blocked') {
    const withHistory = appendLoopPortableHistory(
      { ...state, acceptance, verification } as LoopPortableState,
      historyEntry({
        state,
        outcome: 'blocked',
        unresolvedIds,
        summary: response.result.summary,
        completedAt,
      }),
    );
    return {
      response,
      state: parseLoopPortableState({
        ...withHistory,
        status: 'await-user',
        state_version: nextVersion(state),
        verification_result: 'blocked',
        verification_report: 'verification.md',
        blockers: [
          {
            owner: 'user',
            reason: toLoopPortableText(response.result.summary),
            acceptance_ids: unresolvedIds,
            resolution_action: 'resolve-verifier-blocker',
          },
        ],
        loop: {
          ...state.loop,
          stage: 'await-user',
          execution_failure_count: 0,
          previous_unresolved_ids: unresolvedIds,
          next_action: 'resolve-verifier-blocker',
        },
      }),
    };
  }

  const failedIterationCount = state.loop.failed_iteration_count + 1;
  const noProgressCount = progressCounters(state, unresolvedIds);
  const limitReached = failedIterationCount >= options.maxVerifyFailures;
  const stalled = noProgressCount >= 3;
  const stop = limitReached || stalled;
  const withHistory = appendLoopPortableHistory(
    { ...state, acceptance, verification } as LoopPortableState,
    historyEntry({
      state,
      outcome: 'fail',
      unresolvedIds,
      summary: response.result.summary,
      completedAt,
    }),
  );
  return {
    response,
    state: parseLoopPortableState({
      ...withHistory,
      phase: stop ? 'verify' : 'build',
      status: stop ? 'await-user' : 'active',
      state_version: nextVersion(state),
      verification_result: 'fail',
      verification_report: 'verification.md',
      // Keep the failed candidate handoff while Build repairs it so zero-context
      // recovery and read-only status views can explain the previous conclusion. The next
      // candidate submission replaces this handoff atomically.
      builder_handoff: state.builder_handoff,
      blockers: stop
        ? [
            {
              owner: 'user',
              reason: toLoopPortableText(
                limitReached
                  ? 'Loop verification reached the configured failed iteration limit.'
                  : 'Loop verification did not strictly reduce the unresolved acceptance set three times.',
              ),
              acceptance_ids: unresolvedIds,
              resolution_action: 'await-user',
            },
          ]
        : noProgressCount >= 2
          ? [
              {
                owner: 'builder',
                reason: toLoopPortableText(
                  'Loop verification has not made reliable progress twice; use a different repair hypothesis before resubmitting.',
                ),
                acceptance_ids: unresolvedIds,
                resolution_action: 'return-build',
              },
            ]
          : [],
      loop: {
        ...state.loop,
        stage: stop ? 'await-user' : 'repairing',
        iteration: stop ? state.loop.iteration : state.loop.iteration + 1,
        attempt: stop ? state.loop.attempt : 0,
        failed_iteration_count: failedIterationCount,
        no_progress_count: noProgressCount,
        execution_failure_count: 0,
        previous_unresolved_ids: unresolvedIds,
        next_action: stop ? 'await-user' : 'repair-failed-acceptance',
      },
    }),
  };
}

export function confirmLoopSkillCoordinatedPass(stateInput: LoopPortableState): LoopPortableState {
  const state = parseLoopPortableState(stateInput);
  if (
    state.phase !== 'verify' ||
    state.status !== 'await-user' ||
    state.verification_result !== 'pass' ||
    state.verification === null ||
    state.builder_handoff?.identity_provider !== LOOP_SKILL_COORDINATION ||
    state.loop.stage !== 'await-user' ||
    state.loop.next_action !== 'confirm-skill-coordinated-pass'
  ) {
    throw new Error('Loop change is not awaiting Skill-coordinated pass confirmation');
  }
  return parseLoopPortableState({
    ...state,
    phase: 'archive',
    status: 'active',
    state_version: nextVersion(state),
    blockers: [],
    loop: {
      ...state.loop,
      stage: 'archive-ready',
      next_action: 'archive',
    },
  });
}

export function recordLoopVerifierUnavailable(options: {
  state: LoopPortableState;
  checks: LoopPortableCheckSummary[];
  verifierExecutionRef: string;
  summary: string;
  now?: Date;
}): LoopPortableState {
  const state = parseLoopPortableState(options.state);
  if (
    state.phase !== 'verify' ||
    state.status !== 'active' ||
    state.builder_handoff?.identity_provider !== LOOP_SKILL_COORDINATION ||
    state.loop.attempt < 1 ||
    state.loop.next_action !== 'await-verifier-result'
  ) {
    throw new Error('Loop semantic verification unavailability requires an active Skill attempt');
  }
  if (options.checks.some(({ status }) => status !== 'passed')) {
    throw new Error(
      'Loop semantic verification unavailability requires every resolved Runtime check to pass',
    );
  }
  const completedAt = (options.now ?? new Date()).toISOString();
  const acceptanceIds = state.acceptance.map(({ id }) => id);
  const withHistory = appendLoopPortableHistory(
    state,
    historyEntry({
      state,
      outcome: 'blocked',
      unresolvedIds: acceptanceIds,
      summary: options.summary,
      completedAt,
    }),
  );
  return parseLoopPortableState({
    ...withHistory,
    status: 'await-user',
    state_version: nextVersion(state),
    verification_result: 'blocked',
    verification_report: 'verification.md',
    verification: {
      candidate_id: state.builder_handoff.candidate_id,
      identity_provider: state.builder_handoff.identity_provider,
      verifier_execution_ref: options.verifierExecutionRef,
      iteration: state.loop.iteration,
      attempt: state.loop.attempt,
      assurance: 'semantic-verification-unavailable',
      verdict: 'blocked',
      checks: options.checks,
      summary: toLoopPortableText(options.summary),
      risks: [
        toLoopPortableText(
          'No independent semantic Verifier execution was available; Runtime checks alone do not cover acceptance semantics.',
        ),
      ],
      risks_truncated: false,
      completed_at: completedAt,
    },
    blockers: [
      {
        owner: 'user',
        reason: toLoopPortableText(
          'Independent semantic verification is unavailable on this platform; only completed Runtime checks are available, so explicit user confirmation is required before Archive.',
        ),
        acceptance_ids: acceptanceIds,
        resolution_action: 'confirm-verifier-unavailable',
      },
    ],
    loop: {
      ...state.loop,
      stage: 'await-user',
      previous_unresolved_ids: acceptanceIds,
      execution_failure_count: 0,
      next_action: 'confirm-verifier-unavailable',
    },
  });
}

export function confirmLoopVerifierUnavailable(options: {
  state: LoopPortableState;
  summary: string;
  now?: Date;
}): LoopPortableState {
  const state = parseLoopPortableState(options.state);
  if (
    state.phase !== 'verify' ||
    state.status !== 'await-user' ||
    state.verification_result !== 'blocked' ||
    state.verification?.assurance !== 'semantic-verification-unavailable' ||
    state.loop.stage !== 'await-user' ||
    state.loop.next_action !== 'confirm-verifier-unavailable'
  ) {
    throw new Error('Loop change is not awaiting degraded verification confirmation');
  }
  const completedAt = (options.now ?? new Date()).toISOString();
  const confirmation = toLoopPortableText(options.summary);
  const withHistory = appendLoopPortableHistory(
    state,
    historyEntry({
      state,
      outcome: 'pass',
      summary: options.summary,
      completedAt,
    }),
  );
  return parseLoopPortableState({
    ...withHistory,
    phase: 'archive',
    status: 'active',
    state_version: nextVersion(state),
    verification_result: 'pass',
    verification: {
      ...state.verification,
      assurance: 'user-confirmed-degraded',
      verdict: 'pass',
      summary: confirmation,
      completed_at: completedAt,
    },
    acceptance: state.acceptance.map((entry) => ({
      ...entry,
      result: 'passed',
      reason: toLoopPortableText(
        `User confirmed degraded completion without independent semantic verification: ${options.summary}`,
      ),
    })),
    blockers: [],
    loop: {
      ...state.loop,
      stage: 'archive-ready',
      previous_unresolved_ids: [],
      next_action: 'archive',
    },
  });
}

export function resolveLoopVerifierBlocker(stateInput: LoopPortableState): LoopPortableState {
  const state = parseLoopPortableState(stateInput);
  if (
    state.phase !== 'verify' ||
    state.status !== 'await-user' ||
    state.verification_result !== 'blocked' ||
    state.verification?.verdict !== 'blocked' ||
    state.verification.assurance === 'semantic-verification-unavailable' ||
    state.loop.stage !== 'await-user' ||
    state.loop.next_action !== 'resolve-verifier-blocker' ||
    !state.blockers.some(
      ({ resolution_action }) => resolution_action === 'resolve-verifier-blocker',
    )
  ) {
    throw new Error('Loop change is not awaiting resolution of a semantic Verifier blocker');
  }
  return parseLoopPortableState({
    ...state,
    status: 'active',
    state_version: nextVersion(state),
    verification_result: 'pending',
    verification_report: null,
    verification: null,
    acceptance: pendingAcceptance(state.acceptance),
    blockers: [],
    loop: {
      ...state.loop,
      stage: 'verify-ready',
      retry_epoch: state.loop.retry_epoch + 1,
      execution_failure_count: 0,
      next_action: 'dispatch-new-verifier',
    },
  });
}

export function recordLoopVerifierExecutionError(options: {
  state: LoopPortableState;
  summary: string;
  now?: Date;
}): LoopPortableState {
  const state = parseLoopPortableState(options.state);
  if (
    state.phase !== 'verify' ||
    state.status !== 'active' ||
    state.loop.attempt < 1 ||
    state.loop.next_action !== 'await-verifier-result'
  ) {
    throw new Error('Loop Verifier execution error requires an active Verify attempt');
  }
  const completedAt = (options.now ?? new Date()).toISOString();
  const failureCount = state.loop.execution_failure_count + 1;
  const blocked = failureCount >= LOOP_MAX_VERIFIER_EXECUTION_FAILURES;
  const withHistory = appendLoopPortableHistory(
    state,
    historyEntry({
      state,
      outcome: 'execution-error',
      summary: options.summary,
      completedAt,
    }),
  );
  return parseLoopPortableState({
    ...withHistory,
    status: blocked ? 'blocked' : 'active',
    state_version: nextVersion(state),
    blockers: blocked
      ? [
          {
            owner: 'runtime',
            reason: toLoopPortableText(options.summary),
            acceptance_ids: [],
            resolution_action: 'retry-verifier',
          },
        ]
      : [],
    loop: {
      ...state.loop,
      stage: blocked ? 'blocked' : 'verify-ready',
      execution_failure_count: failureCount,
      next_action: blocked ? 'retry-verifier' : 'dispatch-new-verifier',
    },
  });
}

export function retryLoopVerifier(stateInput: LoopPortableState): LoopPortableState {
  const state = parseLoopPortableState(stateInput);
  if (
    state.phase !== 'verify' ||
    state.status !== 'blocked' ||
    !state.blockers.some(({ resolution_action }) => resolution_action === 'retry-verifier')
  ) {
    throw new Error('Loop change is not blocked on Verifier infrastructure');
  }
  return parseLoopPortableState({
    ...state,
    status: 'active',
    state_version: nextVersion(state),
    blockers: [],
    loop: {
      ...state.loop,
      stage: 'verify-ready',
      retry_epoch: state.loop.retry_epoch + 1,
      execution_failure_count: 0,
      next_action: 'dispatch-new-verifier',
    },
  });
}

export function returnLoopCandidateToBuild(options: {
  state: LoopPortableState;
  reason: string;
  now?: Date;
}): LoopPortableState {
  const state = parseLoopPortableState(options.state);
  if (state.phase !== 'verify' && state.phase !== 'archive') {
    throw new Error('Only Verify or Archive can return a candidate to Build');
  }
  const completedAt = (options.now ?? new Date()).toISOString();
  const withHistory = appendLoopPortableHistory(
    state,
    historyEntry({
      state,
      outcome: 'recovery',
      summary: options.reason,
      completedAt,
    }),
  );
  return parseLoopPortableState({
    ...withHistory,
    phase: 'build',
    status: 'active',
    state_version: nextVersion(state),
    verification_result: 'pending',
    verification_report: null,
    verification: null,
    builder_handoff: null,
    blockers: [],
    acceptance: pendingAcceptance(state.acceptance),
    loop: {
      ...state.loop,
      stage: 'repairing',
      iteration: state.loop.iteration + 1,
      attempt: 0,
      execution_failure_count: 0,
      next_action: 'submit-builder-candidate',
    },
  });
}
