import { loopChangeRuntimeDir } from './loop-paths.js';
import {
  readLoopImplementationScopeBundle,
  readLoopVerificationEvidence,
  readLoopVerificationReceipt,
} from './loop-evidence-storage.js';
import {
  acceptLatestLoopRepairOverride,
  inspectLatestLoopRepairProjection,
  inspectLoopRepairFailure,
  loopRepairScopeHash,
  rebuildLoopRepairHistory,
  type LoopCommittedRepairTrajectory,
  type LoopRepairRuntimeResult,
  type LoopRepairTrajectoryProjection,
} from './loop-repair-runtime.js';
import {
  loopRepairConsecutiveFailures,
  normalizeLoopRepairFailedCheckIds,
  type LoopRepairHistoryRecord,
} from './loop-repair-stagnation.js';
import { readLoopCheckpoint, readLoopRunState, readLoopTrajectory } from './loop-run-store.js';
import type {
  LoopChangeState,
  LoopProjectPaths,
  LoopRepairDecisionProjection,
  LoopRepairStatusProjection,
} from './loop-types.js';
import type { LoopVerificationEvidenceEnvelope } from './loop-verification-evidence.js';
import { loopFailedCheckId, type LoopVerificationReceipt } from './loop-verification-receipt.js';
import {
  parseLoopImplementationScopeBundle,
  type LoopImplementationScopeBundle,
} from './loop-verification-scope.js';

export interface LoopRepairHistoryInspection {
  committed: LoopCommittedRepairTrajectory;
  latest: LoopRepairTrajectoryProjection | null;
  history: LoopRepairHistoryRecord[];
}

export type LoopRepairBuildGuard =
  | { disposition: 'proceed'; eventProjection: LoopRepairTrajectoryProjection | null }
  | {
      disposition: 'manual-stop' | 'hard-stop';
      signatureHash: string;
      overrideRecorded: boolean;
    };

function assertRepairableBuildState(state: LoopChangeState): void {
  if (
    state.phase !== 'build' ||
    state.verification_result !== 'fail' ||
    !state.implementation_scope ||
    !state.verification_evidence
  ) {
    throw new Error('Loop repair guard requires a failed Verify-to-Build state');
  }
}

/** Read only the checkpoint-committed trajectory prefix used as repair history authority. */
export async function readLoopCommittedRepairTrajectory(
  paths: LoopProjectPaths,
  state: LoopChangeState,
): Promise<LoopCommittedRepairTrajectory> {
  const runtimeDir = loopChangeRuntimeDir(paths, state.name);
  const run = await readLoopRunState(runtimeDir);
  if (!run || !state.run_id || run.runId !== state.run_id) {
    throw new Error('Loop repair history Run state is missing or mismatched');
  }
  const checkpoint = await readLoopCheckpoint(runtimeDir, run.checkpointRef);
  if (!checkpoint || checkpoint.runId !== run.runId || checkpoint.stateVersion !== run.iteration) {
    throw new Error('Loop repair history checkpoint is missing or mismatched');
  }
  return {
    trajectory: await readLoopTrajectory(runtimeDir, run.trajectoryRef),
    committedTrajectoryOffset: checkpoint.trajectoryOffset,
    runId: run.runId,
  };
}

export async function inspectLoopRepairHistory(
  paths: LoopProjectPaths,
  state: LoopChangeState,
): Promise<LoopRepairHistoryInspection> {
  const committed = await readLoopCommittedRepairTrajectory(paths, state);
  return {
    committed,
    latest: inspectLatestLoopRepairProjection(committed),
    history: rebuildLoopRepairHistory(committed),
  };
}

function decisionFromInspection(
  inspection: LoopRepairHistoryInspection,
  maxVerifyFailures: number,
): LoopRepairDecisionProjection | null {
  const latest = inspection.latest;
  if (!latest) return null;
  const failures = inspection.history.filter((entry) => entry.kind === 'failure');
  const consecutiveFailures =
    failures.length === 0
      ? 0
      : loopRepairConsecutiveFailures(
          {
            signatureHash: latest.signatureHash,
            ...(latest.contractHash === null
              ? {}
              : {
                  failedAcceptanceIds: latest.failedAcceptanceIds,
                  failedCheckIds: latest.failedCheckIds,
                }),
          },
          failures.slice(0, -1),
        );
  const overrideAccepted = latest.overrideSummaryHash !== null;
  const overrideAlreadyUsed = inspection.history.some(
    (entry) => entry.kind === 'override' && entry.signatureHash === latest.signatureHash,
  );
  const hardStop = failures.length >= maxVerifyFailures;
  const effectiveDisposition =
    latest.disposition === 'hard-stop' && !hardStop ? 'continue' : latest.disposition;
  return {
    disposition: hardStop ? 'hard-stop' : effectiveDisposition,
    reasonCode: overrideAccepted
      ? 'override-accepted'
      : overrideAlreadyUsed && latest.disposition === 'manual-stop'
        ? 'override-already-used'
        : hardStop
          ? 'repair-iteration-limit'
          : latest.disposition === 'manual-stop'
            ? 'repeated-failure-stop'
            : latest.disposition === 'warn'
              ? 'repeated-failure-warning'
              : 'new-failure-signature',
    signatureHash: latest.signatureHash,
    consecutiveFailures,
    totalRepairFailures: failures.length,
    remainingIterations: Math.max(0, maxVerifyFailures - failures.length),
    overrideAccepted,
  };
}

export async function inspectLatestLoopRepairDecision(
  paths: LoopProjectPaths,
  state: LoopChangeState,
  maxVerifyFailures: number,
): Promise<LoopRepairDecisionProjection | null> {
  return decisionFromInspection(await inspectLoopRepairHistory(paths, state), maxVerifyFailures);
}

export function projectLoopRepairDecision(
  result: LoopRepairRuntimeResult,
): LoopRepairDecisionProjection {
  return {
    disposition: result.decision.disposition,
    reasonCode: result.decision.reasonCode,
    signatureHash: result.decision.signature.signatureHash,
    consecutiveFailures: result.decision.consecutiveFailures,
    totalRepairFailures: result.decision.totalRepairFailures,
    remainingIterations: result.decision.remainingIterations,
    overrideAccepted: result.decision.overrideAccepted,
  };
}

export function loopRepairFailedCheckIdsFromReceipts(
  receipts: readonly LoopVerificationReceipt[],
): string[] {
  return normalizeLoopRepairFailedCheckIds(
    receipts
      .filter((receipt) => receipt.status !== 'passed')
      .map((receipt) => loopFailedCheckId(receipt)),
  );
}

export async function inspectLoopRepairFailureForTransition(options: {
  paths: LoopProjectPaths;
  state: LoopChangeState;
  envelope: LoopVerificationEvidenceEnvelope;
  maxVerifyFailures: number;
}): Promise<LoopRepairRuntimeResult> {
  if (!options.state.implementation_scope) {
    throw new Error('Loop repair failure has no implementation scope');
  }
  const receiptRefs = [
    ...new Set([...options.envelope.requiredReceiptRefs, ...options.envelope.receiptRefs]),
  ];
  const [committed, implementationScope, receipts] = await Promise.all([
    readLoopCommittedRepairTrajectory(options.paths, options.state),
    readLoopImplementationScopeBundle(
      options.paths,
      options.state.name,
      options.state.implementation_scope,
    ),
    Promise.all(
      receiptRefs.map((ref) => readLoopVerificationReceipt(options.paths, options.state.name, ref)),
    ),
  ]);
  const failedCheckIds = loopRepairFailedCheckIdsFromReceipts(receipts);
  return inspectLoopRepairFailure({
    ...committed,
    envelope: options.envelope,
    implementationScope,
    maxVerifyFailures: options.maxVerifyFailures,
    ...(failedCheckIds.length > 0 ? { failedCheckIds } : {}),
  });
}

/** Decide whether a stopped repair may leave Build, without trusting caller-supplied history. */
export async function inspectLoopRepairBuildGuard(options: {
  paths: LoopProjectPaths;
  state: LoopChangeState;
  currentImplementationScope: LoopImplementationScopeBundle;
  maxVerifyFailures: number;
  override?: { expectedSignatureHash: string; summary: string };
}): Promise<LoopRepairBuildGuard> {
  const inspection = await inspectLoopRepairHistory(options.paths, options.state);
  const latest = inspection.latest;
  const currentContractHash = parseLoopImplementationScopeBundle(options.currentImplementationScope)
    .scope.contractHash;
  if (latest?.contractHash !== null && latest?.contractHash !== currentContractHash) {
    if (options.override) {
      throw new Error('Loop repair override cannot cross a confirmed contract change');
    }
    return { disposition: 'proceed', eventProjection: null };
  }
  const totalFailures = inspection.history.filter((entry) => entry.kind === 'failure').length;
  if (latest && totalFailures >= options.maxVerifyFailures) {
    if (options.override) {
      throw new Error('Loop repair hard stop cannot be overridden');
    }
    return {
      disposition: 'hard-stop',
      signatureHash: latest.signatureHash,
      overrideRecorded: inspection.history.some(
        (entry) => entry.kind === 'override' && entry.signatureHash === latest.signatureHash,
      ),
    };
  }
  const effectiveDisposition =
    latest?.disposition === 'hard-stop' && totalFailures < options.maxVerifyFailures
      ? 'continue'
      : latest?.disposition;
  if (!latest || (effectiveDisposition !== 'manual-stop' && effectiveDisposition !== 'hard-stop')) {
    if (options.override) {
      throw new Error('Loop repair override requires the latest manual stop');
    }
    return { disposition: 'proceed', eventProjection: null };
  }

  const overrideRecorded = inspection.history.some(
    (entry) => entry.kind === 'override' && entry.signatureHash === latest.signatureHash,
  );
  const activeFailedRepair =
    options.state.phase === 'build' &&
    options.state.verification_result === 'fail' &&
    options.state.implementation_scope !== null &&
    options.state.verification_evidence !== null;
  if (!activeFailedRepair) {
    if (options.override) {
      throw new Error('Loop repair override requires an active failed Verify-to-Build state');
    }
    return { disposition: 'proceed', eventProjection: null };
  }
  assertRepairableBuildState(options.state);
  const [previousEnvelope, previousImplementationScope] = await Promise.all([
    readLoopVerificationEvidence(
      options.paths,
      options.state.name,
      options.state.verification_evidence!,
    ),
    readLoopImplementationScopeBundle(
      options.paths,
      options.state.name,
      options.state.implementation_scope!,
    ),
  ]);
  if (previousImplementationScope.scope.scopeHash !== previousEnvelope.implementationScopeHash) {
    throw new Error('Loop repair verification evidence does not match its implementation scope');
  }
  if (
    latest.contractHash === null &&
    loopRepairScopeHash(options.currentImplementationScope) !==
      loopRepairScopeHash(previousImplementationScope)
  ) {
    if (options.override) {
      throw new Error('Loop repair override is not valid after implementation scope progress');
    }
    return { disposition: 'proceed', eventProjection: null };
  }
  if (latest.disposition === 'hard-stop') {
    if (options.override) {
      throw new Error('Loop repair hard stop cannot be overridden without implementation progress');
    }
    return {
      disposition: 'hard-stop',
      signatureHash: latest.signatureHash,
      overrideRecorded,
    };
  }
  if (overrideRecorded) {
    return {
      disposition: 'hard-stop',
      signatureHash: latest.signatureHash,
      overrideRecorded,
    };
  }
  if (!options.override) {
    return {
      disposition: 'manual-stop',
      signatureHash: latest.signatureHash,
      overrideRecorded: false,
    };
  }
  return {
    disposition: 'proceed',
    eventProjection: acceptLatestLoopRepairOverride({
      ...inspection.committed,
      override: options.override,
    }).eventProjection,
  };
}

export async function inspectLoopRepairStatus(
  paths: LoopProjectPaths,
  state: LoopChangeState,
  maxVerifyFailures: number,
): Promise<LoopRepairStatusProjection | null> {
  if (state.phase !== 'build' || state.verification_result !== 'fail') return null;
  const inspection = await inspectLoopRepairHistory(paths, state);
  const latest = inspection.latest;
  if (!latest) return null;
  const failures = inspection.history.filter((entry) => entry.kind === 'failure');
  const hardStop = failures.length >= maxVerifyFailures;
  const effectiveDisposition =
    latest.disposition === 'hard-stop' && !hardStop ? 'continue' : latest.disposition;
  return {
    disposition: hardStop ? 'hard-stop' : effectiveDisposition,
    signatureHash: latest.signatureHash,
    overrideRecorded: inspection.history.some(
      (entry) => entry.kind === 'override' && entry.signatureHash === latest.signatureHash,
    ),
    failedAcceptanceIds: [...latest.failedAcceptanceIds],
    failedCheckIds: [...latest.failedCheckIds],
    totalVerifyFailures: failures.length,
    maxVerifyFailures,
    remainingVerifyFailures: Math.max(0, maxVerifyFailures - failures.length),
  };
}
