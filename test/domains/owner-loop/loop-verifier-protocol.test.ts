import { describe, expect, it } from 'vitest';

import {
  createLoopRunnerChannel,
  LOOP_SKILL_COORDINATION,
} from '../../../domains/owner-loop/loop-runner-protocol.js';
import {
  validateLoopTrustedVerifierEnvelope,
  type LoopVerifierBinding,
} from '../../../domains/owner-loop/loop-verifier-protocol.js';

const binding: LoopVerifierBinding = {
  candidateId: 'candidate-1',
  identityProvider: LOOP_SKILL_COORDINATION,
  builderExecutionRef: 'builder-1',
  iteration: 1,
  attempt: 1,
  acceptanceIds: ['A1', 'A2'],
  requiredChecksPassed: true,
};

function finalResult(
  acceptance = [
    { id: 'A1', result: 'passed', reason: 'Observed the expected first behavior.' },
    { id: 'A2', result: 'passed', reason: 'Observed the expected second behavior.' },
  ],
) {
  return {
    kind: 'final-result',
    result: {
      iteration: 1,
      attempt: 1,
      verdict: 'pass',
      acceptance,
      risks: [],
      summary: 'All acceptance criteria passed.',
    },
  };
}

describe('Loop package-local Verifier protocol', () => {
  it('accepts one complete Skill-coordinated result from a different execution', () => {
    const runner = createLoopRunnerChannel();
    const identity = runner.captureExecutionIdentity({
      identityProvider: 'codex-host',
      executionRef: 'verifier-1',
    });
    const envelope = runner.envelopeVerifierResponse({
      candidateId: 'candidate-1',
      identity,
      payload: finalResult(),
    });

    expect(validateLoopTrustedVerifierEnvelope({ envelope, binding })).toMatchObject({
      kind: 'final-result',
      result: { verdict: 'pass' },
    });
  });

  it('rejects an Agent-shaped plain object even if it forges identity fields', () => {
    expect(() =>
      validateLoopTrustedVerifierEnvelope({
        envelope: {
          candidateId: 'candidate-1',
          identityProvider: 'codex-host',
          verifierExecutionRef: 'verifier-1',
          payload: finalResult(),
        },
        binding,
      }),
    ).toThrow('trusted Runner');
  });

  it('does not trust a caller-provided host identity provider', () => {
    const runner = createLoopRunnerChannel();
    const identity = runner.captureExecutionIdentity({
      identityProvider: 'caller-claimed-host',
      executionRef: 'verifier-1',
    });

    expect(identity.identityProvider).toBe(LOOP_SKILL_COORDINATION);
  });

  it('rejects same-execution self verification', () => {
    const runner = createLoopRunnerChannel();
    const envelope = runner.envelopeVerifierResponse({
      candidateId: 'candidate-1',
      identity: runner.captureExecutionIdentity({
        identityProvider: 'caller-claimed-host',
        executionRef: 'builder-1',
      }),
      payload: finalResult(),
    });
    expect(() => validateLoopTrustedVerifierEnvelope({ envelope, binding })).toThrow(
      'different executions',
    );
  });

  it.each([
    [[{ id: 'A1', result: 'passed', reason: 'ok' }], 'missing'],
    [
      [
        { id: 'A1', result: 'passed', reason: 'ok' },
        { id: 'A1', result: 'passed', reason: 'again' },
      ],
      'duplicate',
    ],
    [
      [
        { id: 'A1', result: 'passed', reason: 'ok' },
        { id: 'A3', result: 'passed', reason: 'unknown' },
      ],
      'unknown',
    ],
  ])('rejects incomplete acceptance coverage (%s)', (acceptance, message) => {
    const runner = createLoopRunnerChannel();
    const envelope = runner.envelopeVerifierResponse({
      candidateId: 'candidate-1',
      identity: runner.captureExecutionIdentity({
        identityProvider: 'codex-host',
        executionRef: 'verifier-1',
      }),
      payload: finalResult(acceptance),
    });
    expect(() => validateLoopTrustedVerifierEnvelope({ envelope, binding })).toThrow(message);
  });

  it('rejects pass when a required check failed or any criterion did not pass', () => {
    const runner = createLoopRunnerChannel();
    const envelope = runner.envelopeVerifierResponse({
      candidateId: 'candidate-1',
      identity: runner.captureExecutionIdentity({
        identityProvider: 'codex-host',
        executionRef: 'verifier-1',
      }),
      payload: finalResult([
        { id: 'A1', result: 'passed', reason: 'ok' },
        { id: 'A2', result: 'failed', reason: 'missing behavior' },
      ]),
    });
    expect(() => validateLoopTrustedVerifierEnvelope({ envelope, binding })).toThrow(
      'every acceptance',
    );
    expect(() =>
      validateLoopTrustedVerifierEnvelope({
        envelope: runner.envelopeVerifierResponse({
          candidateId: 'candidate-1',
          identity: runner.captureExecutionIdentity({
            identityProvider: 'codex-host',
            executionRef: 'verifier-2',
          }),
          payload: finalResult(),
        }),
        binding: { ...binding, requiredChecksPassed: false },
      }),
    ).toThrow('required check');
  });
});
