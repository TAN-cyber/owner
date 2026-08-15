import { describe, expect, it } from 'vitest';

import {
  applyLoopVerifierEnvelope,
  confirmLoopSkillCoordinatedPass,
  confirmLoopPortableAcceptance,
  recordLoopVerifierExecutionError,
  reserveLoopVerifierAttempt,
  retryLoopVerifier,
  submitLoopBuilderCandidate,
} from '../../../domains/owner-loop/loop-loop-runtime.js';
import { createLoopPortableState } from '../../../domains/owner-loop/loop-portable-state.js';
import { toLoopPortableText } from '../../../domains/owner-loop/loop-portable-text.js';
import type {
  LoopPortableCheckSummary,
  LoopPortableState,
} from '../../../domains/owner-loop/loop-portable-types.js';
import {
  createLoopRunnerChannel,
  LOOP_SKILL_COORDINATION,
} from '../../../domains/owner-loop/loop-runner-protocol.js';
import { loopPortableContinuation } from '../../../domains/owner-loop/loop-portable-continuation.js';

const checks: LoopPortableCheckSummary[] = [
  {
    id: 'unit',
    name: toLoopPortableText('Unit tests'),
    argv_display: [toLoopPortableText('test')],
    argv_truncated: false,
    cwd_ref: '.',
    status: 'passed',
    exit_code: 0,
    duration_ms: 25,
  },
];

function buildState(identityProvider = 'test-host'): {
  state: LoopPortableState;
  runner: ReturnType<typeof createLoopRunnerChannel>;
} {
  const runner = createLoopRunnerChannel();
  let state = confirmLoopPortableAcceptance({
    state: createLoopPortableState({ name: 'loop-change', language: 'en' }),
    acceptance: [
      { id: 'A1', source: 'brief.md', text: 'First behavior works.' },
      { id: 'A2', source: 'brief.md', text: 'Second behavior works.' },
    ],
  });
  state = submitLoopBuilderCandidate({
    state,
    input: {
      identity: runner.captureExecutionIdentity({
        identityProvider,
        executionRef: 'builder-1',
      }),
      candidateId: `candidate-${state.loop.iteration}`,
      summary: 'Implemented the candidate.',
      addressedAcceptanceIds: ['A1', 'A2'],
    },
  });
  state = reserveLoopVerifierAttempt(state);
  return { state, runner };
}

function envelope(
  runner: ReturnType<typeof createLoopRunnerChannel>,
  state: LoopPortableState,
  verdict: 'pass' | 'fail' | 'blocked',
  unresolved: string[] = [],
) {
  return runner.envelopeVerifierResponse({
    candidateId: state.builder_handoff!.candidate_id,
    identity: runner.captureExecutionIdentity({
      identityProvider: state.builder_handoff!.identity_provider,
      executionRef: `verifier-${state.loop.iteration}-${state.loop.attempt}`,
    }),
    payload: {
      kind: 'final-result',
      result: {
        iteration: state.loop.iteration,
        attempt: state.loop.attempt,
        verdict,
        acceptance: state.acceptance.map(({ id }) => ({
          id,
          result: unresolved.includes(id)
            ? verdict === 'blocked'
              ? 'blocked'
              : 'failed'
            : 'passed',
          reason: unresolved.includes(id) ? 'Behavior is missing.' : 'Behavior was observed.',
        })),
        risks: [],
        summary: verdict === 'pass' ? 'Everything passed.' : 'Some behavior is missing.',
      },
    },
  });
}

function resubmitRepair(
  runner: ReturnType<typeof createLoopRunnerChannel>,
  state: LoopPortableState,
): LoopPortableState {
  const submitted = submitLoopBuilderCandidate({
    state,
    input: {
      identity: runner.captureExecutionIdentity({
        identityProvider: state.builder_handoff!.identity_provider,
        executionRef: `builder-${state.loop.iteration}`,
      }),
      candidateId: `candidate-${state.loop.iteration}`,
      summary: 'Tried a new repair hypothesis.',
      addressedAcceptanceIds: state.acceptance.map(({ id }) => id),
    },
  });
  return reserveLoopVerifierAttempt(submitted);
}

describe('Loop portable Build/Verify loop', () => {
  it('requires user confirmation before a package-local pass becomes archive-ready', () => {
    const { state, runner } = buildState();
    const result = applyLoopVerifierEnvelope({
      state,
      envelope: envelope(runner, state, 'pass'),
      checks,
      maxVerifyFailures: 5,
    }).state;

    expect(result).toMatchObject({
      phase: 'verify',
      status: 'await-user',
      verification_result: 'pass',
      verification_report: 'verification.md',
      loop: { stage: 'await-user', iteration: 1, attempt: 1 },
    });
    expect(result.acceptance.every(({ result }) => result === 'passed')).toBe(true);
    expect(confirmLoopSkillCoordinatedPass(result)).toMatchObject({
      phase: 'archive',
      status: 'active',
      loop: { stage: 'archive-ready' },
    });
  });

  it('allows an explicitly empty Runtime check plan when Verifier covers every acceptance ID', () => {
    const { state, runner } = buildState();
    const result = applyLoopVerifierEnvelope({
      state,
      envelope: envelope(runner, state, 'pass'),
      checks: [],
      maxVerifyFailures: 5,
    }).state;

    expect(result).toMatchObject({
      phase: 'verify',
      status: 'await-user',
      verification_result: 'pass',
      verification: { checks: [] },
      loop: { stage: 'await-user', iteration: 1, attempt: 1 },
    });
    expect(result.acceptance.map(({ result: acceptanceResult }) => acceptanceResult)).toEqual([
      'passed',
      'passed',
    ]);
  });

  it('returns an implementation failure to a new Build iteration', () => {
    const { state, runner } = buildState();
    const result = applyLoopVerifierEnvelope({
      state,
      envelope: envelope(runner, state, 'fail', ['A2']),
      checks,
      maxVerifyFailures: 5,
    }).state;

    expect(result).toMatchObject({
      phase: 'build',
      status: 'active',
      verification_result: 'fail',
      verification_report: 'verification.md',
      loop: {
        stage: 'repairing',
        iteration: 2,
        attempt: 0,
        failed_iteration_count: 1,
        previous_unresolved_ids: ['A2'],
      },
    });
  });

  it('counts alternating and increased unresolved sets as no progress, but resets on a strict subset', () => {
    const prepared = buildState();
    let { state } = prepared;
    const { runner } = prepared;
    state = applyLoopVerifierEnvelope({
      state,
      envelope: envelope(runner, state, 'fail', ['A1']),
      checks,
      maxVerifyFailures: 10,
    }).state;
    expect(state.loop.no_progress_count).toBe(0);

    state = resubmitRepair(runner, state);
    state = applyLoopVerifierEnvelope({
      state,
      envelope: envelope(runner, state, 'fail', ['A2']),
      checks,
      maxVerifyFailures: 10,
    }).state;
    expect(state.loop.no_progress_count).toBe(1);

    state = resubmitRepair(runner, state);
    state = applyLoopVerifierEnvelope({
      state,
      envelope: envelope(runner, state, 'fail', ['A1', 'A2']),
      checks,
      maxVerifyFailures: 10,
    }).state;
    expect(state.loop.no_progress_count).toBe(2);
    expect(state.blockers[0]?.reason.text).toContain('different repair hypothesis');

    state = resubmitRepair(runner, state);
    state = applyLoopVerifierEnvelope({
      state,
      envelope: envelope(runner, state, 'fail', ['A1']),
      checks,
      maxVerifyFailures: 10,
    }).state;
    expect(state).toMatchObject({
      status: 'active',
      loop: { no_progress_count: 0, stage: 'repairing' },
    });
  });

  it('stops alternating unresolved sets after three non-progressive results', () => {
    const prepared = buildState();
    let { state } = prepared;
    const { runner } = prepared;
    for (const unresolved of [['A1'], ['A2'], ['A1'], ['A2']]) {
      state = applyLoopVerifierEnvelope({
        state,
        envelope: envelope(runner, state, 'fail', unresolved),
        checks,
        maxVerifyFailures: 10,
      }).state;
      if (state.status === 'active') state = resubmitRepair(runner, state);
    }

    expect(state).toMatchObject({
      status: 'await-user',
      verification_report: 'verification.md',
      loop: { no_progress_count: 3, stage: 'await-user' },
    });
    expect(loopPortableContinuation(state)).toMatchObject({
      disposition: 'await-user',
      action: 'resolve-loop-stop',
      commandArgs: [
        'owner',
        'loop',
        'next',
        state.name,
        '--return-to-build',
        '--summary',
        '<summary>',
      ],
      requiredInputs: ['summary', 'user-decision'],
    });
  });

  it('keeps a report reference for a semantic blocker', () => {
    const { state, runner } = buildState();
    const result = applyLoopVerifierEnvelope({
      state,
      envelope: envelope(runner, state, 'blocked', ['A2']),
      checks,
      maxVerifyFailures: 5,
    }).state;

    expect(result).toMatchObject({
      status: 'await-user',
      verification_result: 'blocked',
      verification_report: 'verification.md',
      loop: { next_action: 'resolve-verifier-blocker' },
    });
  });

  it('blocks after three execution errors without consuming semantic failure budgets', () => {
    let { state } = buildState();
    for (let index = 0; index < 3; index += 1) {
      state = recordLoopVerifierExecutionError({
        state,
        summary: `Verifier crashed ${index + 1}.`,
      });
      if (index < 2) {
        expect(() =>
          recordLoopVerifierExecutionError({ state, summary: 'Stale duplicate error.' }),
        ).toThrow('active Verify attempt');
        state = reserveLoopVerifierAttempt(state);
      }
    }

    expect(state).toMatchObject({
      phase: 'verify',
      status: 'blocked',
      loop: {
        stage: 'blocked',
        attempt: 3,
        execution_failure_count: 3,
        failed_iteration_count: 0,
        no_progress_count: 0,
      },
    });
    const retried = retryLoopVerifier(state);
    expect(retried.loop).toMatchObject({
      stage: 'verify-ready',
      retry_epoch: 1,
      execution_failure_count: 0,
      attempt: 3,
    });
  });

  it('rejects a stale execution error after a Skill-coordinated pass', () => {
    const { state, runner } = buildState(LOOP_SKILL_COORDINATION);
    const passed = applyLoopVerifierEnvelope({
      state,
      envelope: envelope(runner, state, 'pass'),
      checks,
      maxVerifyFailures: 5,
    }).state;

    expect(passed).toMatchObject({
      phase: 'verify',
      status: 'await-user',
      verification_result: 'pass',
      loop: { next_action: 'confirm-skill-coordinated-pass' },
    });
    expect(() =>
      recordLoopVerifierExecutionError({ state: passed, summary: 'Late failure.' }),
    ).toThrow('active Verify attempt');
  });

  it('does not accept a pass when the final Runtime check failed', () => {
    const { state, runner } = buildState();
    expect(() =>
      applyLoopVerifierEnvelope({
        state,
        envelope: envelope(runner, state, 'pass'),
        checks: [{ ...checks[0], status: 'failed', exit_code: 1 }],
        maxVerifyFailures: 5,
      }),
    ).toThrow('required check');
  });

  it('stores long diagnostic reasons as truncated previews without invalidating the decision', () => {
    const { state, runner } = buildState();
    const trusted = runner.envelopeVerifierResponse({
      candidateId: state.builder_handoff!.candidate_id,
      identity: runner.captureExecutionIdentity({
        identityProvider: 'test-host',
        executionRef: 'verifier-long',
      }),
      payload: {
        kind: 'final-result',
        result: {
          iteration: state.loop.iteration,
          attempt: state.loop.attempt,
          verdict: 'fail',
          acceptance: state.acceptance.map(({ id }, index) => ({
            id,
            result: index === 0 ? 'failed' : 'passed',
            reason: '鱼'.repeat(100_000),
          })),
          risks: ['risk'.repeat(100_000)],
          summary: 'summary'.repeat(100_000),
        },
      },
    });
    const result = applyLoopVerifierEnvelope({
      state,
      envelope: trusted,
      checks,
      maxVerifyFailures: 5,
    }).state;

    expect(result.acceptance[0].reason).toMatchObject({ truncated: true });
    expect(result.verification?.summary).toMatchObject({ truncated: true });
    expect(result.verification?.risks[0]).toMatchObject({ truncated: true });
    expect(result.verification_result).toBe('fail');
  });
});
