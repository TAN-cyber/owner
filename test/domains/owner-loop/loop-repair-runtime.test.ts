import { describe, expect, it } from 'vitest';

import { buildLoopContractSnapshot } from '../../../domains/owner-loop/loop-contract.js';
import {
  acceptLatestLoopRepairOverride,
  acceptLoopRepairOverride,
  buildLoopRepairSignatureFromEvidence,
  inspectLatestLoopRepairProjection,
  inspectLoopRepairFailure,
  inspectLoopRepairResume,
  loopRepairFailureFacts,
  loopRepairScopeHash,
  LOOP_REPAIR_TRAJECTORY_FIELD,
  LOOP_REPAIR_TRAJECTORY_LIMITS,
  parseLoopRepairTrajectoryProjection,
  rebuildLoopRepairHistory,
  type LoopRepairEvidenceInput,
  type LoopRepairTrajectoryProjection,
} from '../../../domains/owner-loop/loop-repair-runtime.js';
import {
  buildLoopAcceptanceEvidenceTrace,
  buildLoopVerificationEvidenceEnvelope,
} from '../../../domains/owner-loop/loop-verification-evidence.js';
import type { LoopContentSnapshotManifest } from '../../../domains/owner-loop/loop-types.js';
import { buildLoopImplementationScopeBundle } from '../../../domains/owner-loop/loop-verification-scope.js';

const RUN_ID = 'repair-run';
const NOW = new Date('2026-07-17T00:00:00.000Z');

function snapshot(hash: string): LoopContentSnapshotManifest {
  return {
    schema: 'owner.loop.content-snapshot.v1',
    origin: 'explicit',
    createdAt: NOW.toISOString(),
    complete: true,
    limits: {
      maxFiles: 10,
      maxFileBytes: 1_024,
      maxTotalBytes: 4_096,
      maxManifestBytes: 4_096,
    },
    entries: [{ path: 'src/feature.ts', hash, size: 10, type: 'file' }],
    omitted: [],
    omittedCount: 0,
  };
}

function evidenceInput(
  result: 'pass' | 'fail' = 'fail',
  currentHash = 'b'.repeat(64),
): LoopRepairEvidenceInput & { maxVerifyFailures: number } {
  const contract = buildLoopContractSnapshot({
    briefMarkdown: '# Acceptance examples\n- The repaired behavior works.\n',
    specs: [],
  });
  const implementationScope = buildLoopImplementationScopeBundle({
    baseline: snapshot('a'.repeat(64)),
    current: snapshot(currentHash),
    contractHash: contract.contractHash,
    declaredArtifacts: [{ path: 'src/feature.ts', kind: 'file' }],
  });
  const acceptanceTrace = buildLoopAcceptanceEvidenceTrace(
    contract.acceptance,
    contract.acceptance.map((criterion) => ({
      acceptance_id: criterion.id,
      status: result === 'fail' ? ('failed' as const) : ('passed' as const),
      evidence_refs: result === 'fail' ? [] : [`runtime/evidence/receipts/${'a'.repeat(64)}.json`],
      ...(result === 'fail' ? { skipped_reason: 'The acceptance is not satisfied.' } : {}),
    })),
    { loopRootRef: 'owner' },
  );
  const envelope = buildLoopVerificationEvidenceEnvelope({
    change: 'repair-loop',
    sourceRevision: 3,
    result,
    contractHash: contract.contractHash,
    acceptanceHash: contract.acceptanceHash,
    implementationScope: {
      ref: `runtime/evidence/scopes/${implementationScope.scope.scopeHash}.json`,
      bundle: implementationScope,
    },
    reportRef: 'verification.md',
    reportHash: 'c'.repeat(64),
    acceptanceTrace,
    requiredReceiptRefs: [`runtime/evidence/receipts/${'b'.repeat(64)}.json`],
    now: NOW,
  });
  return { envelope, implementationScope, maxVerifyFailures: 5 };
}

function unchangedEvidenceInput(
  noCodeReason: string,
): LoopRepairEvidenceInput & { maxVerifyFailures: number } {
  const contract = buildLoopContractSnapshot({
    briefMarkdown: '# Acceptance examples\n- The no-code behavior remains valid.\n',
    specs: [],
  });
  const baseline = snapshot('a'.repeat(64));
  const implementationScope = buildLoopImplementationScopeBundle({
    baseline,
    current: { ...baseline, createdAt: new Date(NOW.valueOf() + 1_000).toISOString() },
    contractHash: contract.contractHash,
    declaredArtifacts: [],
    noCodeReason,
  });
  const acceptanceTrace = buildLoopAcceptanceEvidenceTrace(
    contract.acceptance,
    contract.acceptance.map((criterion) => ({
      acceptance_id: criterion.id,
      status: 'failed' as const,
      evidence_refs: [],
      skipped_reason: 'The acceptance is not satisfied.',
    })),
    { loopRootRef: 'owner' },
  );
  const envelope = buildLoopVerificationEvidenceEnvelope({
    change: 'repair-loop',
    sourceRevision: 3,
    result: 'fail',
    contractHash: contract.contractHash,
    acceptanceHash: contract.acceptanceHash,
    implementationScope: {
      ref: `runtime/evidence/scopes/${implementationScope.scope.scopeHash}.json`,
      bundle: implementationScope,
    },
    reportRef: 'verification.md',
    reportHash: 'c'.repeat(64),
    acceptanceTrace,
    requiredReceiptRefs: [`runtime/evidence/receipts/${'b'.repeat(64)}.json`],
    now: NOW,
  });
  return { envelope, implementationScope, maxVerifyFailures: 5 };
}

function event(
  sequence: number,
  data: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): unknown {
  return {
    sequence,
    timestamp: new Date(NOW.valueOf() + sequence * 1_000).toISOString(),
    type: 'state_transitioned',
    runId: RUN_ID,
    data,
    ...overrides,
  };
}

function repairEvent(
  sequence: number,
  projection: LoopRepairTrajectoryProjection,
  implementationScopeHash?: string,
): unknown {
  return event(sequence, {
    previousPhase: 'verify',
    nextPhase: 'build',
    verificationResult: 'fail',
    ...(implementationScopeHash ? { implementationScopeHash } : {}),
    [LOOP_REPAIR_TRAJECTORY_FIELD]: projection,
  });
}

function overrideEvent(sequence: number, projection: LoopRepairTrajectoryProjection): unknown {
  return event(sequence, {
    previousPhase: 'build',
    nextPhase: 'verify',
    verificationResult: null,
    [LOOP_REPAIR_TRAJECTORY_FIELD]: projection,
  });
}

function committed(trajectory: readonly unknown[]) {
  return {
    trajectory,
    committedTrajectoryOffset: trajectory.length,
    runId: RUN_ID,
  };
}

describe('Loop repair runtime integration', () => {
  it('derives a lightweight default signature from failed, content-bound evidence', () => {
    const input = evidenceInput();
    const facts = loopRepairFailureFacts(input);
    const signature = buildLoopRepairSignatureFromEvidence(input);

    expect(facts).toMatchObject({
      contractHash: input.envelope.contractHash,
      implementationScopeHash: loopRepairScopeHash(input.implementationScope),
      artifactSnapshotHash: input.implementationScope.scope.currentProjectionHash,
      failedCheckIds: [],
    });
    expect(signature.signatureHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('keeps one repair episode when only the no-code explanation is reworded', () => {
    const first = unchangedEvidenceInput('No project edit is required.');
    const reworded = unchangedEvidenceInput('The project intentionally remains unchanged.');
    const firstSignature = buildLoopRepairSignatureFromEvidence(first).signatureHash;
    const rewordedSignature = buildLoopRepairSignatureFromEvidence(reworded).signatureHash;
    const repairScopeHash = loopRepairScopeHash(reworded.implementationScope);

    expect(reworded.implementationScope.scope.scopeHash).not.toBe(
      first.implementationScope.scope.scopeHash,
    );
    expect(rewordedSignature).toBe(firstSignature);
    expect(
      rebuildLoopRepairHistory(
        committed([
          repairEvent(1, {
            signatureHash: firstSignature,
            disposition: 'continue',
            overrideSummaryHash: null,
          }),
          event(2, {
            previousPhase: 'build',
            nextPhase: 'verify',
            verificationResult: null,
            implementationScopeHash: reworded.implementationScope.scope.scopeHash,
            repairScopeHash,
          }),
          repairEvent(3, {
            signatureHash: rewordedSignature,
            disposition: 'warn',
            overrideSummaryHash: null,
          }),
        ]),
      ),
    ).toMatchObject([
      { kind: 'failure', iteration: 1, signatureHash: firstSignature },
      { kind: 'failure', iteration: 2, signatureHash: firstSignature },
    ]);

    expect(
      inspectLoopRepairResume({
        ...first,
        ...committed([
          repairEvent(1, {
            signatureHash: firstSignature,
            disposition: 'continue',
            overrideSummaryHash: null,
          }),
          repairEvent(2, {
            signatureHash: firstSignature,
            disposition: 'warn',
            overrideSummaryHash: null,
          }),
          repairEvent(3, {
            signatureHash: firstSignature,
            disposition: 'manual-stop',
            overrideSummaryHash: null,
          }),
        ]),
        currentImplementationScope: reworded.implementationScope,
      }),
    ).toMatchObject({ disposition: 'override-required', reason: 'override-required' });
  });

  it('continues once, warns on the repeat, then persists a manual stop', () => {
    const evidence = evidenceInput();
    const first = inspectLoopRepairFailure({ ...evidence, ...committed([]) });
    expect(first).toMatchObject({
      decision: { disposition: 'continue', consecutiveFailures: 1 },
      eventProjection: { disposition: 'continue', overrideSummaryHash: null },
    });

    const firstEvent = repairEvent(1, first.eventProjection!);
    const second = inspectLoopRepairFailure({ ...evidence, ...committed([firstEvent]) });
    expect(second).toMatchObject({
      decision: { disposition: 'warn', consecutiveFailures: 2 },
      eventProjection: { disposition: 'warn', overrideSummaryHash: null },
    });

    const third = inspectLoopRepairFailure({
      ...evidence,
      ...committed([firstEvent, repairEvent(2, second.eventProjection!)]),
    });
    expect(third).toMatchObject({
      decision: { disposition: 'manual-stop', consecutiveFailures: 3 },
      eventProjection: { disposition: 'manual-stop', overrideSummaryHash: null },
    });
  });

  it('accepts one matching override on the latest manual stop and rejects a second one', () => {
    const evidence = evidenceInput();
    const first = inspectLoopRepairFailure({ ...evidence, ...committed([]) });
    const one = repairEvent(1, first.eventProjection!);
    const second = inspectLoopRepairFailure({ ...evidence, ...committed([one]) });
    const two = repairEvent(2, second.eventProjection!);
    const third = inspectLoopRepairFailure({ ...evidence, ...committed([one, two]) });
    const three = repairEvent(3, third.eventProjection!);
    const expectedSignatureHash = first.decision.signature.signatureHash;

    expect(
      inspectLoopRepairResume({
        ...evidence,
        ...committed([one, two, three]),
        currentImplementationScope: evidence.implementationScope,
      }),
    ).toMatchObject({
      disposition: 'override-required',
      reason: 'override-required',
      signatureHash: expectedSignatureHash,
    });

    const historyOnly = acceptLatestLoopRepairOverride({
      ...committed([one, two, three]),
      override: {
        expectedSignatureHash,
        summary: 'Try the independent compatibility path once.',
      },
    });
    const accepted = acceptLoopRepairOverride({
      ...evidence,
      ...committed([one, two, three]),
      override: {
        expectedSignatureHash,
        summary: 'Try the independent compatibility path once.',
      },
    });
    expect(accepted).toMatchObject({
      decision: { disposition: 'continue', reasonCode: 'override-accepted' },
      eventProjection: {
        signatureHash: expectedSignatureHash,
        disposition: 'continue',
      },
    });
    expect(historyOnly.eventProjection).toEqual(accepted.eventProjection);
    expect(accepted.eventProjection?.overrideSummaryHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.keys(accepted.eventProjection!).sort()).toEqual([
      'contractHash',
      'disposition',
      'failedAcceptanceIds',
      'failedCheckIds',
      'maxVerifyFailures',
      'overrideSummaryHash',
      'signatureHash',
    ]);

    const four = overrideEvent(4, accepted.eventProjection!);
    expect(inspectLatestLoopRepairProjection(committed([one, two, three, four]))).toEqual(
      accepted.eventProjection,
    );
    const refused = acceptLoopRepairOverride({
      ...evidence,
      ...committed([one, two, three, four]),
      override: {
        expectedSignatureHash,
        summary: 'A second override must not be accepted.',
      },
    });
    expect(refused).toMatchObject({
      decision: { disposition: 'manual-stop', reasonCode: 'override-already-used' },
      eventProjection: null,
    });
    expect(refused.history.slice(-2)).toEqual([
      {
        kind: 'failure',
        revision: 3,
        iteration: 3,
        signatureHash: expectedSignatureHash,
        failedAcceptanceIds: evidence.envelope.acceptanceTrace.entries
          .filter((entry) => entry.status === 'failed' || entry.status === 'missing')
          .map((entry) => entry.acceptanceId),
        failedCheckIds: [],
      },
      {
        kind: 'override',
        revision: 4,
        iteration: 3,
        signatureHash: expectedSignatureHash,
        summaryHash: accepted.eventProjection!.overrideSummaryHash,
      },
    ]);
    expect(() =>
      acceptLatestLoopRepairOverride({
        ...committed([one, two, three, four]),
        override: {
          expectedSignatureHash,
          summary: 'No repeated override.',
        },
      }),
    ).toThrow('latest manual stop');

    const five = repairEvent(5, {
      signatureHash: expectedSignatureHash,
      disposition: 'manual-stop',
      overrideSummaryHash: null,
    });
    expect(() =>
      acceptLatestLoopRepairOverride({
        ...committed([one, two, three, four, five]),
        override: {
          expectedSignatureHash,
          summary: 'The signature already used its only override.',
        },
      }),
    ).toThrow('already overridden');
    expect(
      inspectLoopRepairResume({
        ...evidence,
        ...committed([one, two, three, four, five]),
        currentImplementationScope: evidence.implementationScope,
      }),
    ).toMatchObject({ disposition: 'hard-stop', reason: 'override-already-applied' });
  });

  it('treats a new Build scope as progress without requiring an override', () => {
    const evidence = evidenceInput();
    const signature = buildLoopRepairSignatureFromEvidence(evidence).signatureHash;
    const trajectory = [
      repairEvent(1, {
        signatureHash: signature,
        disposition: 'continue',
        overrideSummaryHash: null,
      }),
      repairEvent(2, {
        signatureHash: signature,
        disposition: 'warn',
        overrideSummaryHash: null,
      }),
      repairEvent(3, {
        signatureHash: signature,
        disposition: 'manual-stop',
        overrideSummaryHash: null,
      }),
    ];
    const progressed = evidenceInput('fail', 'd'.repeat(64));

    expect(
      inspectLoopRepairResume({
        ...evidence,
        ...committed(trajectory),
        currentImplementationScope: progressed.implementationScope,
      }),
    ).toMatchObject({ disposition: 'proceed', reason: 'scope-progress' });
  });

  it('starts a fresh episode after scope progress following an ordinary failure', () => {
    const first = evidenceInput('fail', 'b'.repeat(64));
    const progressed = evidenceInput('fail', 'd'.repeat(64));
    const firstSignature = buildLoopRepairSignatureFromEvidence(first).signatureHash;
    const progressedSignature = buildLoopRepairSignatureFromEvidence(progressed).signatureHash;
    const trajectory = [
      repairEvent(
        1,
        {
          signatureHash: firstSignature,
          disposition: 'continue',
          overrideSummaryHash: null,
        },
        first.implementationScope.scope.scopeHash,
      ),
      event(2, {
        previousPhase: 'build',
        nextPhase: 'verify',
        verificationResult: null,
        implementationScopeHash: progressed.implementationScope.scope.scopeHash,
      }),
      repairEvent(
        3,
        {
          signatureHash: progressedSignature,
          disposition: 'continue',
          overrideSummaryHash: null,
        },
        progressed.implementationScope.scope.scopeHash,
      ),
    ];

    expect(rebuildLoopRepairHistory(committed(trajectory))).toEqual([
      {
        kind: 'failure',
        revision: 3,
        iteration: 1,
        signatureHash: progressedSignature,
      },
    ]);
  });

  it('hard-stops the configured fifth total failure and never applies an override there', () => {
    const evidence = evidenceInput();
    const trajectory = Array.from({ length: 4 }, (_, index) =>
      repairEvent(index + 1, {
        signatureHash: index.toString(16).padStart(64, '0'),
        disposition: 'continue',
        overrideSummaryHash: null,
      }),
    );
    const currentSignature = buildLoopRepairSignatureFromEvidence(evidence).signatureHash;
    const stopped = inspectLoopRepairFailure({ ...evidence, ...committed(trajectory) });
    expect(stopped).toMatchObject({
      decision: { disposition: 'hard-stop', totalRepairFailures: 5 },
      eventProjection: { disposition: 'hard-stop', overrideSummaryHash: null },
    });
    const persisted = [...trajectory, repairEvent(5, stopped.eventProjection!)];
    expect(inspectLatestLoopRepairProjection(committed(persisted))).toEqual(
      stopped.eventProjection,
    );
    const progressed = evidenceInput('fail', 'e'.repeat(64));
    expect(
      inspectLoopRepairResume({
        ...evidence,
        ...committed(persisted),
        currentImplementationScope: progressed.implementationScope,
      }),
    ).toMatchObject({ disposition: 'hard-stop', reason: 'hard-stop' });
    const result = acceptLoopRepairOverride({
      ...evidence,
      ...committed(persisted),
      override: {
        expectedSignatureHash: currentSignature,
        summary: 'The hard stop must win.',
      },
    });

    expect(result).toMatchObject({
      decision: { disposition: 'hard-stop', totalRepairFailures: 5 },
      eventProjection: null,
    });
    expect(() =>
      acceptLatestLoopRepairOverride({
        ...committed(persisted),
        override: {
          expectedSignatureHash: currentSignature,
          summary: 'The hard stop must still win.',
        },
      }),
    ).toThrow('hard stop cannot be overridden');
  });

  it('uses only the committed prefix and ignores ordinary transition events', () => {
    const signature = buildLoopRepairSignatureFromEvidence(evidenceInput()).signatureHash;
    const ordinary = event(1, {
      previousPhase: 'shape',
      nextPhase: 'build',
      verificationResult: null,
    });
    const projected = repairEvent(2, {
      signatureHash: signature,
      disposition: 'continue',
      overrideSummaryHash: null,
    });
    const uncommitted = repairEvent(3, {
      signatureHash: signature,
      disposition: 'warn',
      overrideSummaryHash: null,
    });

    expect(
      rebuildLoopRepairHistory({
        trajectory: [ordinary, projected, uncommitted],
        committedTrajectoryOffset: 2,
        runId: RUN_ID,
      }),
    ).toEqual([{ kind: 'failure', revision: 2, iteration: 1, signatureHash: signature }]);
  });

  it('fails closed on forged projections and malformed or unbounded trajectory data', () => {
    const signature = buildLoopRepairSignatureFromEvidence(evidenceInput()).signatureHash;
    const firstWarn = repairEvent(1, {
      signatureHash: signature,
      disposition: 'warn',
      overrideSummaryHash: null,
    });
    expect(() => rebuildLoopRepairHistory(committed([firstWarn]))).toThrow('expected continue');

    const wrongTransition = event(1, {
      previousPhase: 'build',
      nextPhase: 'verify',
      verificationResult: null,
      [LOOP_REPAIR_TRAJECTORY_FIELD]: {
        signatureHash: signature,
        disposition: 'continue',
        overrideSummaryHash: null,
      },
    });
    expect(() => rebuildLoopRepairHistory(committed([wrongTransition]))).toThrow(
      'failed Verify-to-Build',
    );

    const forgedOverride = overrideEvent(1, {
      signatureHash: signature,
      disposition: 'continue',
      overrideSummaryHash: 'd'.repeat(64),
    });
    expect(() => rebuildLoopRepairHistory(committed([forgedOverride]))).toThrow(
      'latest manual stop',
    );

    expect(() =>
      parseLoopRepairTrajectoryProjection({
        signatureHash: signature,
        disposition: 'manual-stop',
        overrideSummaryHash: null,
        output: 'must never be persisted',
      }),
    ).toThrow('fields are invalid');

    const unknownOuterField = event(
      1,
      {},
      {
        forged: true,
      },
    );
    expect(() => rebuildLoopRepairHistory(committed([unknownOuterField]))).toThrow(
      'fields are invalid',
    );

    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => rebuildLoopRepairHistory(committed([event(1, cycle)]))).toThrow('cycle');

    const tooMany = Array.from({ length: LOOP_REPAIR_TRAJECTORY_LIMITS.maxEvents + 1 }, () => null);
    expect(() => rebuildLoopRepairHistory(committed(tooMany))).toThrow('event boundary');
  });

  it('rejects pass evidence and content authorities that do not match the envelope', () => {
    const evidence = evidenceInput();
    expect(() => loopRepairFailureFacts(evidenceInput('pass'))).toThrow(
      'requires a failed verification envelope',
    );

    const different = evidenceInput('fail', 'd'.repeat(64));
    expect(() =>
      loopRepairFailureFacts({
        envelope: evidence.envelope,
        implementationScope: different.implementationScope,
      }),
    ).toThrow('does not match');

    const forgedScope = structuredClone(evidence.implementationScope);
    forgedScope.scope.scopeHash = 'f'.repeat(64);
    expect(() =>
      loopRepairFailureFacts({ envelope: evidence.envelope, implementationScope: forgedScope }),
    ).toThrow();
  });
});
