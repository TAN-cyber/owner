import {
  inspectLoopCheckpointFreshness,
  LOOP_CHECKPOINT_LIMITS,
  readLoopCheckpointJournal,
  loopCheckpointJournalFile,
} from './loop-checkpoint-storage.js';
import type {
  LoopChangeState,
  LoopCheckpointCompactView,
  LoopCheckpointDetailView,
  LoopFinding,
  LoopInspectionDetailView,
  LoopInspectionView,
  LoopProjectPaths,
} from './loop-types.js';

const COMPACT_TEXT_BUDGET = 240;
const COMPACT_REASON_CODE_BUDGET = 8;
export const LOOP_INSPECTION_REASON_DETAIL_BUDGET = 50;

function compactText(value: string): string {
  const characters = Array.from(value);
  return characters.length <= COMPACT_TEXT_BUDGET
    ? value
    : `${characters.slice(0, COMPACT_TEXT_BUDGET - 1).join('')}…`;
}

function reasonCode(reason: string): string {
  const separator = reason.indexOf(':');
  return separator < 0 ? reason : reason.slice(0, separator);
}

function inspectionViews(reasons: readonly string[]): {
  inspection: LoopInspectionView;
  inspectionDetails: LoopInspectionDetailView;
} {
  const codes = [...new Set(reasons.map(reasonCode))];
  const inspection: LoopInspectionView = {
    freshness:
      reasons.length === 0 || (reasons.length === 1 && reasons[0] === 'no-checkpoint')
        ? 'fresh'
        : 'stale',
    codes: codes.slice(0, COMPACT_REASON_CODE_BUDGET),
    reasonCount: reasons.length,
    codesTruncated: codes.length > COMPACT_REASON_CODE_BUDGET,
  };
  return {
    inspection,
    inspectionDetails: {
      ...inspection,
      reasons: reasons.slice(0, LOOP_INSPECTION_REASON_DETAIL_BUDGET),
      reasonsTruncated: reasons.length > LOOP_INSPECTION_REASON_DETAIL_BUDGET,
    },
  };
}

export async function buildLoopResumeView(options: {
  paths: LoopProjectPaths;
  state: LoopChangeState;
}): Promise<{
  inspection: LoopInspectionView;
  inspectionDetails: LoopInspectionDetailView;
  checkpoint: LoopCheckpointCompactView | null;
  checkpointDetails: LoopCheckpointDetailView | null;
  findings: LoopFinding[];
  maxCheckpointArtifacts: number;
}> {
  let pendingFinding: LoopFinding | null = null;
  try {
    const pending = await readLoopCheckpointJournal(options.paths, options.state.name);
    if (pending) {
      pendingFinding = {
        code: 'checkpoint-progress-incomplete',
        message: `Loop progress checkpoint ${pending.id} requires deterministic recovery`,
        path: loopCheckpointJournalFile(options.paths, options.state.name),
      };
    }
  } catch (error) {
    pendingFinding = {
      code: 'checkpoint-progress-invalid',
      message: `Loop progress checkpoint journal is invalid: ${(error as Error).message}. Automatic repair is unavailable; inspect and move the invalid checkpoint journal aside before retrying`,
      path: loopCheckpointJournalFile(options.paths, options.state.name),
    };
  }
  const inspected = await inspectLoopCheckpointFreshness({
    paths: options.paths,
    name: options.state.name,
    stateRevision: options.state.revision,
  });
  const allReasons = pendingFinding
    ? [pendingFinding.code, ...inspected.reasons]
    : inspected.reasons;
  const views = inspectionViews(allReasons);
  if (!inspected.checkpoint) {
    return {
      inspection: views.inspection,
      inspectionDetails: views.inspectionDetails,
      checkpoint: null,
      checkpointDetails: null,
      findings: pendingFinding ? [pendingFinding, ...inspected.findings] : inspected.findings,
      maxCheckpointArtifacts: LOOP_CHECKPOINT_LIMITS.maxArtifacts,
    };
  }
  const compact: LoopCheckpointCompactView = {
    id: inspected.checkpoint.id,
    createdAt: inspected.checkpoint.createdAt,
    phase: inspected.checkpoint.phase,
    stateRevision: inspected.checkpoint.stateRevision,
    summary: compactText(inspected.checkpoint.summary),
    nextAction: compactText(inspected.checkpoint.nextAction),
    artifactCount: inspected.checkpoint.artifactCount,
  };
  const details: LoopCheckpointDetailView | null = inspected.manifest
    ? {
        ...compact,
        summary: inspected.checkpoint.summary,
        nextAction: inspected.checkpoint.nextAction,
        manifestHash: inspected.checkpoint.manifestHash,
        manifestRef: inspected.checkpoint.manifestRef,
        artifacts: inspected.manifest.artifacts,
        totalBytes: inspected.manifest.totalBytes,
      }
    : null;
  return {
    inspection: views.inspection,
    inspectionDetails: views.inspectionDetails,
    checkpoint: compact,
    checkpointDetails: details,
    findings: pendingFinding ? [pendingFinding, ...inspected.findings] : inspected.findings,
    maxCheckpointArtifacts: LOOP_CHECKPOINT_LIMITS.maxArtifacts,
  };
}
