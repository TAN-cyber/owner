import path from 'node:path';

import {
  parseLegacyLoopChangeValue,
  parseLoopChangeValue,
  parseV2LoopChangeValue,
} from './loop-change.js';
import {
  assertLoopPortableAcceptanceIds,
  type LoopPortableAcceptanceCriterion,
} from './loop-portable-acceptance.js';
import { parseLoopPortableState } from './loop-portable-state.js';
import { toLoopPortableText } from './loop-portable-text.js';
import {
  emptyLoopPortableHistoryOverflow,
  LOOP_PORTABLE_STATE_SCHEMA,
  type LoopPortablePhase,
  type LoopPortableSpecChange,
  type LoopPortableState,
  type LoopPortableWorkspace,
} from './loop-portable-types.js';
import {
  LOOP_CHANGE_SCHEMA,
  LOOP_LEGACY_CHANGE_SCHEMA,
  LOOP_V2_CHANGE_SCHEMA,
  type LoopReadableChangeState,
} from './loop-types.js';

export const LOOP_PORTABLE_MIGRATION_TRANSACTION_SCHEMA =
  'owner.loop.portable-migration.v1' as const;

export type LoopPortableMigrationTransactionStatus =
  | 'prepared'
  | 'yaml-committed'
  | 'legacy-cleanup'
  | 'committed';

export interface LoopPortableMigrationTransaction {
  schema: typeof LOOP_PORTABLE_MIGRATION_TRANSACTION_SCHEMA;
  id: string;
  change: string;
  fromSchema:
    | typeof LOOP_LEGACY_CHANGE_SCHEMA
    | typeof LOOP_V2_CHANGE_SCHEMA
    | typeof LOOP_CHANGE_SCHEMA;
  status: LoopPortableMigrationTransactionStatus;
  createdAt: string;
}

export type LoopPortableMigrationAction =
  | 'commit-portable-yaml'
  | 'cleanup-legacy-runtime'
  | 'commit-transaction'
  | 'done';

export interface LoopPortableMigrationNextStep {
  action: LoopPortableMigrationAction;
  fromStatus: LoopPortableMigrationTransactionStatus;
  nextStatus: LoopPortableMigrationTransactionStatus | null;
}

const TRANSACTION_KEYS = new Set(['schema', 'id', 'change', 'fromSchema', 'status', 'createdAt']);
const CHANGE_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const TRANSACTION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{7,127}$/u;
const TRANSACTION_STATUSES = new Set<LoopPortableMigrationTransactionStatus>([
  'prepared',
  'yaml-committed',
  'legacy-cleanup',
  'committed',
]);
const LEGACY_SCHEMAS = new Set<LoopPortableMigrationTransaction['fromSchema']>([
  LOOP_LEGACY_CHANGE_SCHEMA,
  LOOP_V2_CHANGE_SCHEMA,
  LOOP_CHANGE_SCHEMA,
]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function canonicalTimestamp(value: string | Date, label: string): string {
  const parsed = value instanceof Date ? new Date(value.valueOf()) : new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new Error(`${label} must be a valid timestamp`);
  return parsed.toISOString();
}

function parseCanonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be an ISO timestamp`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return value;
}

function parseLegacyState(state: LoopReadableChangeState): LoopReadableChangeState {
  if (state.schema === LOOP_LEGACY_CHANGE_SCHEMA) {
    return parseLegacyLoopChangeValue(state);
  }
  if (state.schema === LOOP_V2_CHANGE_SCHEMA) return parseV2LoopChangeValue(state);
  return parseLoopChangeValue(state);
}

function portableSpecSource(source: string): string {
  return path.posix.normalize(source.replaceAll('\\', '/'));
}

function migrateSpecChanges(state: LoopReadableChangeState): LoopPortableSpecChange[] {
  return state.spec_changes.map((change) => {
    if (change.operation === 'remove') {
      return { capability: change.capability, operation: 'remove', source: null };
    }
    return {
      capability: change.capability,
      operation: change.operation === 'replace' ? 'modify' : 'create',
      source: portableSpecSource(change.source!),
    };
  });
}

function targetPhase(legacyPhase: LoopPortablePhase): 'shape' | 'build' {
  return legacyPhase === 'shape' ? 'shape' : 'build';
}

function nextAction(language: LoopPortableState['language'], phase: 'shape' | 'build'): string {
  if (language === 'zh-CN') {
    return phase === 'shape' ? '继续澄清并确认验收项' : '重新提交候选实现';
  }
  return phase === 'shape'
    ? 'Continue clarification and confirm acceptance'
    : 'Submit a fresh implementation candidate';
}

function recoverySummary(
  language: LoopPortableState['language'],
  schema: LoopReadableChangeState['schema'],
  phase: LoopPortablePhase,
): string {
  if (language === 'zh-CN') {
    return `从旧版 ${schema} ${phase} 状态恢复；旧版 Loop、验证结论和运行记录未继承。`;
  }
  return `Recovered from legacy ${schema} ${phase} state; prior Loop, verification results, and execution records were not inherited.`;
}

/**
 * Convert a parsed v1/v2/v3 change into the portable v4 stable boundary.
 *
 * This function intentionally has no Runtime input. Missing trajectory, Run,
 * checkpoint, snapshot, evidence, or per-change Runtime files cannot alter the
 * result. A caller may supply the migration time; otherwise the legacy creation
 * date is used as a deterministic recovery timestamp.
 */
export function migrateLoopLegacyStateToPortable(options: {
  state: LoopReadableChangeState;
  acceptance: readonly LoopPortableAcceptanceCriterion[];
  workspace: LoopPortableWorkspace;
  migratedAt?: string | Date;
}): LoopPortableState {
  const legacy = parseLegacyState(options.state);
  assertLoopPortableAcceptanceIds(options.acceptance);

  const phase = targetPhase(legacy.phase);
  const iteration = phase === 'shape' ? 0 : 1;
  const recoveredAt = canonicalTimestamp(
    options.migratedAt ?? `${legacy.created_at}T00:00:00.000Z`,
    'Loop portable migration time',
  );
  const acceptance = options.acceptance.map((criterion) => ({
    id: criterion.id,
    source: criterion.source,
    text: criterion.text,
    result: 'pending' as const,
    reason: null,
  }));

  return parseLoopPortableState({
    schema: LOOP_PORTABLE_STATE_SCHEMA,
    name: legacy.name,
    language: legacy.language,
    phase,
    status: 'active',
    state_version: 1,
    brief: 'brief.md',
    spec_changes: migrateSpecChanges(legacy),
    workspace: options.workspace,
    loop: {
      stage: phase === 'shape' ? 'shape' : 'building',
      goal_cycle: 1,
      iteration,
      attempt: 0,
      retry_epoch: 0,
      failed_iteration_count: 0,
      no_progress_count: 0,
      execution_failure_count: 0,
      previous_unresolved_ids: [],
      next_action: nextAction(legacy.language, phase),
    },
    acceptance,
    builder_handoff: null,
    blockers: [],
    verification: null,
    history: [
      {
        goal_cycle: 1,
        iteration,
        attempt: 0,
        outcome: 'recovery',
        unresolved_ids: acceptance.map(({ id }) => id),
        summary: toLoopPortableText(recoverySummary(legacy.language, legacy.schema, legacy.phase)),
        completed_at: recoveredAt,
      },
    ],
    history_overflow: emptyLoopPortableHistoryOverflow(),
    verification_result: 'pending',
    verification_report: null,
    archived: false,
    created_at: `${legacy.created_at}T00:00:00.000Z`,
  });
}

export function parseLoopPortableMigrationTransaction(
  value: unknown,
): LoopPortableMigrationTransaction {
  const root = record(value, 'Loop portable migration transaction');
  const unknown = Object.keys(root).filter((key) => !TRANSACTION_KEYS.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `Loop portable migration transaction has unknown field(s): ${unknown.join(', ')}`,
    );
  }
  if (root.schema !== LOOP_PORTABLE_MIGRATION_TRANSACTION_SCHEMA) {
    throw new Error('Unsupported Loop portable migration transaction schema');
  }
  if (typeof root.id !== 'string' || !TRANSACTION_ID_PATTERN.test(root.id)) {
    throw new Error('Loop portable migration transaction id is invalid');
  }
  if (typeof root.change !== 'string' || !CHANGE_NAME_PATTERN.test(root.change)) {
    throw new Error('Loop portable migration transaction change is invalid');
  }
  if (
    typeof root.fromSchema !== 'string' ||
    !LEGACY_SCHEMAS.has(root.fromSchema as LoopPortableMigrationTransaction['fromSchema'])
  ) {
    throw new Error('Loop portable migration transaction fromSchema is invalid');
  }
  if (
    typeof root.status !== 'string' ||
    !TRANSACTION_STATUSES.has(root.status as LoopPortableMigrationTransactionStatus)
  ) {
    throw new Error('Loop portable migration transaction status is invalid');
  }

  return {
    schema: LOOP_PORTABLE_MIGRATION_TRANSACTION_SCHEMA,
    id: root.id,
    change: root.change,
    fromSchema: root.fromSchema as LoopPortableMigrationTransaction['fromSchema'],
    status: root.status as LoopPortableMigrationTransactionStatus,
    createdAt: parseCanonicalTimestamp(
      root.createdAt,
      'Loop portable migration transaction createdAt',
    ),
  };
}

/**
 * Return the one replay-safe action for a persisted transaction boundary.
 * Repeated calls with the same journal return the same action and never mutate
 * the journal; the filesystem integration advances status only after the action
 * has reached its stable boundary.
 */
export function nextLoopPortableMigrationStep(
  value: LoopPortableMigrationTransaction,
): LoopPortableMigrationNextStep {
  const transaction = parseLoopPortableMigrationTransaction(value);
  switch (transaction.status) {
    case 'prepared':
      return {
        action: 'commit-portable-yaml',
        fromStatus: 'prepared',
        nextStatus: 'yaml-committed',
      };
    case 'yaml-committed':
      return {
        action: 'cleanup-legacy-runtime',
        fromStatus: 'yaml-committed',
        nextStatus: 'legacy-cleanup',
      };
    case 'legacy-cleanup':
      return {
        action: 'commit-transaction',
        fromStatus: 'legacy-cleanup',
        nextStatus: 'committed',
      };
    case 'committed':
      return { action: 'done', fromStatus: 'committed', nextStatus: null };
  }
}
