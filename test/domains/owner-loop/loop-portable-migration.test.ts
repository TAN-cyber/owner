import { describe, expect, it } from 'vitest';

import {
  migrateLoopLegacyStateToPortable,
  LOOP_PORTABLE_MIGRATION_TRANSACTION_SCHEMA,
  nextLoopPortableMigrationStep,
  parseLoopPortableMigrationTransaction,
  type LoopPortableMigrationTransaction,
  type LoopPortableMigrationTransactionStatus,
} from '../../../domains/owner-loop/loop-portable-migration.js';
import type { LoopPortableAcceptanceCriterion } from '../../../domains/owner-loop/loop-portable-acceptance.js';
import type { LoopPortableWorkspace } from '../../../domains/owner-loop/loop-portable-types.js';
import {
  LOOP_CHANGE_SCHEMA,
  LOOP_LEGACY_CHANGE_SCHEMA,
  LOOP_V2_CHANGE_SCHEMA,
  type LoopChangeState,
  type LoopLegacyChangeState,
  type LoopReadableChangeState,
  type LoopV2ChangeState,
} from '../../../domains/owner-loop/loop-types.js';

const HASH = 'a'.repeat(64);
const ACCEPTANCE: LoopPortableAcceptanceCriterion[] = [
  { id: 'A1', source: 'brief.md', text: 'The user can resume the change.' },
  {
    id: 'A2',
    source: 'specs/resume/spec.md',
    text: 'The migrated change starts from a stable boundary.',
  },
];
const WORKSPACE: LoopPortableWorkspace = {
  isolation: 'worktree',
  change_branch: 'beta17',
  target_branch: 'master',
  finish: 'pull-request',
};

function legacyFields(phase: LoopReadableChangeState['phase']) {
  return {
    name: 'portable-migration',
    language: 'en' as const,
    phase,
    brief: 'brief.md' as const,
    approval: 'confirmed' as const,
    spec_changes: [
      {
        capability: 'created-capability',
        operation: 'create' as const,
        source: 'specs\\created-capability\\spec.md',
        base_hash: null,
      },
      {
        capability: 'changed-capability',
        operation: 'replace' as const,
        source: 'specs/changed-capability/spec.md',
        base_hash: HASH,
      },
      {
        capability: 'removed-capability',
        operation: 'remove' as const,
        base_hash: HASH,
      },
    ],
    verification_result: 'pass' as const,
    verification_report: 'evidence.md',
    archived: phase === 'archive',
    created_at: '2026-08-01',
    run_id: 'legacy-run',
  };
}

function v1(phase: LoopReadableChangeState['phase']): LoopLegacyChangeState {
  return { schema: LOOP_LEGACY_CHANGE_SCHEMA, ...legacyFields(phase) };
}

function v2(phase: LoopReadableChangeState['phase']): LoopV2ChangeState {
  return {
    schema: LOOP_V2_CHANGE_SCHEMA,
    minimum_runtime_version: 2,
    revision: 7,
    ...legacyFields(phase),
  };
}

function v3(phase: LoopReadableChangeState['phase']): LoopChangeState {
  return {
    schema: LOOP_CHANGE_SCHEMA,
    minimum_runtime_version: 3,
    revision: 9,
    verification_protocol: 'legacy-v1',
    approved_contract_hash: HASH,
    implementation_scope: `runtime/evidence/scopes/${HASH}.json`,
    verification_evidence: `runtime/evidence/verifications/${HASH}.json`,
    partial_allowance: `runtime/evidence/allowances/${HASH}.json`,
    ...legacyFields(phase),
  };
}

describe('Loop legacy to portable migration', () => {
  it.each([
    ['Shape', v1('shape'), 'shape', 'shape', 0],
    ['Build', v2('build'), 'build', 'building', 1],
    ['Verify', v3('verify'), 'build', 'building', 1],
    ['Archive', v3('archive'), 'build', 'building', 1],
  ] as const)(
    'maps legacy %s to the conservative v4 stable boundary',
    (_label, state, phase, stage, iteration) => {
      const migrated = migrateLoopLegacyStateToPortable({
        state,
        acceptance: ACCEPTANCE,
        workspace: WORKSPACE,
        migratedAt: '2026-08-09T10:20:30.000Z',
      });

      expect(migrated).toMatchObject({
        schema: 'owner.loop.v4',
        phase,
        status: 'active',
        state_version: 1,
        loop: {
          stage,
          goal_cycle: 1,
          iteration,
          attempt: 0,
          retry_epoch: 0,
          failed_iteration_count: 0,
          no_progress_count: 0,
          execution_failure_count: 0,
          previous_unresolved_ids: [],
        },
        builder_handoff: null,
        blockers: [],
        verification: null,
        verification_result: 'pending',
        verification_report: null,
        archived: false,
      });
      expect(migrated.history).toEqual([
        expect.objectContaining({
          goal_cycle: 1,
          iteration,
          attempt: 0,
          outcome: 'recovery',
          unresolved_ids: ['A1', 'A2'],
          completed_at: '2026-08-09T10:20:30.000Z',
        }),
      ]);
    },
  );

  it('preserves formal inputs but drops hashes, pass, evidence, and Run state', () => {
    const options = {
      state: v3('archive'),
      acceptance: ACCEPTANCE,
      workspace: WORKSPACE,
      migratedAt: '2026-08-09T10:20:30.000Z',
    } as const;

    const migrated = migrateLoopLegacyStateToPortable(options);
    expect(migrateLoopLegacyStateToPortable(options)).toEqual(migrated);
    expect(migrated.created_at).toBe('2026-08-01T00:00:00.000Z');
    expect(migrated.workspace).toEqual(WORKSPACE);
    expect(migrated.spec_changes).toEqual([
      {
        capability: 'created-capability',
        operation: 'create',
        source: 'specs/created-capability/spec.md',
      },
      {
        capability: 'changed-capability',
        operation: 'modify',
        source: 'specs/changed-capability/spec.md',
      },
      { capability: 'removed-capability', operation: 'remove', source: null },
    ]);
    expect(migrated.acceptance).toEqual(
      ACCEPTANCE.map((criterion) => ({ ...criterion, result: 'pending', reason: null })),
    );
    expect(JSON.stringify(migrated)).not.toMatch(/hash|evidence|run_id|legacy-run/iu);
  });

  it('does not require legacy Runtime and uses a deterministic timestamp by default', () => {
    const options = { state: v1('shape'), acceptance: ACCEPTANCE, workspace: WORKSPACE };
    const first = migrateLoopLegacyStateToPortable(options);
    const second = migrateLoopLegacyStateToPortable(options);

    expect(first).toEqual(second);
    expect(first.history[0].completed_at).toBe('2026-08-01T00:00:00.000Z');
  });

  it('rejects acceptance and workspace data that cannot form portable state', () => {
    expect(() =>
      migrateLoopLegacyStateToPortable({
        state: v1('shape'),
        acceptance: [{ ...ACCEPTANCE[0], id: 'A2' }],
        workspace: WORKSPACE,
      }),
    ).toThrow(/contiguous sequence/iu);

    expect(() =>
      migrateLoopLegacyStateToPortable({
        state: v1('shape'),
        acceptance: ACCEPTANCE,
        workspace: { ...WORKSPACE, change_branch: null },
      }),
    ).toThrow(/requires change_branch and target_branch/iu);
  });
});

describe('Loop portable migration transaction', () => {
  const base: LoopPortableMigrationTransaction = {
    schema: LOOP_PORTABLE_MIGRATION_TRANSACTION_SCHEMA,
    id: 'migration-0001',
    change: 'portable-migration',
    fromSchema: LOOP_CHANGE_SCHEMA,
    status: 'prepared',
    createdAt: '2026-08-09T10:20:30.000Z',
  };

  it.each([
    ['prepared', 'commit-portable-yaml', 'yaml-committed'],
    ['yaml-committed', 'cleanup-legacy-runtime', 'legacy-cleanup'],
    ['legacy-cleanup', 'commit-transaction', 'committed'],
    ['committed', 'done', null],
  ] as const)('returns the idempotent next step for %s', (status, action, nextStatus) => {
    const transaction = parseLoopPortableMigrationTransaction({ ...base, status });
    const first = nextLoopPortableMigrationStep(transaction);
    const second = nextLoopPortableMigrationStep(transaction);

    expect(first).toEqual({ action, fromStatus: status, nextStatus });
    expect(second).toEqual(first);
    expect(transaction.status).toBe(status);
  });

  it('strictly parses transaction state', () => {
    for (const status of [
      'prepared',
      'yaml-committed',
      'legacy-cleanup',
      'committed',
    ] satisfies LoopPortableMigrationTransactionStatus[]) {
      expect(parseLoopPortableMigrationTransaction({ ...base, status })).toEqual({
        ...base,
        status,
      });
    }

    expect(() => parseLoopPortableMigrationTransaction({ ...base, status: 'applying' })).toThrow(
      /status is invalid/iu,
    );
    expect(() =>
      parseLoopPortableMigrationTransaction({ ...base, createdAt: '2026-08-09' }),
    ).toThrow(/canonical ISO timestamp/iu);
    expect(() => parseLoopPortableMigrationTransaction({ ...base, sourceHash: HASH })).toThrow(
      /unknown field.*sourceHash/iu,
    );
  });
});
