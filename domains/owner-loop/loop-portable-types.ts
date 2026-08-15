export const LOOP_PORTABLE_STATE_SCHEMA = 'owner.loop.v4' as const;
export const LOOP_LOCAL_EXECUTION_SCHEMA = 'owner.loop.local-execution.v4' as const;
export const LOOP_PORTABLE_HISTORY_LIMIT = 50 as const;

export type LoopPortablePhase = 'shape' | 'build' | 'verify' | 'archive';
export type LoopPortableStatus = 'active' | 'await-user' | 'blocked' | 'done';
export type LoopPortableVerificationResult = 'pending' | 'pass' | 'fail' | 'blocked';
export type LoopPortableVerificationAssurance =
  | 'host-attested'
  | 'skill-coordinated'
  | 'semantic-verification-unavailable'
  | 'user-confirmed-degraded';
export type LoopPortableAcceptanceResult = 'pending' | 'passed' | 'failed' | 'blocked';
export type LoopPortableHistoryOutcome =
  | 'pass'
  | 'fail'
  | 'blocked'
  | 'execution-error'
  | 'recovery';

export interface LoopPortableText {
  text: string;
  truncated: boolean;
}

export interface LoopPortableSpecChange {
  capability: string;
  operation: 'create' | 'modify' | 'remove';
  source: string | null;
}

export interface LoopPortableWorkspace {
  isolation: 'current' | 'branch' | 'worktree';
  change_branch: string | null;
  target_branch: string | null;
  finish: 'merge' | 'push' | 'pull-request' | 'keep' | null;
}

export interface LoopPortableLoopState {
  stage:
    | 'shape'
    | 'building'
    | 'verify-ready'
    | 'repairing'
    | 'archive-ready'
    | 'await-user'
    | 'blocked'
    | 'done';
  goal_cycle: number;
  iteration: number;
  attempt: number;
  retry_epoch: number;
  failed_iteration_count: number;
  no_progress_count: number;
  execution_failure_count: number;
  previous_unresolved_ids: string[];
  next_action: string | null;
}

export interface LoopPortableAcceptanceState {
  id: string;
  source: string;
  text: string;
  result: LoopPortableAcceptanceResult;
  reason: LoopPortableText | null;
}

export interface LoopBuilderCheckSummary {
  name: LoopPortableText;
  result: 'passed' | 'failed' | 'not-run';
  note: LoopPortableText | null;
}

export interface LoopBuilderHandoff {
  candidate_id: string;
  identity_provider: string;
  builder_execution_ref: string;
  iteration: number;
  summary: LoopPortableText;
  addressed_acceptance_ids: string[];
  checks: LoopBuilderCheckSummary[];
  checks_truncated: boolean;
  known_limits: LoopPortableText[];
  known_limits_truncated: boolean;
  submitted_at: string;
}

export interface LoopPortableBlockerState {
  owner: 'builder' | 'runtime' | 'verifier' | 'user' | 'external';
  reason: LoopPortableText;
  acceptance_ids: string[];
  resolution_action:
    | 'return-build'
    | 'retry-verifier'
    | 'resolve-verifier-blocker'
    | 'confirm-verifier-unavailable'
    | 'await-user'
    | 'wait-external';
}

export interface LoopPortableCheckSummary {
  id: string;
  name: LoopPortableText;
  argv_display: LoopPortableText[];
  argv_truncated: boolean;
  cwd_ref: string;
  status: 'passed' | 'failed' | 'interrupted';
  exit_code: number | null;
  duration_ms: number;
}

export interface LoopPortableVerificationState {
  candidate_id: string;
  identity_provider: string;
  verifier_execution_ref: string;
  iteration: number;
  attempt: number;
  assurance: LoopPortableVerificationAssurance;
  verdict: 'pass' | 'fail' | 'blocked';
  checks: LoopPortableCheckSummary[];
  summary: LoopPortableText;
  risks: LoopPortableText[];
  risks_truncated: boolean;
  completed_at: string;
}

export interface LoopPortableHistoryEntry {
  goal_cycle: number;
  iteration: number;
  attempt: number;
  outcome: LoopPortableHistoryOutcome;
  unresolved_ids: string[];
  summary: LoopPortableText;
  completed_at: string;
}

export interface LoopPortableHistoryOverflow {
  dropped_entries: number;
  first_dropped_at: string | null;
  last_dropped_at: string | null;
  outcome_counts: Record<LoopPortableHistoryOutcome, number>;
}

export interface LoopPortableState {
  schema: typeof LOOP_PORTABLE_STATE_SCHEMA;
  name: string;
  language: 'en' | 'zh-CN';
  phase: LoopPortablePhase;
  status: LoopPortableStatus;
  state_version: number;
  brief: 'brief.md';
  children_contract_hash?: string;
  spec_changes: LoopPortableSpecChange[];
  workspace: LoopPortableWorkspace;
  loop: LoopPortableLoopState;
  acceptance: LoopPortableAcceptanceState[];
  builder_handoff: LoopBuilderHandoff | null;
  blockers: LoopPortableBlockerState[];
  verification: LoopPortableVerificationState | null;
  history: LoopPortableHistoryEntry[];
  history_overflow: LoopPortableHistoryOverflow;
  verification_result: LoopPortableVerificationResult;
  verification_report: 'verification.md' | null;
  archived: boolean;
  created_at: string;
}

export interface LoopLocalExecutionState {
  schema: typeof LOOP_LOCAL_EXECUTION_SCHEMA;
  change: string;
  basedOnStateVersion: number;
  workspace: {
    projectRoot: string;
    worktreeRoot: string;
    branch: string | null;
  };
  execution: null | {
    operationId: string;
    stage: 'building' | 'checking' | 'verifying' | 'archiving';
    actor: 'builder' | 'runtime' | 'verifier' | null;
    executionId: string | null;
    status: 'running' | 'completed' | 'interrupted';
    startedAt: string;
    requestCheckRounds: number;
  };
  checks: LoopLocalCheckState[];
}

export interface LoopLocalCheckState {
  id: string;
  name: string;
  operationId: string;
  status: 'planned' | 'running' | 'passed' | 'failed' | 'interrupted';
  repeatable: boolean;
  timeoutMs: number;
  executionCount: number;
  argv: string[];
  cwd: string;
  exitCode: number | null;
  startedAt: string | null;
  completedAt: string | null;
  log: string;
}

export function emptyLoopPortableHistoryOverflow(): LoopPortableHistoryOverflow {
  return {
    dropped_entries: 0,
    first_dropped_at: null,
    last_dropped_at: null,
    outcome_counts: {
      pass: 0,
      fail: 0,
      blocked: 0,
      'execution-error': 0,
      recovery: 0,
    },
  };
}
