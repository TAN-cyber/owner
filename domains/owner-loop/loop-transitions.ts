import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

import { decideWithResolver, recordOutcomeWithResolver } from '../engine/loop.js';
import { inspectLoopGuard } from './loop-guards.js';
import {
  DEFAULT_LOOP_MAX_VERIFY_FAILURES,
  DEFAULT_LOOP_SNAPSHOT_CONFIG,
  readProjectConfig,
} from './loop-config.js';
import { checkLoopChangeLocked } from './loop-check.js';
import { projectLoopAcceptancePage } from './loop-acceptance.js';
import { LoopBaselineIncompleteError, loopChangeDir, readLoopChange } from './loop-change.js';
import { collectLoopContractFiles } from './loop-contract-files.js';
import { inspectLoopBuildEvidence, persistLoopBuildEvidence } from './loop-build-evidence.js';
import { loopContinuation } from './loop-continuation.js';
import { structureLoopFindings } from './loop-findings.js';
import { settleLoopChangeJournalsLocked } from './loop-change-recovery.js';
import { withLoopMutationLock } from './loop-mutation-lock.js';
import {
  inspectLoopRuntimeStorage,
  loopChangeRuntimeDir,
  loopPreferredChangeRuntimeDir,
} from './loop-paths.js';
import { sha256Text } from './loop-hash.js';
import { redactLoopCredentialText } from './loop-redaction.js';
import {
  inspectLatestLoopRepairDecision,
  inspectLoopRepairBuildGuard,
  inspectLoopRepairFailureForTransition,
  projectLoopRepairDecision,
} from './loop-repair-integration.js';
import { loopRepairScopeHash, type LoopRepairTrajectoryProjection } from './loop-repair-runtime.js';
import { hashLoopRepairOverrideSummary } from './loop-repair-stagnation.js';
import {
  LOOP_RUNTIME_HASH,
  LOOP_RUNTIME_PACKAGE,
  loopPhaseResolver,
} from './loop-runtime-package.js';
import { readLoopRunState, readLoopTrajectory, startLoopRun } from './loop-run-store.js';
import { reconcileLoopSpecChanges } from './loop-specs.js';
import {
  createLoopContentSnapshot,
  inspectLoopContentSnapshotHealth,
  writeLoopBaselineManifest,
} from './loop-snapshot.js';
import {
  inspectLoopImplementationScopeFreshness,
  inspectLoopVerificationEvidence,
  inspectLoopVerificationFreshness,
  persistLoopVerificationEvidence,
  type LoopVerificationPreparation,
} from './loop-verification-runtime.js';
import {
  continueLoopTransitionLocked,
  prepareLoopTransition,
  withLoopTransitionLock,
} from './loop-transition-journal.js';
import { loopAdvanceEvidenceHash } from './loop-transition-evidence.js';
import { assertLoopTrajectoryText } from './loop-trajectory-limits.js';
import { writeLoopWorkspaceIdentity } from './loop-workspace.js';
import type {
  LoopAdvanceEvidence,
  LoopAdvanceResult,
  LoopChangeState,
  LoopClarificationMode,
  LoopPhase,
  LoopProjectPaths,
  LoopRepairDecisionProjection,
  LoopTransitionHooks,
} from './loop-types.js';

interface AdvanceLoopChangeOptions {
  paths: LoopProjectPaths;
  name: string;
  evidence: LoopAdvanceEvidence;
  clarificationMode: LoopClarificationMode;
  maxVerifyFailures?: number;
  now?: Date;
  runId?: () => string;
  transitionId?: () => string;
  hooks?: LoopTransitionHooks;
}

export function formatLoopReceiptBindingMismatchMessage(options: {
  change: string;
  detail: string;
}): string {
  return `Loop verification receipt binding is invalid: ${options.detail}. Re-issue the affected receipts with \`owner loop receipt refresh ${options.change} --apply\`.`;
}

function hasEvidenceRetreatExtras(evidence: LoopAdvanceEvidence): boolean {
  return (
    evidence.confirmed !== undefined ||
    evidence.artifacts !== undefined ||
    evidence.noCodeReason !== undefined ||
    evidence.allowPartialScopeHash !== undefined ||
    evidence.partialReason !== undefined ||
    evidence.verificationResult !== undefined ||
    evidence.verificationReport !== undefined ||
    evidence.repairOverrideSignature !== undefined ||
    evidence.repairOverrideSummary !== undefined
  );
}

function hasReturnToBuild(evidence: LoopAdvanceEvidence): boolean {
  return evidence.returnToBuild === true;
}

function repairFinding(
  decision: Pick<LoopRepairDecisionProjection, 'disposition' | 'reasonCode' | 'signatureHash'>,
): { code: string; message: string } {
  if (decision.reasonCode === 'override-already-used') {
    return {
      code: 'repair-override-exhausted',
      message: `Loop repair already used its override for signature: ${decision.signatureHash}`,
    };
  }
  if (decision.disposition === 'warn') {
    return {
      code: 'repair-stagnation-warning',
      message: `Loop repair repeated the same failure signature: ${decision.signatureHash}`,
    };
  }
  if (decision.disposition === 'manual-stop') {
    return {
      code: 'repair-stagnation-stop',
      message: `Loop repair stopped after repeated failure signature: ${decision.signatureHash}`,
    };
  }
  return {
    code: 'repair-iteration-limit',
    message: `Loop repair reached its total iteration limit at signature: ${decision.signatureHash}`,
  };
}

function loopVerificationFindingResult(options: {
  paths: LoopProjectPaths;
  state: LoopChangeState;
  previousPhase: LoopPhase;
  clarificationMode: LoopClarificationMode;
  preparation: LoopVerificationPreparation;
}): LoopAdvanceResult {
  const findings = structureLoopFindings({
    paths: options.paths,
    state: options.state,
    findings: options.preparation.findingCodes.map((code) => {
      if (
        code === 'verification-receipt-binding-mismatch' &&
        options.preparation.receiptBindingFailures &&
        options.preparation.receiptBindingFailures.length > 0
      ) {
        const detail = options.preparation.receiptBindingFailures
          .map((failure) => {
            const target = failure.acceptanceId
              ? `${failure.ref}[${failure.acceptanceId}]`
              : failure.ref;
            return `${target} -> ${failure.mismatches.join('; ')}`;
          })
          .join(' | ');
        return {
          code,
          message: formatLoopReceiptBindingMismatchMessage({
            change: options.state.name,
            detail,
          }),
        };
      }
      return {
        code,
        message: `Loop verification evidence is not current: ${code}`,
      };
    }),
  });
  return {
    change: options.state,
    previousPhase: options.previousPhase,
    next: 'manual',
    nextCommand: null,
    findings,
    continuation: loopContinuation({
      state: options.state,
      findings,
      clarificationMode: options.clarificationMode,
    }),
  };
}

function validateLoopAdvanceEvidence(evidence: LoopAdvanceEvidence): void {
  assertLoopTrajectoryText(evidence.summary, 'Loop transition summary');
  if (evidence.noCodeReason !== undefined) {
    assertLoopTrajectoryText(evidence.noCodeReason, 'Loop transition no-code reason');
  }
  if (
    evidence.repairOverrideSignature !== undefined &&
    !/^[a-f0-9]{64}$/u.test(evidence.repairOverrideSignature)
  ) {
    throw new Error('Loop repair override signature must be a SHA-256 hash');
  }
  if (evidence.repairOverrideSummary !== undefined) {
    hashLoopRepairOverrideSummary(evidence.repairOverrideSummary);
  }
}

function normalizeLoopAdvanceEvidence(evidence: LoopAdvanceEvidence): LoopAdvanceEvidence {
  return {
    ...evidence,
    summary: redactLoopCredentialText(evidence.summary),
    ...(evidence.noCodeReason === undefined
      ? {}
      : { noCodeReason: redactLoopCredentialText(evidence.noCodeReason) }),
    ...(evidence.partialReason === undefined
      ? {}
      : { partialReason: redactLoopCredentialText(evidence.partialReason) }),
    ...(evidence.repairOverrideSummary === undefined
      ? {}
      : { repairOverrideSummary: redactLoopCredentialText(evidence.repairOverrideSummary) }),
  };
}

function validateRepairEvidence(state: LoopChangeState, evidence: LoopAdvanceEvidence): void {
  const hasOverrideSignature = evidence.repairOverrideSignature !== undefined;
  const hasOverrideSummary = evidence.repairOverrideSummary !== undefined;
  if (hasOverrideSignature !== hasOverrideSummary) {
    throw new Error('Loop repair override signature and summary must be provided together');
  }
  if ((hasOverrideSignature || hasOverrideSummary) && state.phase !== 'build') {
    throw new Error('Loop repair override is only valid while leaving Build');
  }
}

async function retreatStaleLoopEvidence(options: {
  transition: AdvanceLoopChangeOptions;
  state: LoopChangeState;
  run: NonNullable<Awaited<ReturnType<typeof readLoopRunState>>>;
  evidenceHash: string;
  force?: boolean;
}): Promise<LoopAdvanceResult> {
  if (hasEvidenceRetreatExtras(options.transition.evidence)) {
    throw new Error('Loop evidence retreat only accepts a transition summary');
  }
  const previousPhase = options.state.phase;
  if (
    (previousPhase !== 'verify' && previousPhase !== 'archive') ||
    options.run.currentStep !== previousPhase ||
    options.run.pending !== null
  ) {
    throw new Error('Loop Verify/Archive Run cannot retreat evidence safely');
  }
  const evidenceIsFresh = options.force
    ? false
    : previousPhase === 'archive'
      ? ['complete', 'partial'].includes(
          (
            await inspectLoopVerificationFreshness({
              paths: options.transition.paths,
              state: options.state,
              now: options.transition.now,
            })
          ).freshness,
        )
      : (
          await inspectLoopImplementationScopeFreshness({
            paths: options.transition.paths,
            state: options.state,
            now: options.transition.now,
          })
        ).freshness === 'fresh';
  if (evidenceIsFresh) {
    const findings = structureLoopFindings({
      paths: options.transition.paths,
      state: options.state,
      findings: [
        previousPhase === 'archive'
          ? {
              code: 'archive-command-required',
              message: 'Current verification evidence is fresh; use Loop Archive preview',
            }
          : {
              code: 'verification-result-missing',
              message:
                'Current implementation scope is fresh; complete Verify with a result and report',
            },
      ],
    });
    return {
      change: options.state,
      previousPhase,
      next: 'manual',
      nextCommand:
        previousPhase === 'archive' ? `owner loop archive ${options.state.name} --dry-run` : null,
      findings,
      continuation: loopContinuation({
        state: options.state,
        archiveReady: previousPhase === 'archive',
        clarificationMode: options.transition.clarificationMode,
      }),
    };
  }
  const nextState: LoopChangeState = {
    ...options.state,
    revision: options.state.revision + 1,
    phase: 'build',
    verification_result: 'pending',
    verification_report: null,
    implementation_scope: null,
    verification_evidence: null,
    partial_allowance: null,
  };
  const nextRun = {
    ...options.run,
    currentStep: 'build',
    iteration: options.run.iteration + 1,
    pending: null,
    status: 'running' as const,
  };
  const eventData = {
    previousPhase,
    nextPhase: 'build',
    evidenceHash: options.evidenceHash,
    summary: options.transition.evidence.summary,
    artifacts: [],
    noCodeReason: null,
    verificationResult: null,
    ...(hasReturnToBuild(options.transition.evidence) ? { returnToBuild: true } : {}),
  };
  const journal = await prepareLoopTransition({
    paths: options.transition.paths,
    previousState: options.state,
    nextState,
    previousRun: options.run,
    nextRun,
    evidenceHash: options.evidenceHash,
    eventData,
    operation: 'evidence-retreat',
    now: options.transition.now,
    transitionId: options.transition.transitionId,
  });
  await options.transition.hooks?.afterPrepared?.(journal);
  const persisted = await continueLoopTransitionLocked(
    options.transition.paths,
    options.state.name,
    options.transition.hooks,
  );
  if (!persisted) throw new Error('Loop evidence retreat journal disappeared before completion');
  return {
    change: persisted,
    previousPhase,
    next: 'auto',
    nextCommand: null,
    findings: [],
    continuation: loopContinuation({
      state: persisted,
      clarificationMode: options.transition.clarificationMode,
    }),
  };
}

export async function advanceLoopChange(
  options: AdvanceLoopChangeOptions,
): Promise<LoopAdvanceResult> {
  const normalizedOptions = {
    ...options,
    maxVerifyFailures: options.maxVerifyFailures ?? DEFAULT_LOOP_MAX_VERIFY_FAILURES,
    evidence: normalizeLoopAdvanceEvidence(options.evidence),
  };
  validateLoopAdvanceEvidence(normalizedOptions.evidence);
  return withLoopMutationLock(options.paths, `advance ${options.name}`, () =>
    withLoopTransitionLock(options.paths, options.name, `advance ${options.name}`, () =>
      advanceLoopChangeLocked(
        normalizedOptions as AdvanceLoopChangeOptions & {
          maxVerifyFailures: number;
        },
      ),
    ),
  );
}

async function rebuildMissingLoopRuntime(
  options: AdvanceLoopChangeOptions & { maxVerifyFailures: number },
  state: LoopChangeState,
): Promise<LoopAdvanceResult | null> {
  const runtimeDir = loopPreferredChangeRuntimeDir(options.paths, state.name);
  let transitionPrepared = false;
  await fs.mkdir(path.join(runtimeDir, 'checkpoints'), { recursive: true });
  try {
    const projectConfig = await readProjectConfig(options.paths.projectRoot);
    const snapshotPolicy = projectConfig?.loop.snapshot ?? DEFAULT_LOOP_SNAPSHOT_CONFIG;
    const baseline = await createLoopContentSnapshot(options.paths, {
      now: options.now,
      origin: 'change-created',
      policy: snapshotPolicy,
      limits: {
        maxFiles: snapshotPolicy.max_files,
        maxFileBytes: snapshotPolicy.max_total_bytes,
        maxTotalBytes: snapshotPolicy.max_total_bytes,
        maxDurationMs: snapshotPolicy.max_duration_ms,
      },
      deadlineMs: snapshotPolicy.max_duration_ms,
    });
    if (!baseline.complete) {
      const health = inspectLoopContentSnapshotHealth(baseline);
      const omittedByReason = baseline.omitted.reduce<Record<string, number>>((counts, item) => {
        counts[item.reason] = (counts[item.reason] ?? 0) + 1;
        return counts;
      }, {});
      const overflowCount = baseline.omissionOverflow?.count ?? 0;
      if (overflowCount > 0) omittedByReason.overflow = overflowCount;
      throw new LoopBaselineIncompleteError(
        state.name,
        baseline.omittedCount,
        omittedByReason,
        health.samplePaths,
        health.sampleTruncated,
        baseline.limits,
        baseline.policy?.hash ?? null,
      );
    }
    await writeLoopBaselineManifest(options.paths, state.name, baseline);
    await writeLoopWorkspaceIdentity({
      paths: options.paths,
      name: state.name,
      revision: state.revision,
      now: options.now,
    });

    // Shape has no Run yet. Once its baseline/workspace are restored, the same invocation can
    // perform the ordinary Shape transition using the user's confirmation evidence.
    if (state.phase === 'shape') return null;

    const started = startLoopRun(
      LOOP_RUNTIME_PACKAGE,
      options.runId?.() ?? randomUUID(),
      LOOP_RUNTIME_HASH,
    );
    const decision = decideWithResolver(
      LOOP_RUNTIME_PACKAGE,
      started,
      new Set(),
      loopPhaseResolver,
      undefined,
    );
    if (!decision.action) {
      throw new Error(decision.reason ?? 'Loop Runtime rebuild produced no Build action');
    }
    const nextRun = recordOutcomeWithResolver(
      LOOP_RUNTIME_PACKAGE,
      decision.state,
      {
        actionId: decision.action.id,
        status: 'succeeded',
        summary: `Rebuilt local Runtime for ${state.name}`,
      },
      loopPhaseResolver,
      undefined,
    );
    if (nextRun.currentStep !== 'build') {
      throw new Error('Loop Runtime rebuild did not resume at Build');
    }
    const nextState: LoopChangeState = {
      ...state,
      revision: state.revision + 1,
      phase: 'build',
      run_id: nextRun.runId,
      verification_result: 'pending',
      verification_report: null,
      implementation_scope: null,
      verification_evidence: null,
      partial_allowance: null,
    };
    const evidenceHash = sha256Text(
      JSON.stringify({
        operation: 'runtime-rebuild',
        change: state.name,
        previousPhase: state.phase,
        nextPhase: 'build',
      }),
    );
    const journal = await prepareLoopTransition({
      paths: options.paths,
      previousState: state,
      nextState,
      previousRun: null,
      nextRun,
      evidenceHash,
      eventData: {
        previousPhase: state.phase,
        nextPhase: 'build',
        evidenceHash,
        summary: `Rebuilt local Runtime for ${state.name}`,
        artifacts: [],
        noCodeReason: null,
        verificationResult: null,
      },
      operation: 'runtime-rebuild',
      now: options.now,
      transitionId: options.transitionId,
    });
    transitionPrepared = true;
    await options.hooks?.afterPrepared?.(journal);
    const persisted = await continueLoopTransitionLocked(options.paths, state.name, options.hooks);
    if (!persisted) throw new Error('Loop Runtime rebuild journal disappeared before completion');
    await fs.rm(path.join(loopChangeDir(options.paths, state.name), 'evidence.md'), {
      force: true,
    });
    return {
      change: persisted,
      previousPhase: state.phase,
      next: 'auto',
      nextCommand: null,
      findings: [],
      continuation: loopContinuation({
        state: persisted,
        clarificationMode: options.clarificationMode,
      }),
    };
  } catch (error) {
    if (!transitionPrepared) await fs.rm(runtimeDir, { recursive: true, force: true });
    throw error;
  }
}

async function advanceLoopChangeLocked(
  options: AdvanceLoopChangeOptions & { maxVerifyFailures: number },
): Promise<LoopAdvanceResult> {
  const initialState = await readLoopChange(options.paths, options.name);
  const runtimeStorage = await inspectLoopRuntimeStorage(options.paths, options.name);
  if (runtimeStorage.status === 'invalid') {
    throw new Error(
      runtimeStorage.message ?? `Loop Runtime storage is invalid: ${runtimeStorage.path}`,
    );
  }
  if (runtimeStorage.status === 'missing') {
    const rebuilt = await rebuildMissingLoopRuntime(options, initialState);
    if (rebuilt) return rebuilt;
  }
  await settleLoopChangeJournalsLocked(options.paths, options.name);
  const state = await readLoopChange(options.paths, options.name);
  const previousPhase = state.phase;
  const changeDir = loopChangeDir(options.paths, options.name);
  const runtimeDir = loopChangeRuntimeDir(options.paths, options.name);
  const hash = loopAdvanceEvidenceHash(options.evidence);
  const existingRun = await readLoopRunState(runtimeDir);
  if (existingRun) {
    const trajectory = await readLoopTrajectory(runtimeDir, existingRun.trajectoryRef);
    const last = trajectory.at(-1);
    if (
      last?.type === 'state_transitioned' &&
      last.data.evidenceHash === hash &&
      last.data.nextPhase === state.phase
    ) {
      const verificationRetryIsFresh =
        last.data.previousPhase === 'verify'
          ? ['complete', 'partial'].includes(
              (
                await inspectLoopVerificationFreshness({
                  paths: options.paths,
                  state,
                  now: options.now,
                })
              ).freshness,
            )
          : true;
      if (!verificationRetryIsFresh) {
        // Do not let an old transition hash bypass the current report/envelope freshness fence.
      } else {
        const repair = Object.hasOwn(last.data, 'repairStagnation')
          ? await inspectLatestLoopRepairDecision(options.paths, state, options.maxVerifyFailures)
          : null;
        const repairFindings =
          repair && repair.disposition !== 'continue'
            ? structureLoopFindings({
                paths: options.paths,
                state,
                findings: [repairFinding(repair)],
              })
            : [];
        const stopped =
          repair?.disposition === 'manual-stop' || repair?.disposition === 'hard-stop';
        return {
          change: state,
          previousPhase: (last.data.previousPhase as LoopPhase) ?? state.phase,
          next: stopped ? 'manual' : 'auto',
          nextCommand: stopped
            ? null
            : state.phase === 'archive'
              ? `owner loop archive ${state.name} --dry-run`
              : null,
          findings: repairFindings,
          continuation: loopContinuation({
            state,
            findings: repairFindings,
            archiveReady: state.phase === 'archive' && state.verification_result === 'pass',
            clarificationMode: options.clarificationMode,
          }),
          ...(repair ? { repair } : {}),
        };
      }
    }
  }

  if (state.phase === 'archive') {
    if (!existingRun) throw new Error('Loop Archive Run state is missing');
    return retreatStaleLoopEvidence({
      transition: options,
      state,
      run: existingRun,
      evidenceHash: hash,
      force: hasReturnToBuild(options.evidence),
    });
  }
  if (state.phase === 'verify' && hasReturnToBuild(options.evidence)) {
    if (!existingRun) throw new Error('Loop Verify Run state is missing');
    return retreatStaleLoopEvidence({
      transition: options,
      state,
      run: existingRun,
      evidenceHash: hash,
      force: true,
    });
  }
  if (state.phase === 'verify' && !hasEvidenceRetreatExtras(options.evidence)) {
    if (!existingRun) throw new Error('Loop Verify Run state is missing');
    const freshness = await inspectLoopImplementationScopeFreshness({
      paths: options.paths,
      state,
      now: options.now,
    });
    if (freshness.freshness !== 'fresh') {
      return retreatStaleLoopEvidence({
        transition: options,
        state,
        run: existingRun,
        evidenceHash: hash,
      });
    }
  }

  const candidate = {
    ...state,
    spec_changes: await reconcileLoopSpecChanges(options.paths, state),
  };
  validateRepairEvidence(state, options.evidence);

  const guard = await inspectLoopGuard({
    paths: options.paths,
    state: candidate,
    evidence: options.evidence,
    clarificationMode: options.clarificationMode,
  });
  if (!guard.valid) {
    const findings = structureLoopFindings({
      paths: options.paths,
      state,
      findings: guard.findings,
    });
    return {
      change: state,
      previousPhase,
      next: 'manual',
      nextCommand: null,
      findings,
      continuation: loopContinuation({
        state,
        findings,
        clarificationMode: options.clarificationMode,
      }),
    };
  }

  const shapeContract =
    state.phase === 'shape'
      ? await collectLoopContractFiles({
          changeDir,
          briefRef: candidate.brief,
          specChanges: candidate.spec_changes,
        })
      : null;

  if (
    state.phase !== 'build' &&
    (options.evidence.allowPartialScopeHash !== undefined ||
      options.evidence.partialReason !== undefined)
  ) {
    throw new Error('Loop partial scope allowance is only valid while leaving Build');
  }

  const buildEvidence =
    state.phase === 'build'
      ? await inspectLoopBuildEvidence({
          paths: options.paths,
          state: candidate,
          artifactRefs: options.evidence.artifacts ?? [],
          noCodeReason: options.evidence.noCodeReason ?? null,
          allowPartialScopeHash: options.evidence.allowPartialScopeHash ?? null,
          partialReason: options.evidence.partialReason ?? null,
          confirmedSummary: options.evidence.summary,
          confirmed: options.evidence.confirmed ?? false,
          now: options.now,
        })
      : null;
  if (
    buildEvidence &&
    (state.approved_contract_hash ?? null) !== buildEvidence.contract.contract.contractHash &&
    !options.evidence.confirmed
  ) {
    const findings = structureLoopFindings({
      paths: options.paths,
      state,
      findings: [
        {
          code: 'contract-changed-after-approval',
          message:
            'Loop contract changed after approval; re-confirm the current contract before leaving Build',
        },
      ],
    });
    return {
      change: state,
      previousPhase,
      next: 'manual',
      nextCommand: null,
      findings,
      continuation: loopContinuation({
        state,
        findings,
        clarificationMode: options.clarificationMode,
      }),
    };
  }
  const preparedScope = buildEvidence
    ? {
        scopeHash: buildEvidence.bundle.scope.scopeHash,
        scopeRef: buildEvidence.scopeRef as LoopChangeState['implementation_scope'] & string,
        complete: buildEvidence.bundle.scope.complete,
        unresolvedScopeCount: buildEvidence.unresolvedScopes.length,
        partialAllowanceRef: buildEvidence.allowanceRef as LoopChangeState['partial_allowance'],
        acceptancePage: projectLoopAcceptancePage({
          criteria: buildEvidence.contract.contract.acceptance,
          acceptanceHash: buildEvidence.contract.contract.acceptanceHash,
        }),
      }
    : undefined;
  if (buildEvidence && buildEvidence.findings.length > 0) {
    await persistLoopBuildEvidence({
      paths: options.paths,
      state,
      preparation: buildEvidence,
      includeAllowance: false,
    });
    const findings = structureLoopFindings({
      paths: options.paths,
      state,
      findings: buildEvidence.findings,
    });
    return {
      change: state,
      previousPhase,
      next: 'manual',
      nextCommand: null,
      findings,
      continuation: loopContinuation({
        state,
        findings,
        clarificationMode: options.clarificationMode,
      }),
      preparedScope,
    };
  }

  let repairEventProjection: LoopRepairTrajectoryProjection | null = null;
  let repairScopeHashForEvent = buildEvidence ? loopRepairScopeHash(buildEvidence.bundle) : null;
  if (state.phase === 'build' && buildEvidence) {
    const repairGuard = await inspectLoopRepairBuildGuard({
      paths: options.paths,
      state,
      currentImplementationScope: buildEvidence.bundle,
      maxVerifyFailures: options.maxVerifyFailures,
      ...(options.evidence.repairOverrideSignature && options.evidence.repairOverrideSummary
        ? {
            override: {
              expectedSignatureHash: options.evidence.repairOverrideSignature,
              summary: options.evidence.repairOverrideSummary,
            },
          }
        : {}),
    });
    if (repairGuard.disposition !== 'proceed') {
      await persistLoopBuildEvidence({
        paths: options.paths,
        state,
        preparation: buildEvidence,
        includeAllowance: false,
      });
      const findings = structureLoopFindings({
        paths: options.paths,
        state,
        findings: [
          repairGuard.disposition === 'hard-stop' && repairGuard.overrideRecorded
            ? {
                code: 'repair-override-exhausted',
                message: `Loop repair already used its override for signature: ${repairGuard.signatureHash}`,
              }
            : repairFinding({
                disposition: repairGuard.disposition,
                reasonCode:
                  repairGuard.disposition === 'hard-stop'
                    ? 'repair-iteration-limit'
                    : 'repeated-failure-stop',
                signatureHash: repairGuard.signatureHash,
              }),
        ],
      });
      return {
        change: state,
        previousPhase,
        next: 'manual',
        nextCommand: null,
        findings,
        continuation: loopContinuation({
          state,
          findings,
          clarificationMode: options.clarificationMode,
        }),
        preparedScope: preparedScope
          ? { ...preparedScope, partialAllowanceRef: null }
          : preparedScope,
      };
    }
    repairEventProjection = repairGuard.eventProjection;
  }

  let verificationEvidence =
    state.phase === 'verify'
      ? await inspectLoopVerificationEvidence({
          paths: options.paths,
          state: candidate,
          result: options.evidence.verificationResult!,
          reportRef: options.evidence.verificationReport!,
          receiptRef: null,
          requireReceipt: false,
          preflightOnly: options.evidence.verificationResult === 'pass',
          now: options.now,
        })
      : null;

  // Validate the report, acceptance matrix, and acceptance receipts before
  // running the required check. Invalid Agent-authored evidence must not
  // trigger an expensive check that cannot make the report valid.
  if (verificationEvidence && !verificationEvidence.ready) {
    return loopVerificationFindingResult({
      paths: options.paths,
      state,
      previousPhase,
      clarificationMode: options.clarificationMode,
      preparation: verificationEvidence,
    });
  }

  if (state.phase === 'verify' && options.evidence.verificationResult === 'pass') {
    const verificationReceipt = (
      await checkLoopChangeLocked({ paths: options.paths, name: state.name })
    ).ref;
    verificationEvidence = await inspectLoopVerificationEvidence({
      paths: options.paths,
      state: candidate,
      result: options.evidence.verificationResult,
      reportRef: options.evidence.verificationReport!,
      receiptRef: verificationReceipt,
      preflight: verificationEvidence?.preflight,
      now: options.now,
    });
  }

  if (verificationEvidence && !verificationEvidence.ready) {
    return loopVerificationFindingResult({
      paths: options.paths,
      state,
      previousPhase,
      clarificationMode: options.clarificationMode,
      preparation: verificationEvidence,
    });
  }

  let repairDecision: LoopRepairDecisionProjection | null = null;
  if (
    state.phase === 'verify' &&
    options.evidence.verificationResult === 'fail' &&
    verificationEvidence?.ready &&
    verificationEvidence.envelope
  ) {
    const repairResult = await inspectLoopRepairFailureForTransition({
      paths: options.paths,
      state,
      envelope: verificationEvidence.envelope,
      maxVerifyFailures: options.maxVerifyFailures,
    });
    repairEventProjection = repairResult.eventProjection;
    repairScopeHashForEvent = repairResult.facts.implementationScopeHash;
    repairDecision = projectLoopRepairDecision(repairResult);
  }

  let run = existingRun;
  if (!run) {
    if (state.run_id !== null || state.phase !== 'shape') {
      throw new Error('Loop Run state is missing or inconsistent');
    }
    run = startLoopRun(LOOP_RUNTIME_PACKAGE, options.runId?.() ?? randomUUID(), LOOP_RUNTIME_HASH);
  }
  if (run.currentStep !== state.phase) {
    throw new Error(`Loop Run step ${run.currentStep ?? '(none)'} does not match ${state.phase}`);
  }
  const decision = decideWithResolver(
    LOOP_RUNTIME_PACKAGE,
    run,
    new Set(),
    loopPhaseResolver,
    undefined,
  );
  if (!decision.action) throw new Error(decision.reason ?? 'Loop runtime produced no action');
  const advanced = recordOutcomeWithResolver(
    LOOP_RUNTIME_PACKAGE,
    decision.state,
    {
      actionId: decision.action.id,
      status: 'succeeded',
      summary: options.evidence.summary,
      state: options.evidence.verificationResult
        ? { verification_result: options.evidence.verificationResult }
        : undefined,
    },
    loopPhaseResolver,
    undefined,
  );
  if (!advanced.currentStep) throw new Error('Archive completion must use the archive command');

  const updated = {
    ...candidate,
    revision: state.revision + 1,
    phase: advanced.currentStep as LoopPhase,
    approval: options.evidence.confirmed ? ('confirmed' as const) : state.approval,
    approved_contract_hash:
      state.phase === 'shape'
        ? shapeContract!.contract.contractHash
        : state.phase === 'build' && options.evidence.confirmed
          ? buildEvidence!.contract.contract.contractHash
          : (state.approved_contract_hash ?? null),
    run_id: run.runId,
    ...(state.phase === 'build'
      ? {
          verification_result: 'pending' as const,
          verification_report: null,
          implementation_scope: buildEvidence!.scopeRef as LoopChangeState['implementation_scope'],
          partial_allowance: buildEvidence!.allowanceRef as LoopChangeState['partial_allowance'],
          verification_evidence: null,
        }
      : {}),
    ...(state.phase === 'verify'
      ? {
          verification_result: options.evidence.verificationResult!,
          verification_report: verificationEvidence!.envelope!.reportRef,
          verification_evidence: verificationEvidence!
            .evidenceRef as LoopChangeState['verification_evidence'],
        }
      : {}),
  };
  const eventData = {
    previousPhase,
    nextPhase: updated.phase,
    evidenceHash: hash,
    summary: options.evidence.summary,
    artifacts: options.evidence.artifacts ?? [],
    noCodeReason: options.evidence.noCodeReason ?? null,
    verificationResult: options.evidence.verificationResult ?? null,
    ...((state.phase === 'build' || state.phase === 'verify') &&
    (state.phase === 'build'
      ? buildEvidence!.bundle.scope.scopeHash
      : verificationEvidence!.envelope!.implementationScopeHash)
      ? {
          implementationScopeHash:
            state.phase === 'build'
              ? buildEvidence!.bundle.scope.scopeHash
              : verificationEvidence!.envelope!.implementationScopeHash,
        }
      : {}),
    ...(repairScopeHashForEvent ? { repairScopeHash: repairScopeHashForEvent } : {}),
    ...(repairEventProjection ? { repairStagnation: repairEventProjection } : {}),
  };
  if (state.phase === 'build' && buildEvidence) {
    await persistLoopBuildEvidence({
      paths: options.paths,
      state,
      preparation: buildEvidence,
    });
  }
  if (state.phase === 'verify' && verificationEvidence) {
    await persistLoopVerificationEvidence({
      paths: options.paths,
      state,
      preparation: verificationEvidence,
    });
  }
  const journal = await prepareLoopTransition({
    paths: options.paths,
    previousState: state,
    nextState: updated,
    previousRun: existingRun,
    nextRun: advanced,
    evidenceHash: hash,
    eventData,
    now: options.now,
    transitionId: options.transitionId,
  });
  await options.hooks?.afterPrepared?.(journal);
  const persisted = await continueLoopTransitionLocked(options.paths, options.name, options.hooks);
  if (!persisted) throw new Error('Loop transition journal disappeared before completion');
  const repairFindings =
    repairDecision && repairDecision.disposition !== 'continue'
      ? structureLoopFindings({
          paths: options.paths,
          state: persisted,
          findings: [repairFinding(repairDecision)],
        })
      : [];
  const repairStopped =
    repairDecision?.disposition === 'manual-stop' || repairDecision?.disposition === 'hard-stop';
  return {
    change: persisted,
    previousPhase,
    next: repairStopped ? 'manual' : 'auto',
    nextCommand: repairStopped
      ? null
      : persisted.phase === 'archive'
        ? `owner loop archive ${persisted.name} --dry-run`
        : null,
    findings: repairFindings,
    continuation: loopContinuation({
      state: persisted,
      findings: repairFindings,
      archiveReady: persisted.phase === 'archive' && persisted.verification_result === 'pass',
      clarificationMode: options.clarificationMode,
    }),
    ...(preparedScope ? { preparedScope } : {}),
    ...(repairDecision ? { repair: repairDecision } : {}),
  };
}
