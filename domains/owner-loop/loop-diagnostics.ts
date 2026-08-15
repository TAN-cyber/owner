import { promises as fs } from 'fs';

import {
  validateLoopBrief,
  validateLoopSpecChanges,
  validateLoopVerification,
} from './loop-artifacts.js';
import { projectLoopAcceptancePage } from './loop-acceptance.js';
import { canonicalHash } from './loop-canonical-hash.js';
import { inspectLoopChange, loopChangeDir } from './loop-change.js';
import { collectLoopContractFiles } from './loop-contract-files.js';
import { readLoopSelectionRecord } from './loop-selection.js';
import { inspectLoopRunConsistency } from './loop-run-consistency.js';
import {
  filterLoopContentSnapshotToProjectScope,
  readLoopBaselineManifest,
} from './loop-snapshot.js';
import { inspectPendingLoopTransition } from './loop-transition-journal.js';
import { loopContinuation } from './loop-continuation.js';
import { structureLoopFindings, summarizeLoopFindings } from './loop-findings.js';
import { buildLoopResumeView, LOOP_INSPECTION_REASON_DETAIL_BUDGET } from './loop-resume-view.js';
import { inspectLoopArchivePreflight } from './loop-archive-inspection.js';
import { inspectLoopChangeConflicts } from './loop-conflict-inspection.js';
import { inspectLoopRepairStatus } from './loop-repair-integration.js';
import { readLoopVerificationEvidence } from './loop-evidence-storage.js';
import { inspectLoopImplementationScopeFreshness } from './loop-verification-runtime.js';
import {
  inspectLoopWorkspaceAdvisory,
  inspectLoopWorkspaceBinding,
  isLoopWorkspaceAdvisoryCode,
  projectLoopWorkspace,
  readLoopWorkspaceIdentity,
} from './loop-workspace.js';
import { captureLoopProtectedDirectoryGuard } from './loop-protected-file.js';
import { inspectLoopRuntimeStorage } from './loop-paths.js';
import type {
  LoopChangeState,
  LoopClarificationMode,
  LoopFinding,
  LoopProjectPaths,
  LoopStatusPageProjection,
  LoopStatusProjection,
} from './loop-types.js';

const LOOP_STATUS_CURSOR_PATTERN = /^loop-status-v1\.([a-f0-9]{64})\.([0-9a-z]+)\.([a-f0-9]{64})$/u;

export const LOOP_STATUS_PAGE_LIMITS = Object.freeze({
  maxItems: 24,
  maxChanges: 4_096,
  maxSerializedBytes: 512 * 1024,
});

function displayCommandArgs(args: readonly string[]): string {
  return args
    .map((value) => (/^[A-Za-z0-9_./:=+@-]+$/u.test(value) ? value : JSON.stringify(value)))
    .join(' ');
}

async function selectedName(paths: LoopProjectPaths): Promise<string | null> {
  return (await readLoopSelectionRecord(paths))?.change ?? null;
}

export function loopNextCommand(
  state: LoopChangeState,
  archiveReady: boolean,
  evidenceRetreat = false,
  _clarificationMode?: LoopClarificationMode,
): string | null {
  return loopContinuation({ state, archiveReady, evidenceRetreat }).command;
}

async function statusFindings(
  paths: LoopProjectPaths,
  state: LoopChangeState,
): Promise<LoopFinding[]> {
  const changeDir = loopChangeDir(paths, state.name);
  const findings = [
    ...(await validateLoopBrief(changeDir, state.brief)).findings,
    ...(await validateLoopSpecChanges(paths, state)).findings,
    ...(await inspectLoopRunConsistency(paths, state)),
  ];
  if (state.phase === 'shape' || state.phase === 'build') {
    try {
      const capturedBaseline = await readLoopBaselineManifest(paths, state.name);
      if (capturedBaseline === null) {
        findings.push({
          code: 'baseline-snapshot-missing',
          message: 'Loop baseline is missing; restore a trusted baseline before advancing',
        });
      } else {
        const baseline = await filterLoopContentSnapshotToProjectScope(paths, capturedBaseline);
        if (!baseline.complete) {
          findings.push({
            code: 'baseline-snapshot-incomplete',
            message: `Loop baseline is incomplete within the project-owned scope (${baseline.omittedCount} omitted entries); resolve the omissions before advancing`,
          });
        }
      }
    } catch (error) {
      findings.push({
        code: 'baseline-snapshot-invalid',
        message: `Loop baseline could not be inspected safely: ${(error as Error).message}`,
      });
    }
  }
  if (state.phase === 'build') {
    try {
      const current = await collectLoopContractFiles({
        changeDir,
        briefRef: state.brief,
        specChanges: state.spec_changes,
      });
      if ((state.approved_contract_hash ?? null) !== current.contract.contractHash) {
        findings.push({
          code: 'contract-changed-after-approval',
          message:
            state.approval === null ||
            state.approved_contract_hash === null ||
            state.approved_contract_hash === undefined
              ? 'Loop approval is not bound to a contract hash; re-confirm the current contract'
              : 'Loop contract changed after approval; re-confirm the current contract',
        });
      }
    } catch (error) {
      findings.push({
        code: 'contract-inspection-invalid',
        message: `Loop approved contract could not be inspected safely: ${(error as Error).message}`,
      });
    }
  }
  try {
    if (await inspectPendingLoopTransition(paths, state.name)) {
      findings.unshift({
        code: 'transition-incomplete',
        message: 'Loop phase transition recovery is pending',
      });
    }
  } catch (error) {
    findings.unshift({
      code: 'transition-invalid',
      message: `Loop transition journal is invalid: ${(error as Error).message}`,
    });
  }
  if (state.verification_report) {
    findings.push(
      ...(await validateLoopVerification(changeDir, state.verification_report)).findings,
    );
  } else if (
    state.phase === 'verify' ||
    state.phase === 'archive' ||
    state.verification_result === 'pass'
  ) {
    findings.push({
      code: 'verification-report-missing',
      message: 'Loop change has no verification report',
    });
  }
  return findings;
}

export async function inspectLoopStatus(
  paths: LoopProjectPaths,
  name: string,
  options?: {
    details?: boolean;
    acceptanceCursor?: string;
    includeConflictFindings?: boolean;
    clarificationMode?: LoopClarificationMode;
    maxVerifyFailures?: number;
  },
): Promise<LoopStatusProjection> {
  const selected = (await selectedName(paths)) === name;
  const runtime = await inspectLoopRuntimeStorage(paths, name);
  const workspace = await projectLoopWorkspace(paths, name);
  let state: LoopChangeState;
  try {
    const inspection = await inspectLoopChange(paths, name);
    if (inspection.status === 'migration-required' && inspection.state) {
      return {
        name,
        phase: inspection.state.phase,
        revision: 'revision' in inspection.state ? inspection.state.revision : null,
        approval: inspection.state.approval,
        verificationResult: inspection.state.verification_result,
        specChanges: inspection.state.spec_changes.length,
        selected,
        nextCommand: null,
        archiveReady: false,
        inspection: {
          freshness: 'stale',
          codes: ['migration-required'],
          reasonCount: 1,
          codesTruncated: false,
        },
        findingSummary: {
          total: 0,
          errors: 0,
          warnings: 0,
          info: 0,
          requiresUserDecision: false,
          codes: [],
          truncated: false,
        },
        detailsCommand: `owner loop status ${name} --details`,
        checkpoint: null,
        continuation: null,
        workspace,
        runtime,
        schema: inspection.schema,
        migrationRequired: true,
        minimumRuntimeVersion: inspection.minimumRuntimeVersion,
        error: inspection.message,
      };
    }
    if (inspection.status !== 'current' || !inspection.state) {
      return {
        name,
        phase: 'invalid',
        revision: null,
        approval: null,
        verificationResult: 'pending',
        specChanges: 0,
        selected,
        nextCommand: null,
        archiveReady: false,
        inspection: {
          freshness: 'stale',
          codes: ['runtime-incompatible'],
          reasonCount: 1,
          codesTruncated: false,
        },
        findingSummary: {
          total: 0,
          errors: 0,
          warnings: 0,
          info: 0,
          requiresUserDecision: false,
          codes: [],
          truncated: false,
        },
        detailsCommand: `owner loop status ${name} --details`,
        checkpoint: null,
        continuation: null,
        workspace,
        runtime,
        schema: inspection.schema,
        minimumRuntimeVersion: inspection.minimumRuntimeVersion,
        error: inspection.message ?? `Loop change ${name} is incompatible`,
      };
    }
    state = inspection.state as LoopChangeState;
  } catch (error) {
    return {
      name,
      phase: 'invalid',
      revision: null,
      approval: null,
      verificationResult: 'pending',
      specChanges: 0,
      selected,
      nextCommand: null,
      archiveReady: false,
      inspection: {
        freshness: 'stale',
        codes: ['change-invalid'],
        reasonCount: 1,
        codesTruncated: false,
      },
      findingSummary: {
        total: 0,
        errors: 0,
        warnings: 0,
        info: 0,
        requiresUserDecision: false,
        codes: [],
        truncated: false,
      },
      detailsCommand: `owner loop status ${name} --details`,
      checkpoint: null,
      continuation: null,
      workspace,
      runtime,
      error: (error as Error).message,
    };
  }
  if (runtime.status !== 'available') {
    const rawFinding: LoopFinding = {
      code: runtime.status === 'missing' ? 'runtime-missing' : 'runtime-storage-invalid',
      message:
        runtime.status === 'missing'
          ? `Loop Runtime is missing; continue ${state.name} to rebuild local execution state`
          : (runtime.message ?? 'Loop Runtime storage is invalid'),
      path: runtime.path,
    };
    const findings = structureLoopFindings({ paths, state, findings: [rawFinding] });
    const continuation = loopContinuation({ state, findings });
    return {
      name: state.name,
      phase: state.phase,
      revision: state.revision,
      approval: state.approval,
      verificationResult: state.verification_result,
      specChanges: state.spec_changes.length,
      selected,
      nextCommand: continuation.command,
      archiveReady: false,
      inspection: {
        freshness: 'stale',
        codes: [rawFinding.code],
        reasonCount: 1,
        codesTruncated: false,
      },
      findingSummary: summarizeLoopFindings(findings),
      detailsCommand: `owner loop status ${state.name} --details`,
      checkpoint: null,
      continuation,
      workspace,
      runtime,
      ...(options?.details ? { findings } : {}),
      schema: state.schema,
      minimumRuntimeVersion: state.minimum_runtime_version,
      ...(runtime.status === 'invalid' ? { error: rawFinding.message } : {}),
    };
  }
  const resume = await buildLoopResumeView({ paths, state });
  let repair: Awaited<ReturnType<typeof inspectLoopRepairStatus>> = null;
  const repairFindings: LoopFinding[] = [];
  if (state.phase === 'build' && state.verification_result === 'fail') {
    try {
      repair = await inspectLoopRepairStatus(paths, state, options?.maxVerifyFailures ?? 5);
      if (repair && (repair.disposition === 'manual-stop' || repair.disposition === 'hard-stop')) {
        const code =
          repair.disposition === 'hard-stop'
            ? 'repair-iteration-limit'
            : repair.overrideRecorded
              ? 'repair-override-exhausted'
              : 'repair-stagnation-stop';
        repairFindings.push({
          code,
          message: `Loop repair is stopped at failure signature: ${repair.signatureHash}`,
        });
      }
    } catch {
      repairFindings.push({
        code: 'trajectory-invalid',
        message: 'Loop repair history could not be reconstructed safely',
      });
    }
  }
  let acceptancePage: LoopStatusProjection['acceptancePage'];
  if (
    options?.details &&
    (state.phase === 'build' || state.phase === 'verify' || state.phase === 'archive')
  ) {
    try {
      const contract = await collectLoopContractFiles({
        changeDir: loopChangeDir(paths, state.name),
        briefRef: state.brief,
        specChanges: state.spec_changes,
      });
      const verificationStatuses = new Map<
        string,
        'satisfied' | 'failed' | 'missing' | 'unverified'
      >();
      if (
        state.phase === 'build' &&
        state.verification_result === 'fail' &&
        state.verification_evidence
      ) {
        const envelope = await readLoopVerificationEvidence(
          paths,
          state.name,
          state.verification_evidence,
        );
        for (const entry of envelope.acceptanceTrace.entries) {
          verificationStatuses.set(
            entry.acceptanceId,
            entry.status === 'failed'
              ? 'failed'
              : entry.status === 'missing'
                ? 'missing'
                : 'satisfied',
          );
        }
      }
      const projectedAcceptancePage = projectLoopAcceptancePage({
        criteria: contract.contract.acceptance,
        acceptanceHash: contract.contract.acceptanceHash,
        verificationStatuses,
        failedCheckIds: repair?.failedCheckIds ?? [],
        ...(options.acceptanceCursor ? { cursor: options.acceptanceCursor } : {}),
      });
      const nextPageArgs = projectedAcceptancePage.nextCursor
        ? [
            'owner',
            'loop',
            'status',
            state.name,
            '--details',
            '--acceptance-cursor',
            projectedAcceptancePage.nextCursor,
            '--project-root',
            paths.projectRoot,
          ]
        : null;
      acceptancePage = {
        ...projectedAcceptancePage,
        ...(nextPageArgs
          ? {
              nextPageCommand: displayCommandArgs(nextPageArgs),
              nextPageArgs,
            }
          : {}),
      };
    } catch (error) {
      if (options.acceptanceCursor) throw error;
      acceptancePage = undefined;
    }
  }
  const conflictFindings: LoopFinding[] = [];
  if (options?.includeConflictFindings !== false) {
    try {
      const conflicts = await inspectLoopChangeConflicts(paths, state.name, {
        tolerateInvalidSiblings: true,
      });
      conflictFindings.push(
        ...conflicts.findingCodes.map((code) => ({
          code,
          message: `Loop change overlap is visible in the current root: ${code}`,
        })),
      );
    } catch {
      conflictFindings.push({
        code: 'loop-conflict-inspection-invalid',
        message: 'Loop change overlap could not be recomputed safely',
      });
    }
  }
  const workspaceFindings: LoopFinding[] = [];
  try {
    const identity = await readLoopWorkspaceIdentity(paths, state.name);
    if (identity) {
      if (identity.schema === 'owner.loop.workspace.v3') {
        const workspace = await inspectLoopWorkspaceBinding({ paths, identity });
        if (workspace.state === 'drifted' && workspace.code) {
          workspaceFindings.push({
            code: workspace.code,
            message: workspace.message ?? 'Loop workspace binding is no longer valid',
          });
        }
      } else {
        const workspace = await inspectLoopWorkspaceAdvisory({ paths, identity });
        workspaceFindings.push(
          ...workspace.findingCodes.map((code) => ({
            code,
            message: `Loop workspace advisory changed: ${code} (${workspace.driftComponents.join(', ') || 'no-component'})`,
          })),
        );
      }
    }
  } catch {
    workspaceFindings.push({
      code: 'workspace-binding-invalid',
      message: 'Loop workspace binding could not be read or validated safely',
    });
  }
  const verifyScopeFindings: LoopFinding[] = [];
  let verifyEvidenceRetreat = false;
  if (state.phase === 'verify') {
    const freshness = await inspectLoopImplementationScopeFreshness({ paths, state });
    verifyEvidenceRetreat = freshness.freshness !== 'fresh';
    verifyScopeFindings.push(
      ...freshness.findingCodes.map((code) => ({
        code,
        message: `Loop Verify implementation scope is not current: ${code}`,
      })),
    );
  }
  let archivePreflight: Awaited<ReturnType<typeof inspectLoopArchivePreflight>> | null = null;
  const archiveFindings: LoopFinding[] = [];
  if (state.phase === 'archive') {
    try {
      archivePreflight = await inspectLoopArchivePreflight({ paths, name: state.name });
      archiveFindings.push(
        ...archivePreflight.findingCodes.map((code) => ({
          code,
          message: `Loop Archive is blocked: ${code}`,
        })),
      );
    } catch {
      archiveFindings.push({
        code: 'archive-preflight-invalid',
        message: 'Loop Archive preflight could not be recomputed safely',
      });
    }
  }
  const rawFindings = [
    ...(await statusFindings(paths, state)),
    ...resume.findings,
    ...conflictFindings,
    ...workspaceFindings,
    ...verifyScopeFindings,
    ...repairFindings,
    ...archiveFindings,
  ].filter(
    (finding, index, values) =>
      values.findIndex(
        (candidate) => candidate.code === finding.code && candidate.path === finding.path,
      ) === index,
  );
  const findings = structureLoopFindings({ paths, state, findings: rawFindings });
  const archiveBlockingFindings = findings.filter(
    (finding) => !isLoopWorkspaceAdvisoryCode(finding.code),
  );
  const archiveReady =
    state.phase === 'archive' &&
    archivePreflight?.ready === true &&
    archiveBlockingFindings.length === 0;
  const evidenceRetreat =
    verifyEvidenceRetreat ||
    (state.phase === 'archive' &&
      (archivePreflight?.findingCodes ?? []).some((code) =>
        new Set([
          'verification-evidence-stale',
          'verification-evidence-invalid',
          'verification-evidence-missing',
          'verification-contract-stale',
          'verification-implementation-stale',
          'verification-report-stale',
          'verification-state-mismatch',
        ]).has(code),
      ));
  const mutationBlocked = findings.some(
    (finding) =>
      finding.code === 'trajectory-tail-incomplete' ||
      finding.code === 'trajectory-invalid' ||
      finding.requiredAction === 'return-to-bound-working-directory' ||
      finding.requiredAction === 'repair-workspace-binding',
  );
  const repairBlocked =
    repair?.disposition === 'manual-stop' || repair?.disposition === 'hard-stop';
  const firstErrorFinding = findings.find((finding) => finding.severity === 'error');
  return {
    name: state.name,
    phase: state.phase,
    revision: state.revision,
    approval: state.approval,
    verificationResult: state.verification_result,
    specChanges: state.spec_changes.length,
    selected,
    nextCommand:
      mutationBlocked || repairBlocked
        ? null
        : loopNextCommand(state, archiveReady, evidenceRetreat, options?.clarificationMode),
    archiveReady,
    inspection: resume.inspection,
    findingSummary: summarizeLoopFindings(findings),
    detailsCommand: `owner loop status ${state.name} --details`,
    checkpoint: resume.checkpoint,
    continuation: loopContinuation({
      state,
      findings,
      archiveReady,
      evidenceRetreat,
      clarificationMode: options?.clarificationMode,
    }),
    workspace,
    runtime,
    repair,
    ...(options?.details
      ? {
          ...(acceptancePage ? { acceptancePage } : {}),
          findings: findings.slice(0, 50),
          inspectionDetails: resume.inspectionDetails,
          checkpointDetails: resume.checkpointDetails,
          budgets: {
            maxFindings: 50,
            maxInspectionReasons: LOOP_INSPECTION_REASON_DETAIL_BUDGET,
            maxCheckpointArtifacts: resume.maxCheckpointArtifacts,
            findingsTruncated: findings.length > 50,
            inspectionReasonsTruncated: resume.inspectionDetails.reasonsTruncated,
            checkpointArtifactsTruncated: false,
          },
        }
      : {}),
    schema: state.schema,
    minimumRuntimeVersion: state.minimum_runtime_version,
    ...(firstErrorFinding ? { error: firstErrorFinding.message } : {}),
  };
}

export async function listLoopChangeNames(paths: LoopProjectPaths): Promise<string[]> {
  let guard: Awaited<ReturnType<typeof captureLoopProtectedDirectoryGuard>>;
  try {
    guard = await captureLoopProtectedDirectoryGuard({
      root: paths.loopRoot,
      directory: paths.changesDir,
      label: 'Loop status changes directory',
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const names: string[] = [];
  const directory = await fs.opendir(paths.changesDir);
  try {
    for await (const entry of directory) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      names.push(entry.name);
      if (names.length > LOOP_STATUS_PAGE_LIMITS.maxChanges) {
        throw new Error(
          `Loop status exceeds ${LOOP_STATUS_PAGE_LIMITS.maxChanges} visible changes`,
        );
      }
    }
  } finally {
    await directory.close().catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ERR_DIR_CLOSED') throw error;
    });
  }
  await guard.verify();
  return names.sort();
}

function loopStatusCursor(namesHash: string, offset: number): string {
  const encodedOffset = offset.toString(36);
  const integrity = canonicalHash('owner.loop.status-cursor.v1', { namesHash, offset });
  return `loop-status-v1.${namesHash}.${encodedOffset}.${integrity}`;
}

function loopStatusOffset(options: {
  namesHash: string;
  total: number;
  cursor?: string | null;
}): number {
  if (options.cursor === undefined || options.cursor === null) return 0;
  const match = LOOP_STATUS_CURSOR_PATTERN.exec(options.cursor);
  if (!match) throw new Error('Loop status cursor is invalid');
  if (match[1] !== options.namesHash) throw new Error('Loop status cursor is stale');
  const offset = Number.parseInt(match[2], 36);
  if (
    !Number.isSafeInteger(offset) ||
    offset <= 0 ||
    offset >= options.total ||
    offset.toString(36) !== match[2]
  ) {
    throw new Error('Loop status cursor offset is invalid');
  }
  const expected = canonicalHash('owner.loop.status-cursor.v1', {
    namesHash: options.namesHash,
    offset,
  });
  if (match[3] !== expected) throw new Error('Loop status cursor integrity check failed');
  return offset;
}

export async function listLoopStatusPage(
  paths: LoopProjectPaths,
  options?: {
    cursor?: string | null;
    clarificationMode?: LoopClarificationMode;
    maxVerifyFailures?: number;
  },
): Promise<LoopStatusPageProjection> {
  const names = await listLoopChangeNames(paths);
  const namesHash = canonicalHash('owner.loop.status-names.v1', names);
  const offset = loopStatusOffset({
    namesHash,
    total: names.length,
    cursor: options?.cursor,
  });
  const candidates = await Promise.all(
    names.slice(offset, offset + LOOP_STATUS_PAGE_LIMITS.maxItems).map((name) =>
      inspectLoopStatus(paths, name, {
        includeConflictFindings: false,
        clarificationMode: options?.clarificationMode,
        maxVerifyFailures: options?.maxVerifyFailures,
      }),
    ),
  );
  const items: LoopStatusProjection[] = [];
  for (const candidate of candidates) {
    const trialItems = [...items, candidate];
    const nextOffset = offset + trialItems.length;
    const trial: LoopStatusPageProjection = {
      schema: 'owner.loop.status-page.v1',
      total: names.length,
      offset,
      items: trialItems,
      nextCursor: nextOffset < names.length ? loopStatusCursor(namesHash, nextOffset) : null,
      nextPageCommand:
        nextOffset < names.length
          ? displayCommandArgs([
              'owner',
              'loop',
              'status',
              '--cursor',
              loopStatusCursor(namesHash, nextOffset),
            ])
          : null,
      nextPageArgs:
        nextOffset < names.length
          ? ['owner', 'loop', 'status', '--cursor', loopStatusCursor(namesHash, nextOffset)]
          : null,
      limits: { ...LOOP_STATUS_PAGE_LIMITS },
    };
    if (
      Buffer.byteLength(JSON.stringify(trial), 'utf8') > LOOP_STATUS_PAGE_LIMITS.maxSerializedBytes
    ) {
      if (items.length === 0) {
        throw new Error('Loop status item exceeds its page serialization budget');
      }
      break;
    }
    items.push(candidate);
  }
  const nextOffset = offset + items.length;
  const nextCursor = nextOffset < names.length ? loopStatusCursor(namesHash, nextOffset) : null;
  const nextPageArgs = nextCursor ? ['owner', 'loop', 'status', '--cursor', nextCursor] : null;
  return {
    schema: 'owner.loop.status-page.v1',
    total: names.length,
    offset,
    items,
    nextCursor,
    nextPageCommand: nextPageArgs ? displayCommandArgs(nextPageArgs) : null,
    nextPageArgs,
    limits: { ...LOOP_STATUS_PAGE_LIMITS },
  };
}

/** Compatibility projection for in-process callers; CLI consumers receive the resumable page. */
export async function listLoopStatus(
  paths: LoopProjectPaths,
  options?: { clarificationMode?: LoopClarificationMode; maxVerifyFailures?: number },
): Promise<LoopStatusProjection[]> {
  return (
    await listLoopStatusPage(paths, {
      clarificationMode: options?.clarificationMode,
      maxVerifyFailures: options?.maxVerifyFailures,
    })
  ).items;
}

export async function inspectLoopArtifactFindings(
  paths: LoopProjectPaths,
  state: LoopChangeState,
): Promise<LoopFinding[]> {
  return statusFindings(paths, state);
}
