import type {
  WorkflowLoopEnabledProjectConfig,
  WorkflowLoopPendingRootMove,
  WorkflowLoopRootMoveCleanup,
  WorkflowLoopRootMoveCleanupKind,
  WorkflowLoopSnapshotConfig,
} from '../workflow-contract/types.js';

export type LoopPhase = 'shape' | 'build' | 'verify' | 'archive';
export type LoopApproval = null | 'implicit' | 'confirmed';
export type LoopVerificationResult = 'pending' | 'pass' | 'fail';
export type LoopSpecOperation = 'create' | 'replace' | 'remove';
export type LoopClarificationMode = WorkflowLoopEnabledProjectConfig['loop']['clarification_mode'];
export type LoopVerificationProtocol = 'legacy-v1';

export const LOOP_RUNTIME_PROTOCOL_VERSION = 3 as const;
export const LOOP_CHANGE_SCHEMA = 'owner.loop.v3' as const;
export const LOOP_V2_CHANGE_SCHEMA = 'owner.loop.v2' as const;
export const LOOP_LEGACY_CHANGE_SCHEMA = 'owner.loop.v1' as const;
export const LOOP_TRANSITION_SCHEMA = 'owner.loop.transition.v3' as const;
export const LOOP_V2_TRANSITION_SCHEMA = 'owner.loop.transition.v2' as const;
export const LOOP_LEGACY_TRANSITION_SCHEMA = 'owner.loop.transition.v1' as const;

export type LoopRootMoveCleanupKind = WorkflowLoopRootMoveCleanupKind;
export type LoopRootMoveCleanup = WorkflowLoopRootMoveCleanup;
export type LoopPendingRootMove = WorkflowLoopPendingRootMove;
export type LoopSnapshotConfig = WorkflowLoopSnapshotConfig;

export interface LoopSnapshotPolicy {
  schema: 'owner.loop.snapshot-policy.v1';
  include: string[];
  exclude: string[];
  hash: string;
}

export type OwnerProjectConfig = WorkflowLoopEnabledProjectConfig;
export type LoopArchiveConfirmation =
  WorkflowLoopEnabledProjectConfig['loop']['archive_confirmation'];

export interface LoopProjectPaths {
  projectRoot: string;
  configFile: string;
  artifactRoot: string;
  artifactRootRef: string;
  loopRoot: string;
  specsDir: string;
  changesDir: string;
  archiveDir: string;
  runtimeDir: string;
  changesRuntimeDir: string;
  locksDir: string;
  transactionsDir: string;
}

export interface LoopSpecChange {
  capability: string;
  operation: LoopSpecOperation;
  source?: string;
  base_hash: string | null;
}

interface LoopChangeStateFields {
  name: string;
  language: 'en' | 'zh-CN';
  phase: LoopPhase;
  brief: 'brief.md';
  approval: LoopApproval;
  spec_changes: LoopSpecChange[];
  verification_result: LoopVerificationResult;
  verification_report: string | null;
  archived: boolean;
  created_at: string;
  run_id: string | null;
}

export interface LoopLegacyChangeState extends LoopChangeStateFields {
  schema: typeof LOOP_LEGACY_CHANGE_SCHEMA;
}

export interface LoopV2ChangeState extends LoopChangeStateFields {
  schema: typeof LOOP_V2_CHANGE_SCHEMA;
  minimum_runtime_version: 2;
  revision: number;
}

export type LoopContentAddressedRef =
  `runtime/evidence/${'scopes' | 'allowances' | 'verifications'}/${string}.json`;

export interface LoopChangeState extends LoopChangeStateFields {
  schema: typeof LOOP_CHANGE_SCHEMA;
  minimum_runtime_version: typeof LOOP_RUNTIME_PROTOCOL_VERSION;
  revision: number;
  verification_protocol: LoopVerificationProtocol;
  /** Hash of the brief/spec contract that the current approval applies to. */
  approved_contract_hash: string | null;
  implementation_scope: LoopContentAddressedRef | null;
  verification_evidence: LoopContentAddressedRef | null;
  partial_allowance: LoopContentAddressedRef | null;
}

export type LoopReadableChangeState = LoopLegacyChangeState | LoopV2ChangeState | LoopChangeState;

export interface LoopChangeSchemaInspection {
  status: 'current' | 'migration-required' | 'runtime-incompatible';
  schema: string;
  minimumRuntimeVersion: number | null;
  state: LoopReadableChangeState | null;
  message?: string;
}

export interface LoopSnapshotEntry {
  path: string;
  hash: string;
  size: number;
  type: 'file';
  /**
   * Git blob object id recorded when the entry was captured from a Git-tracked
   * file. Used by the incremental snapshot path to decide whether a file's
   * content is unchanged since baseline (same object id ⇒ same content ⇒ same
   * Owner hash) without re-reading the file. Absent for non-Git projects,
   * legacy manifests, and physically-captured entries.
   */
  gitObjectId?: string;
}

export interface LoopSnapshotOmission {
  path: string;
  size: number | null;
  type: 'file' | 'directory' | 'other';
  reason:
    | 'file-size'
    | 'file-count'
    | 'total-size'
    | 'manifest-size'
    | 'changed-during-read'
    | 'unreadable'
    | 'gitlink-unavailable'
    | 'gitlink-dirty'
    | 'gitlink-changed'
    | 'legacy-gitlink-boundary'
    | 'git-enumeration-limit'
    | 'git-selection-changed'
    | 'physical-enumeration-limit'
    | 'physical-selection-changed';
}

export interface LoopSnapshotOmissionOverflow {
  ref: string;
  hash: string;
  count: number;
}

export interface LoopGitSelectionStreamEvidence {
  hash: string;
  recordCount: number;
  storedRecordCount: number;
  stdoutBytes: number;
  overflow: boolean;
}

export interface LoopGitSelectionEvidence {
  schema: 'owner.loop.git-selection.v1';
  status: 'overflow' | 'changed' | 'overflow-and-changed';
  stageBefore: LoopGitSelectionStreamEvidence;
  combined: LoopGitSelectionStreamEvidence;
  stageAfter: LoopGitSelectionStreamEvidence;
  finalStageBefore: LoopGitSelectionStreamEvidence;
  finalCombined: LoopGitSelectionStreamEvidence;
  finalStageAfter: LoopGitSelectionStreamEvidence;
}

export interface LoopPhysicalSelectionStreamEvidence {
  hash: string;
  visitedNodeCount: number;
  recordCount: number;
  storedRecordCount: number;
  encodedBytes: number;
  overflow: boolean;
  unstable: boolean;
}

export interface LoopPhysicalSelectionEvidence {
  schema: 'owner.loop.physical-selection.v1';
  status: 'overflow' | 'changed' | 'overflow-and-changed';
  before: LoopPhysicalSelectionStreamEvidence;
  after: LoopPhysicalSelectionStreamEvidence;
}

export interface LoopGitProjectionEvidence {
  provider: 'git';
  selection?: LoopGitSelectionEvidence;
}

export type LoopContentSnapshotCapture =
  | {
      provider: 'git';
      gitSelection?: LoopGitSelectionEvidence;
      physicalSelection?: never;
      projection?: never;
    }
  | {
      provider: 'physical-tree';
      gitSelection?: never;
      physicalSelection?: LoopPhysicalSelectionEvidence;
      projection?: never;
    }
  | {
      provider: 'physical-tree';
      gitSelection?: never;
      physicalSelection?: never;
      projection: LoopGitProjectionEvidence;
    };

export interface LoopContentSnapshotManifest {
  schema: 'owner.loop.content-snapshot.v1';
  origin: 'change-created' | 'legacy-migration' | 'explicit';
  capture?: LoopContentSnapshotCapture;
  createdAt: string;
  complete: boolean;
  limits: {
    maxFiles: number;
    maxFileBytes: number;
    maxTotalBytes: number;
    maxManifestBytes: number;
    maxDurationMs?: number;
  };
  policy?: LoopSnapshotPolicy;
  entries: LoopSnapshotEntry[];
  omitted: LoopSnapshotOmission[];
  omittedCount: number;
  omissionOverflow?: LoopSnapshotOmissionOverflow;
}

export interface LoopFinding {
  code: string;
  message: string;
  path?: string;
}

export type LoopFindingSeverity = 'info' | 'warning' | 'error';

/** Stable, machine-readable finding emitted by Loop command projections. */
export interface LoopStructuredFinding {
  code: string;
  message: string;
  severity: LoopFindingSeverity;
  path: string | null;
  requiredAction: string;
  retryCommand: string | null;
  repairCommand: string | null;
  requiresUserDecision: boolean;
}

export interface LoopFindingSummary {
  total: number;
  errors: number;
  warnings: number;
  info: number;
  requiresUserDecision: boolean;
  codes: string[];
  truncated: boolean;
}

export type LoopContinuationDisposition = 'continue' | 'await-user' | 'blocked' | 'done';
export type LoopContinuationAction = 'work-phase' | 'advance-phase' | 'repair' | 'archive' | 'none';

export interface LoopContinuationInputOption {
  input: string;
  flags: string[];
  required: boolean;
  placeholder: string | null;
  choices?: string[];
  repeatable?: boolean;
  alterloopGroup?: string;
}

export interface LoopContinuation {
  schema: 'owner.loop.continuation.v1';
  skill: 'owner-loop';
  change: string;
  phase: LoopPhase;
  revision: number;
  disposition: LoopContinuationDisposition;
  action: LoopContinuationAction;
  command: string | null;
  /** Full executable plus argv template. Placeholders are explicit angle-bracket tokens. */
  commandArgs: string[] | null;
  requiresUserDecision: boolean;
  requiredInputs: string[];
  inputOptions: LoopContinuationInputOption[];
}

export interface LoopCheckpointArtifact {
  path: string;
  hash: string;
  size: number;
}

export interface LoopCheckpointManifest {
  schema: 'owner.loop.checkpoint-manifest.v1';
  change: string;
  artifacts: LoopCheckpointArtifact[];
  totalBytes: number;
}

export interface LoopProgressCheckpoint {
  schema: 'owner.loop.progress-checkpoint.v1';
  id: string;
  change: string;
  phase: LoopPhase;
  previousRevision: number;
  stateRevision: number;
  summary: string;
  nextAction: string;
  inputHash: string;
  manifestHash: string;
  manifestRef: string;
  artifactCount: number;
  createdAt: string;
}

export interface LoopCheckpointJournal {
  schema: 'owner.loop.checkpoint-journal.v1';
  id: string;
  change: string;
  inputHash: string;
  createdAt: string;
  previousState: LoopChangeState;
  nextState: LoopChangeState;
  checkpoint: LoopProgressCheckpoint;
  manifest: LoopCheckpointManifest;
}

export interface LoopCheckpointHooks {
  afterPrepared?: (journal: LoopCheckpointJournal) => void | Promise<void>;
  afterStateWritten?: (journal: LoopCheckpointJournal) => void | Promise<void>;
  afterProgressWritten?: (journal: LoopCheckpointJournal) => void | Promise<void>;
}

export interface LoopCheckpointResult {
  change: LoopChangeState;
  checkpoint: LoopProgressCheckpoint;
  idempotent: boolean;
  expectedRevision: number;
  previousRevision: number;
  revision: number;
  outcome: 'recorded' | 'idempotent';
  continuation: LoopContinuation;
}

export interface LoopCheckpointCompactView {
  id: string;
  createdAt: string;
  phase: LoopPhase;
  stateRevision: number;
  summary: string;
  nextAction: string;
  artifactCount: number;
}

export interface LoopCheckpointDetailView extends LoopCheckpointCompactView {
  manifestHash: string;
  manifestRef: string;
  artifacts: LoopCheckpointArtifact[];
  totalBytes: number;
}

export interface LoopInspectionView {
  freshness: 'fresh' | 'stale';
  codes: string[];
  reasonCount: number;
  codesTruncated: boolean;
}

export interface LoopInspectionDetailView extends LoopInspectionView {
  reasons: string[];
  reasonsTruncated: boolean;
}

export interface LoopArtifactValidation {
  valid: boolean;
  findings: LoopFinding[];
}

export interface LoopAdvanceEvidence {
  summary: string;
  returnToBuild?: boolean;
  confirmed?: boolean;
  artifacts?: string[];
  noCodeReason?: string;
  allowPartialScopeHash?: string;
  partialReason?: string;
  verificationResult?: 'pass' | 'fail';
  verificationReport?: string;
  repairOverrideSignature?: string;
  repairOverrideSummary?: string;
}

export interface LoopAcceptanceCriterionProjection {
  id: string;
  kind: 'brief-example' | 'spec-scenario' | 'spec-must';
  source: string;
  context: string[];
  text: string;
  contextTruncated: boolean;
  textTruncated: boolean;
  verificationStatus: 'satisfied' | 'failed' | 'missing' | 'unverified';
}

export interface LoopAcceptancePageProjection {
  schema: 'owner.loop.acceptance-page.v1';
  acceptanceHash: string;
  total: number;
  offset: number;
  items: LoopAcceptanceCriterionProjection[];
  failedAcceptanceIds: string[];
  missingAcceptanceIds: string[];
  failedCheckIds: string[];
  failedCheckIdsTruncated: boolean;
  nextCursor: string | null;
  nextPageCommand?: string | null;
  nextPageArgs?: string[] | null;
  limits: {
    maxItems: number;
    maxTextBytes: number;
    maxContextItems: number;
    maxContextItemBytes: number;
    maxFailedCheckIds: number;
    maxSerializedBytes: number;
  };
}

export interface LoopWorkspaceProjection {
  projectRoot: string;
  currentBranch: string | null;
  isSecondaryWorktree: boolean;
  bindingState: 'missing' | 'legacy' | 'aligned' | 'drifted' | 'invalid';
  isolation: 'current' | 'branch' | 'worktree' | null;
  changeBranch: string | null;
  targetBranch: string | null;
  finish: 'merge' | 'push' | 'pull-request' | 'keep' | null;
}

export interface LoopRepairDecisionProjection {
  disposition: 'continue' | 'warn' | 'manual-stop' | 'hard-stop';
  reasonCode:
    | 'new-failure-signature'
    | 'repeated-failure-warning'
    | 'repeated-failure-stop'
    | 'override-accepted'
    | 'override-already-used'
    | 'repair-iteration-limit';
  signatureHash: string;
  consecutiveFailures: number;
  totalRepairFailures: number;
  remainingIterations: number;
  overrideAccepted: boolean;
}

export interface LoopRepairStatusProjection {
  disposition: LoopRepairDecisionProjection['disposition'];
  signatureHash: string;
  overrideRecorded: boolean;
  failedAcceptanceIds: string[];
  failedCheckIds: string[];
  totalVerifyFailures: number;
  maxVerifyFailures: number;
  remainingVerifyFailures: number;
}

export interface LoopPreparedScopeProjection {
  scopeHash: string;
  scopeRef: LoopContentAddressedRef;
  complete: boolean;
  unresolvedScopeCount: number;
  partialAllowanceRef: LoopContentAddressedRef | null;
  acceptancePage: LoopAcceptancePageProjection;
}

export interface LoopAdvanceResult {
  change: LoopChangeState;
  previousPhase: LoopPhase;
  next: 'auto' | 'manual' | 'done';
  nextCommand: string | null;
  findings: LoopStructuredFinding[];
  continuation: LoopContinuation;
  preparedScope?: LoopPreparedScopeProjection;
  repair?: LoopRepairDecisionProjection;
}

interface LoopTransitionJournalFields<TState extends LoopReadableChangeState> {
  id: string;
  change: string;
  evidenceHash: string;
  createdAt: string;
  previousState: TState;
  nextState: TState;
  previousRun: RunState | null;
  nextRun: RunState;
  eventData: Record<string, unknown>;
}

export type LoopTransitionOperation =
  | 'advance'
  | 'spec-rebase'
  | 'evidence-retreat'
  | 'runtime-rebuild';

export interface LoopLegacyTransitionJournal extends LoopTransitionJournalFields<LoopLegacyChangeState> {
  schema: typeof LOOP_LEGACY_TRANSITION_SCHEMA;
}

export interface LoopV2TransitionJournal extends LoopTransitionJournalFields<LoopV2ChangeState> {
  schema: typeof LOOP_V2_TRANSITION_SCHEMA;
  minimum_runtime_version: 2;
  revision: number;
}

export interface LoopTransitionJournal extends LoopTransitionJournalFields<LoopChangeState> {
  schema: typeof LOOP_TRANSITION_SCHEMA;
  minimum_runtime_version: typeof LOOP_RUNTIME_PROTOCOL_VERSION;
  revision: number;
  operation: LoopTransitionOperation;
}

export type LoopTransitionSchemaInspection =
  | { status: 'current'; journal: LoopTransitionJournal }
  | {
      status: 'migration-required';
      journal: LoopLegacyTransitionJournal | LoopV2TransitionJournal;
    };

export interface LoopTransitionHooks {
  afterPrepared?: (journal: LoopTransitionJournal) => void | Promise<void>;
  afterRunStateWritten?: (journal: LoopTransitionJournal) => void | Promise<void>;
  afterChangeStateWritten?: (journal: LoopTransitionJournal) => void | Promise<void>;
}

export interface LoopStatusProjection {
  name: string;
  phase: LoopPhase | 'invalid';
  revision: number | null;
  approval: LoopApproval;
  verificationResult: LoopVerificationResult;
  specChanges: number;
  selected: boolean;
  nextCommand: string | null;
  archiveReady: boolean;
  inspection: LoopInspectionView;
  findingSummary: LoopFindingSummary;
  detailsCommand: string | null;
  checkpoint: LoopCheckpointCompactView | null;
  continuation: LoopContinuation | null;
  workspace: LoopWorkspaceProjection;
  runtime: {
    status: 'available' | 'missing' | 'invalid';
    layout: 'project-local' | 'legacy' | 'missing';
    path: string;
    message?: string;
  };
  repair?: LoopRepairStatusProjection | null;
  acceptancePage?: LoopAcceptancePageProjection;
  findings?: LoopStructuredFinding[];
  inspectionDetails?: LoopInspectionDetailView;
  checkpointDetails?: LoopCheckpointDetailView | null;
  budgets?: {
    maxFindings: number;
    maxInspectionReasons: number;
    maxCheckpointArtifacts: number;
    findingsTruncated: boolean;
    inspectionReasonsTruncated: boolean;
    checkpointArtifactsTruncated: boolean;
  };
  schema?: string;
  migrationRequired?: boolean;
  minimumRuntimeVersion?: number | null;
  error?: string;
}

export interface LoopStatusPageProjection {
  schema: 'owner.loop.status-page.v1';
  total: number;
  offset: number;
  items: LoopStatusProjection[];
  nextCursor: string | null;
  nextPageCommand: string | null;
  nextPageArgs: string[] | null;
  limits: {
    maxItems: number;
    maxChanges: number;
    maxSerializedBytes: number;
  };
}

export interface LoopDoctorFinding {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  path?: string;
  repair?: 'continue' | 'rollback' | 'migrate' | 'truncate-tail';
}

export interface LoopSchemaMigrationJournal {
  schema: 'owner.loop.schema-migration.v1';
  id: string;
  change: string;
  fromSchema: typeof LOOP_LEGACY_CHANGE_SCHEMA | typeof LOOP_V2_CHANGE_SCHEMA;
  toSchema: typeof LOOP_V2_CHANGE_SCHEMA | typeof LOOP_CHANGE_SCHEMA;
  sourceHash: string;
  targetHash: string;
  createdAt: string;
  nextState: LoopV2ChangeState | LoopChangeState;
  transition?: {
    sourceHash: string;
    targetHash: string;
    nextJournal: LoopV2TransitionJournal | LoopTransitionJournal;
  };
  transitionSupersede?: {
    sourceHash: string;
    transitionId: string;
    previousRun: RunState;
    nextRun: RunState;
    evidenceHash: string;
    eventData: Record<string, unknown>;
  };
  runRetreat?: {
    previousRun: RunState;
    nextRun: RunState;
    evidenceHash: string;
    eventData: Record<string, unknown>;
  };
}

export interface LoopSchemaMigrationHooks {
  afterPrepared?: (journal: LoopSchemaMigrationJournal) => void | Promise<void>;
  afterStateWritten?: (journal: LoopSchemaMigrationJournal) => void | Promise<void>;
  afterTransitionWritten?: (journal: LoopSchemaMigrationJournal) => void | Promise<void>;
  afterTransitionSuperseded?: (journal: LoopSchemaMigrationJournal) => void | Promise<void>;
  afterRunStateWritten?: (journal: LoopSchemaMigrationJournal) => void | Promise<void>;
  afterTrajectoryWritten?: (journal: LoopSchemaMigrationJournal) => void | Promise<void>;
  afterCheckpointWritten?: (journal: LoopSchemaMigrationJournal) => void | Promise<void>;
}

export type LoopTransactionKind = 'archive' | 'root-move';
export type LoopTransactionStatus =
  | 'prepared'
  | 'applying'
  | 'committed'
  | 'rolling-back'
  | 'rolled-back';

export interface LoopTransactionOperation {
  id: string;
  type: 'write' | 'remove' | 'move';
  source?: string;
  target: string;
  staged?: string;
  backup?: string;
}

export interface LoopTransactionJournal {
  schema: 'owner.loop.transaction.v1';
  id: string;
  kind: LoopTransactionKind;
  status: LoopTransactionStatus;
  projectRoot: string;
  loopRoot: string;
  change?: string;
  createdAt: string;
  operations: LoopTransactionOperation[];
}

export interface LoopTransactionEvent {
  sequence: number;
  timestamp: string;
  type:
    | 'prepared'
    | 'operation-started'
    | 'operation-completed'
    | 'archive-finalization-started'
    | 'archive-finalized'
    | 'commit'
    | 'rollback-started'
    | 'rollback-completed';
  operationId?: string;
}

export interface LoopTransactionHooks {
  afterPrepared?: (journal: LoopTransactionJournal) => void | Promise<void>;
  afterOperation?: (
    operation: LoopTransactionOperation,
    completedCount: number,
  ) => void | Promise<void>;
  afterRootMoveStage?: (
    stage: LoopPendingRootMove['stage'],
    journal: LoopTransactionJournal,
  ) => void | Promise<void>;
  beforeRootMoveSourceRemove?: (sourceRoot: string) => void | Promise<void>;
  afterRootMoveSourceQuarantined?: (quarantine: string) => void | Promise<void>;
  afterRootMoveCleanupEntryRemoved?: (
    kind: LoopRootMoveCleanupKind,
    ref: string,
    removedCount: number,
  ) => void | Promise<void>;
}
import type { RunState } from '../engine/types.js';
