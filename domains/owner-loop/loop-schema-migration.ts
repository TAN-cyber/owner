import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { isDeepStrictEqual } from 'util';
import { stringify } from 'yaml';

import type { RunState } from '../engine/types.js';
import { atomicWriteJson, atomicWriteText } from './loop-atomic-file.js';
import {
  hasPendingLoopCheckpointRecovery,
  inspectLoopChange,
  LoopBaselineIncompleteError,
  LOOP_CHANGE_STATE_FILE,
  loopChangeDir,
  loopChangeDocument,
  loopV2ChangeDocument,
  parseLoopChangeValue,
  parseV2LoopChangeValue,
} from './loop-change.js';
import { sha256File, sha256Text } from './loop-hash.js';
import { withLoopMutationLock } from './loop-mutation-lock.js';
import { loopChangeRuntimeDir, loopStorageRoot, resolveContainedLoopPath } from './loop-paths.js';
import { readLoopProtectedTextFile } from './loop-protected-file.js';
import { LOOP_RUNTIME_HASH, LOOP_RUNTIME_PACKAGE } from './loop-runtime-package.js';
import {
  parseLoopStoredRunStateValue,
  readLoopCheckpoint,
  readLoopRunState,
  readLoopTrajectory,
  writeLoopRunState,
} from './loop-run-store.js';
import {
  createLoopContentSnapshot,
  filterLoopContentSnapshotToProjectScope,
  inspectLoopContentSnapshotHealth,
  readLoopBaselineManifest,
  writeLoopBaselineManifest,
} from './loop-snapshot.js';
import { appendLoopTrajectoryEvent, writeLoopCheckpoint } from './loop-trajectory.js';
import {
  inspectPendingLoopTransitionSchema,
  loopTransitionJournalFile,
  parseLoopTransitionJournalValue,
  parseV2LoopTransitionJournalValue,
  withLoopTransitionLock,
} from './loop-transition-journal.js';
import type {
  LoopChangeState,
  LoopLegacyChangeState,
  LoopLegacyTransitionJournal,
  LoopProjectPaths,
  LoopReadableChangeState,
  LoopSchemaMigrationHooks,
  LoopSchemaMigrationJournal,
  LoopTransitionJournal,
  LoopV2ChangeState,
  LoopV2TransitionJournal,
} from './loop-types.js';
import {
  LOOP_CHANGE_SCHEMA,
  LOOP_LEGACY_CHANGE_SCHEMA,
  LOOP_LEGACY_TRANSITION_SCHEMA,
  LOOP_RUNTIME_PROTOCOL_VERSION,
  LOOP_TRANSITION_SCHEMA,
  LOOP_V2_CHANGE_SCHEMA,
  LOOP_V2_TRANSITION_SCHEMA,
} from './loop-types.js';

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const MIGRATION_JOURNAL_KEYS = new Set([
  'schema',
  'id',
  'change',
  'fromSchema',
  'toSchema',
  'sourceHash',
  'targetHash',
  'createdAt',
  'nextState',
  'transition',
  'transitionSupersede',
  'runRetreat',
]);
const MIGRATION_TRANSITION_KEYS = new Set(['sourceHash', 'targetHash', 'nextJournal']);
const MIGRATION_TRANSITION_SUPERSEDE_KEYS = new Set([
  'sourceHash',
  'transitionId',
  'previousRun',
  'nextRun',
  'evidenceHash',
  'eventData',
]);
const MIGRATION_SUPERSEDE_EVENT_KEYS = new Set([
  'fromSchema',
  'toSchema',
  'previousPhase',
  'nextPhase',
  'reason',
  'supersededTransitionId',
]);
const MIGRATION_RUN_RETREAT_KEYS = new Set(['previousRun', 'nextRun', 'evidenceHash', 'eventData']);

function rejectUnknownFields(
  value: Record<string, unknown>,
  keys: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !keys.has(key));
  if (unknown) throw new Error(`${label} contains unknown field: ${unknown}`);
}

function transitionContent(journal: LoopV2TransitionJournal | LoopTransitionJournal): string {
  return JSON.stringify(journal, null, 2) + '\n';
}

function migrationStateDocument(
  state: LoopV2ChangeState | LoopChangeState,
): Record<string, unknown> {
  return state.schema === LOOP_V2_CHANGE_SCHEMA
    ? loopV2ChangeDocument(state)
    : loopChangeDocument(state);
}

function upgradeV1StateToV2(state: LoopLegacyChangeState, revision: number): LoopV2ChangeState {
  return {
    ...state,
    schema: LOOP_V2_CHANGE_SCHEMA,
    minimum_runtime_version: 2,
    revision,
  };
}

function upgradeV1TransitionToV2(journal: LoopLegacyTransitionJournal): LoopV2TransitionJournal {
  return {
    ...journal,
    schema: LOOP_V2_TRANSITION_SCHEMA,
    minimum_runtime_version: 2,
    revision: 1,
    previousState: upgradeV1StateToV2(journal.previousState, 1),
    nextState: upgradeV1StateToV2(journal.nextState, 2),
  };
}

function upgradeV2StateToV3(
  state: LoopV2ChangeState,
  options?: { retreatEvidencePhase?: boolean; incrementRetreatRevision?: boolean },
): LoopChangeState {
  const retreat =
    options?.retreatEvidencePhase === true &&
    (state.phase === 'verify' || state.phase === 'archive');
  return {
    ...state,
    schema: LOOP_CHANGE_SCHEMA,
    minimum_runtime_version: LOOP_RUNTIME_PROTOCOL_VERSION,
    verification_protocol: 'legacy-v1',
    revision: state.revision + (retreat && options?.incrementRetreatRevision ? 1 : 0),
    phase: retreat ? 'build' : state.phase,
    verification_result: retreat ? 'pending' : state.verification_result,
    verification_report: retreat ? null : state.verification_report,
    approved_contract_hash: null,
    implementation_scope: null,
    verification_evidence: null,
    partial_allowance: null,
    archived: retreat ? false : state.archived,
  };
}

function upgradeV2TransitionToV3(journal: LoopV2TransitionJournal): LoopTransitionJournal {
  if (journal.nextState.phase === 'archive') {
    throw new Error('Loop v2 Archive transition must be superseded by schema migration');
  }
  const specRebase =
    journal.previousState.phase !== 'shape' &&
    journal.nextState.phase === 'build' &&
    journal.eventData.verificationResult === null;
  const evidenceHash = specRebase
    ? sha256Text(
        JSON.stringify({
          operation: 'spec-rebase',
          change: journal.change,
          summary: journal.eventData.summary,
          specChanges: journal.nextState.spec_changes,
        }),
      )
    : journal.evidenceHash;
  return {
    ...journal,
    schema: LOOP_TRANSITION_SCHEMA,
    minimum_runtime_version: LOOP_RUNTIME_PROTOCOL_VERSION,
    revision: 1,
    operation: specRebase ? 'spec-rebase' : 'advance',
    evidenceHash,
    previousState: upgradeV2StateToV3(journal.previousState),
    nextState: {
      ...upgradeV2StateToV3(journal.nextState),
      ...(specRebase
        ? {
            implementation_scope: null,
            verification_evidence: null,
            partial_allowance: null,
          }
        : {}),
    },
    eventData: { ...journal.eventData, evidenceHash },
    nextRun:
      journal.previousRun === null
        ? {
            ...journal.nextRun,
            skillVersion: LOOP_RUNTIME_PACKAGE.definition.metadata.version,
            skillHash: LOOP_RUNTIME_HASH,
          }
        : journal.nextRun,
  };
}

function sameV1State(left: LoopLegacyChangeState, right: LoopLegacyChangeState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameV2State(left: LoopV2ChangeState, right: LoopV2ChangeState): boolean {
  return JSON.stringify(loopV2ChangeDocument(left)) === JSON.stringify(loopV2ChangeDocument(right));
}

function sameCurrentState(left: LoopChangeState, right: LoopChangeState): boolean {
  return JSON.stringify(loopChangeDocument(left)) === JSON.stringify(loopChangeDocument(right));
}

function sameRunState(left: RunState, right: RunState): boolean {
  return isDeepStrictEqual(left, right);
}

function parseTransitionSupersede(
  value: unknown,
  expectedName: string,
  nextState: LoopChangeState,
  migrationId: string,
): NonNullable<LoopSchemaMigrationJournal['transitionSupersede']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Schema migration transition supersede plan is invalid');
  }
  const record = value as Record<string, unknown>;
  rejectUnknownFields(
    record,
    MIGRATION_TRANSITION_SUPERSEDE_KEYS,
    'Schema migration transition supersede plan',
  );
  if (typeof record.sourceHash !== 'string' || !HASH_PATTERN.test(record.sourceHash)) {
    throw new Error('Schema migration transition supersede source hash is invalid');
  }
  if (typeof record.transitionId !== 'string' || record.transitionId.length === 0) {
    throw new Error('Schema migration superseded transition id is invalid');
  }
  if (typeof record.evidenceHash !== 'string' || !HASH_PATTERN.test(record.evidenceHash)) {
    throw new Error('Schema migration transition supersede evidence hash is invalid');
  }
  const previousRun = parseLoopStoredRunStateValue(record.previousRun);
  const nextRun = parseLoopStoredRunStateValue(record.nextRun);
  if (
    previousRun.runId !== nextRun.runId ||
    nextState.run_id !== nextRun.runId ||
    (nextState.phase !== 'build' && nextState.phase !== 'verify') ||
    nextRun.currentStep !== nextState.phase ||
    nextRun.pending !== null ||
    nextRun.status !== 'running' ||
    nextState.verification_result !== 'pending' ||
    nextState.verification_report !== null ||
    nextState.implementation_scope !== null ||
    nextState.verification_evidence !== null ||
    nextState.partial_allowance !== null
  ) {
    throw new Error('Schema migration transition supersede Run does not match target state');
  }
  const retreatAllowed =
    (previousRun.currentStep === 'verify' && nextState.phase === 'build') ||
    (previousRun.currentStep === 'archive' && nextState.phase === 'build');
  const expectedNextRun =
    previousRun.currentStep === nextState.phase
      ? previousRun
      : retreatAllowed
        ? {
            ...previousRun,
            currentStep: nextState.phase,
            iteration: previousRun.iteration + 1,
            pending: null,
            status: 'running' as const,
          }
        : null;
  if (!expectedNextRun || !sameRunState(expectedNextRun, nextRun)) {
    throw new Error('Schema migration transition supersede Run retreat is invalid');
  }
  if (
    !record.eventData ||
    typeof record.eventData !== 'object' ||
    Array.isArray(record.eventData)
  ) {
    throw new Error('Schema migration transition supersede event is invalid');
  }
  const eventData = record.eventData as Record<string, unknown>;
  const eventKeys = Object.keys(eventData);
  if (
    eventKeys.length !== MIGRATION_SUPERSEDE_EVENT_KEYS.size ||
    eventKeys.some((key) => !MIGRATION_SUPERSEDE_EVENT_KEYS.has(key)) ||
    eventData.fromSchema !== LOOP_V2_CHANGE_SCHEMA ||
    eventData.toSchema !== LOOP_CHANGE_SCHEMA ||
    !['build', 'verify', 'archive'].includes(eventData.previousPhase as string) ||
    eventData.nextPhase !== nextState.phase ||
    eventData.reason !==
      (nextState.phase === 'build'
        ? 'implementation-scope-required'
        : 'verification-evidence-required') ||
    eventData.supersededTransitionId !== record.transitionId
  ) {
    throw new Error('Schema migration transition supersede event semantics are invalid');
  }
  if (nextState.name !== expectedName) {
    throw new Error('Schema migration transition supersede change mismatch');
  }
  const expectedEvidenceHash = sha256Text(
    JSON.stringify({
      operation: 'supersede-v2-evidence-transition',
      change: expectedName,
      transitionId: record.transitionId,
      migrationId,
      previousPhase: eventData.previousPhase,
      nextPhase: eventData.nextPhase,
      reason: eventData.reason,
      previousIteration: previousRun.iteration,
      nextRevision: nextState.revision,
    }),
  );
  if (record.evidenceHash !== expectedEvidenceHash) {
    throw new Error('Schema migration transition supersede evidence hash mismatch');
  }
  return {
    sourceHash: record.sourceHash,
    transitionId: record.transitionId,
    previousRun,
    nextRun,
    evidenceHash: record.evidenceHash,
    eventData,
  };
}

export function loopSchemaMigrationJournalFile(paths: LoopProjectPaths, name: string): string {
  return path.join(loopChangeRuntimeDir(paths, name), 'schema-migration.json');
}

function parseMigrationJournal(value: unknown, expectedName: string): LoopSchemaMigrationJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Loop schema migration journal must be an object');
  }
  rejectUnknownFields(
    value as Record<string, unknown>,
    MIGRATION_JOURNAL_KEYS,
    'Loop schema migration journal',
  );
  const journal = value as Partial<LoopSchemaMigrationJournal>;
  if (journal.schema !== 'owner.loop.schema-migration.v1') {
    throw new Error('Unsupported Loop schema migration journal');
  }
  if (journal.change !== expectedName) throw new Error('Schema migration change mismatch');
  const v1ToV2 =
    journal.fromSchema === LOOP_LEGACY_CHANGE_SCHEMA && journal.toSchema === LOOP_V2_CHANGE_SCHEMA;
  const v2ToV3 =
    journal.fromSchema === LOOP_V2_CHANGE_SCHEMA && journal.toSchema === LOOP_CHANGE_SCHEMA;
  if (!v1ToV2 && !v2ToV3) throw new Error('Schema migration route is unsupported');
  if (typeof journal.id !== 'string' || journal.id.length === 0) {
    throw new Error('Schema migration id is invalid');
  }
  if (
    typeof journal.sourceHash !== 'string' ||
    !HASH_PATTERN.test(journal.sourceHash) ||
    typeof journal.targetHash !== 'string' ||
    !HASH_PATTERN.test(journal.targetHash)
  ) {
    throw new Error('Schema migration hash is invalid');
  }
  if (typeof journal.createdAt !== 'string' || Number.isNaN(Date.parse(journal.createdAt))) {
    throw new Error('Schema migration timestamp is invalid');
  }
  const nextState = v1ToV2
    ? parseV2LoopChangeValue(journal.nextState)
    : parseLoopChangeValue(journal.nextState);
  if (nextState.name !== expectedName) {
    throw new Error('Schema migration target state change mismatch');
  }
  if (sha256Text(stringify(migrationStateDocument(nextState))) !== journal.targetHash) {
    throw new Error('Schema migration state target hash does not match its document');
  }
  let transition: LoopSchemaMigrationJournal['transition'];
  if (journal.transition !== undefined) {
    if (!journal.transition || typeof journal.transition !== 'object') {
      throw new Error('Schema migration transition target is invalid');
    }
    rejectUnknownFields(
      journal.transition as unknown as Record<string, unknown>,
      MIGRATION_TRANSITION_KEYS,
      'Schema migration transition target',
    );
    const transitionValue = journal.transition as Partial<
      NonNullable<LoopSchemaMigrationJournal['transition']>
    >;
    if (
      typeof transitionValue.sourceHash !== 'string' ||
      !HASH_PATTERN.test(transitionValue.sourceHash) ||
      typeof transitionValue.targetHash !== 'string' ||
      !HASH_PATTERN.test(transitionValue.targetHash)
    ) {
      throw new Error('Schema migration transition hash is invalid');
    }
    const parsedNextJournal = v1ToV2
      ? parseV2LoopTransitionJournalValue(transitionValue.nextJournal, expectedName)
      : parseLoopTransitionJournalValue(transitionValue.nextJournal, expectedName);
    if (
      sha256Text(JSON.stringify(transitionValue.nextJournal, null, 2) + '\n') !==
      transitionValue.targetHash
    ) {
      throw new Error('Schema migration transition target hash does not match its journal');
    }
    const matches =
      v1ToV2 && nextState.schema === LOOP_V2_CHANGE_SCHEMA
        ? sameV2State(nextState, (parsedNextJournal as LoopV2TransitionJournal).previousState) ||
          sameV2State(nextState, (parsedNextJournal as LoopV2TransitionJournal).nextState)
        : nextState.schema === LOOP_CHANGE_SCHEMA &&
          (sameCurrentState(
            nextState,
            (parsedNextJournal as LoopTransitionJournal).previousState,
          ) ||
            sameCurrentState(nextState, (parsedNextJournal as LoopTransitionJournal).nextState));
    if (!matches) throw new Error('Schema migration state/transition target mismatch');
    transition = {
      sourceHash: transitionValue.sourceHash,
      targetHash: transitionValue.targetHash,
      nextJournal: transitionValue.nextJournal as LoopV2TransitionJournal | LoopTransitionJournal,
    };
  }
  if (
    v1ToV2 &&
    ((!transition && nextState.revision !== 1) ||
      (transition && nextState.revision !== 1 && nextState.revision !== 2))
  ) {
    throw new Error('Schema migration v1 target revision is invalid');
  }
  let transitionSupersede: LoopSchemaMigrationJournal['transitionSupersede'];
  if (journal.transitionSupersede !== undefined) {
    if (!v2ToV3 || transition) {
      throw new Error('Schema migration transition supersede plan is not valid for this route');
    }
    if (nextState.schema !== LOOP_CHANGE_SCHEMA) {
      throw new Error('Schema migration transition supersede target schema is invalid');
    }
    transitionSupersede = parseTransitionSupersede(
      journal.transitionSupersede,
      expectedName,
      nextState,
      journal.id,
    );
  }
  let runRetreat: LoopSchemaMigrationJournal['runRetreat'];
  if (journal.runRetreat !== undefined) {
    if (!v2ToV3 || transition || transitionSupersede) {
      throw new Error('Schema migration Run retreat is not valid for this route');
    }
    if (!journal.runRetreat || typeof journal.runRetreat !== 'object') {
      throw new Error('Schema migration Run retreat is invalid');
    }
    rejectUnknownFields(
      journal.runRetreat as unknown as Record<string, unknown>,
      MIGRATION_RUN_RETREAT_KEYS,
      'Schema migration Run retreat',
    );
    const retreat = journal.runRetreat as Partial<
      NonNullable<LoopSchemaMigrationJournal['runRetreat']>
    >;
    let previousRun: RunState;
    let nextRun: RunState;
    try {
      previousRun = parseLoopStoredRunStateValue(retreat.previousRun);
      nextRun = parseLoopStoredRunStateValue(retreat.nextRun);
    } catch (error) {
      throw new Error('Schema migration Run retreat is invalid', { cause: error });
    }
    if (
      typeof retreat.evidenceHash !== 'string' ||
      !HASH_PATTERN.test(retreat.evidenceHash) ||
      !retreat.eventData ||
      typeof retreat.eventData !== 'object' ||
      Array.isArray(retreat.eventData)
    ) {
      throw new Error('Schema migration Run retreat is invalid');
    }
    if (
      nextState.schema !== LOOP_CHANGE_SCHEMA ||
      nextState.phase !== 'build' ||
      nextState.run_id !== nextRun.runId ||
      previousRun.runId !== nextRun.runId ||
      (previousRun.currentStep !== 'verify' && previousRun.currentStep !== 'archive') ||
      nextRun.currentStep !== 'build' ||
      nextRun.iteration !== previousRun.iteration + 1
    ) {
      throw new Error('Schema migration Run retreat does not match target state');
    }
    runRetreat = {
      previousRun,
      nextRun,
      evidenceHash: retreat.evidenceHash,
      eventData: retreat.eventData as Record<string, unknown>,
    };
  }
  if ((transition && runRetreat) || (transitionSupersede && runRetreat)) {
    throw new Error('Schema migration has conflicting recovery plans');
  }
  return {
    schema: 'owner.loop.schema-migration.v1',
    id: journal.id,
    change: expectedName,
    fromSchema: journal.fromSchema!,
    toSchema: journal.toSchema!,
    sourceHash: journal.sourceHash,
    targetHash: journal.targetHash,
    createdAt: journal.createdAt,
    nextState,
    ...(transition ? { transition } : {}),
    ...(transitionSupersede ? { transitionSupersede } : {}),
    ...(runRetreat ? { runRetreat } : {}),
  };
}

export async function inspectPendingLoopSchemaMigration(
  paths: LoopProjectPaths,
  name: string,
): Promise<LoopSchemaMigrationJournal | null> {
  const file = loopSchemaMigrationJournalFile(paths, name);
  const storageRoot = loopStorageRoot(paths, file);
  await resolveContainedLoopPath(storageRoot, file);
  try {
    const source = await readLoopProtectedTextFile({
      root: storageRoot,
      file,
      maxBytes: 512 * 1024,
      label: 'Loop schema migration journal',
    });
    return parseMigrationJournal(JSON.parse(source.text), name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function ensureMigrationBaseline(
  paths: LoopProjectPaths,
  name: string,
  createdAt: string,
): Promise<void> {
  const stored = await readLoopBaselineManifest(paths, name);
  const baseline = stored
    ? await filterLoopContentSnapshotToProjectScope(paths, stored)
    : await createLoopContentSnapshot(paths, {
        now: new Date(createdAt),
        origin: 'legacy-migration',
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
      name,
      baseline.omittedCount,
      omittedByReason,
      health.samplePaths,
      health.sampleTruncated,
    );
  }
  if (stored === null) await writeLoopBaselineManifest(paths, name, baseline);
}

async function optionalFileHash(file: string): Promise<string | null> {
  try {
    return await sha256File(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function expectedSupersedeEvent(
  journal: LoopSchemaMigrationJournal,
  sequence: number,
): Record<string, unknown> {
  const supersede = journal.transitionSupersede!;
  return {
    sequence,
    timestamp: journal.createdAt,
    type: 'state_migrated',
    runId: supersede.nextRun.runId,
    data: {
      ...supersede.eventData,
      migrationId: journal.id,
      evidenceHash: supersede.evidenceHash,
    },
  };
}

async function inspectSupersedeEvent(
  paths: LoopProjectPaths,
  journal: LoopSchemaMigrationJournal,
): Promise<{ trajectoryLength: number; sequence: number | null }> {
  const supersede = journal.transitionSupersede!;
  const runtimeDir = loopChangeRuntimeDir(paths, journal.change);
  const trajectory = await readLoopTrajectory(runtimeDir, supersede.nextRun.trajectoryRef);
  const matches = trajectory
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.data.migrationId === journal.id);
  if (matches.length > 1) {
    throw new Error(`Loop schema migration event ${journal.id} is duplicated`);
  }
  const match = matches[0];
  if (match && !isDeepStrictEqual(match.event, expectedSupersedeEvent(journal, match.index + 1))) {
    throw new Error(`Loop schema migration event ${journal.id} changed`);
  }
  return { trajectoryLength: trajectory.length, sequence: match?.event.sequence ?? null };
}

async function assertSupersedeSourceBeforeMutation(
  paths: LoopProjectPaths,
  journal: LoopSchemaMigrationJournal,
  stateAtTarget: boolean,
): Promise<void> {
  if (!journal.transitionSupersede) return;
  const transitionFile = loopTransitionJournalFile(paths, journal.change);
  const actualHash = await optionalFileHash(transitionFile);
  if (actualHash === journal.transitionSupersede.sourceHash) return;
  if (actualHash !== null) {
    throw new Error(
      `Loop superseded transition source changed for ${journal.change}: expected ${journal.transitionSupersede.sourceHash}, actual ${actualHash}`,
    );
  }
  const runtimeDir = loopChangeRuntimeDir(paths, journal.change);
  const run = await readLoopRunState(runtimeDir);
  const event = await inspectSupersedeEvent(paths, journal);
  const checkpoint = await readLoopCheckpoint(
    runtimeDir,
    journal.transitionSupersede.nextRun.checkpointRef,
  );
  if (
    !stateAtTarget ||
    !run ||
    !sameRunState(run, journal.transitionSupersede.nextRun) ||
    event.sequence === null ||
    !checkpoint ||
    checkpoint.runId !== journal.transitionSupersede.nextRun.runId ||
    checkpoint.stateVersion !== journal.transitionSupersede.nextRun.iteration ||
    checkpoint.trajectoryOffset !== event.sequence ||
    checkpoint.contextHash !== null ||
    checkpoint.artifactsHash !== sha256Text(journal.transitionSupersede.evidenceHash) ||
    checkpoint.createdAt !== journal.createdAt
  ) {
    throw new Error(
      `Loop superseded transition disappeared before migration ${journal.id} was durable`,
    );
  }
}

async function continueTransitionSupersede(
  paths: LoopProjectPaths,
  journal: LoopSchemaMigrationJournal,
  hooks?: LoopSchemaMigrationHooks,
): Promise<void> {
  const supersede = journal.transitionSupersede;
  if (!supersede) return;
  const runtimeDir = loopChangeRuntimeDir(paths, journal.change);
  const currentRun = await readLoopRunState(runtimeDir);
  if (!currentRun) {
    throw new Error(`Loop schema migration Run state disappeared for ${journal.change}`);
  }
  if (!sameRunState(currentRun, supersede.nextRun)) {
    if (!sameRunState(currentRun, supersede.previousRun)) {
      throw new Error(`Loop schema migration Run source changed for ${journal.change}`);
    }
    await writeLoopRunState(runtimeDir, supersede.nextRun);
    await hooks?.afterRunStateWritten?.(journal);
  }
  if (!sameRunState((await readLoopRunState(runtimeDir))!, supersede.nextRun)) {
    throw new Error(`Loop schema migration Run write diverged for ${journal.change}`);
  }

  let event = await inspectSupersedeEvent(paths, journal);
  if (event.sequence === null) {
    const appended = await appendLoopTrajectoryEvent({
      changeDir: runtimeDir,
      run: supersede.nextRun,
      type: 'state_migrated',
      data: {
        ...supersede.eventData,
        migrationId: journal.id,
        evidenceHash: supersede.evidenceHash,
      },
      now: new Date(journal.createdAt),
    });
    event = { trajectoryLength: appended.sequence, sequence: appended.sequence };
  }
  await hooks?.afterTrajectoryWritten?.(journal);
  await writeLoopCheckpoint({
    changeDir: runtimeDir,
    run: supersede.nextRun,
    trajectoryOffset: event.sequence!,
    evidenceHash: supersede.evidenceHash,
    now: new Date(journal.createdAt),
  });
  await hooks?.afterCheckpointWritten?.(journal);

  const transitionFile = loopTransitionJournalFile(paths, journal.change);
  const transitionHash = await optionalFileHash(transitionFile);
  if (transitionHash !== null) {
    if (transitionHash !== supersede.sourceHash) {
      throw new Error(`Loop superseded transition changed before removal for ${journal.change}`);
    }
    await fs.rm(transitionFile);
    await hooks?.afterTransitionSuperseded?.(journal);
  }
}

async function continueRunRetreat(
  paths: LoopProjectPaths,
  journal: LoopSchemaMigrationJournal,
  hooks?: LoopSchemaMigrationHooks,
): Promise<void> {
  if (!journal.runRetreat) return;
  const runtimeDir = loopChangeRuntimeDir(paths, journal.change);
  const currentRun = await readLoopRunState(runtimeDir);
  if (!currentRun) {
    throw new Error(`Loop schema migration Run state disappeared for ${journal.change}`);
  }
  if (!sameRunState(currentRun, journal.runRetreat.nextRun)) {
    if (!sameRunState(currentRun, journal.runRetreat.previousRun)) {
      throw new Error(`Loop schema migration Run source changed for ${journal.change}`);
    }
    await writeLoopRunState(runtimeDir, journal.runRetreat.nextRun);
    await hooks?.afterRunStateWritten?.(journal);
  }
  let trajectory = await readLoopTrajectory(runtimeDir, journal.runRetreat.nextRun.trajectoryRef);
  let event = trajectory.find(
    (item) => item.type === 'state_migrated' && item.data.migrationId === journal.id,
  );
  if (!event) {
    event = await appendLoopTrajectoryEvent({
      changeDir: runtimeDir,
      run: journal.runRetreat.nextRun,
      type: 'state_migrated',
      data: {
        ...journal.runRetreat.eventData,
        migrationId: journal.id,
        evidenceHash: journal.runRetreat.evidenceHash,
      },
      now: new Date(journal.createdAt),
    });
    trajectory = [...trajectory, event];
  }
  await hooks?.afterTrajectoryWritten?.(journal);
  await writeLoopCheckpoint({
    changeDir: runtimeDir,
    run: journal.runRetreat.nextRun,
    trajectoryOffset: trajectory.length,
    evidenceHash: journal.runRetreat.evidenceHash,
    now: new Date(journal.createdAt),
  });
  await hooks?.afterCheckpointWritten?.(journal);
}

async function continueLoopSchemaMigrationLocked(
  paths: LoopProjectPaths,
  name: string,
  hooks?: LoopSchemaMigrationHooks,
): Promise<LoopV2ChangeState | LoopChangeState | null> {
  const journal = await inspectPendingLoopSchemaMigration(paths, name);
  if (!journal) return null;
  if (await hasPendingLoopCheckpointRecovery(paths, name)) {
    throw new Error(
      `Loop change ${name} has a pending progress checkpoint; recover it with its v2 runtime before schema migration`,
    );
  }
  const changeFile = path.join(loopChangeDir(paths, name), LOOP_CHANGE_STATE_FILE);
  const actualHash = await sha256File(changeFile);
  await assertSupersedeSourceBeforeMutation(paths, journal, actualHash === journal.targetHash);
  // Baseline safety must be established before writing state, Run, trajectory, or checkpoint.
  // A failed capture leaves only the prepared migration journal and the original state, so retry
  // remains deterministic after the project omission is resolved.
  await ensureMigrationBaseline(paths, name, journal.createdAt);
  if (actualHash !== journal.targetHash) {
    if (actualHash !== journal.sourceHash) {
      throw new Error(
        `Loop schema migration source changed for ${name}: expected ${journal.sourceHash}, actual ${actualHash}`,
      );
    }
    await atomicWriteText(changeFile, stringify(migrationStateDocument(journal.nextState)));
    await hooks?.afterStateWritten?.(journal);
  }
  if (journal.transition) {
    const transitionFile = loopTransitionJournalFile(paths, name);
    const actualTransitionHash = await sha256File(transitionFile);
    if (actualTransitionHash !== journal.transition.targetHash) {
      if (actualTransitionHash !== journal.transition.sourceHash) {
        throw new Error(
          `Loop transition migration source changed for ${name}: expected ${journal.transition.sourceHash}, actual ${actualTransitionHash}`,
        );
      }
      await atomicWriteJson(transitionFile, journal.transition.nextJournal);
      await hooks?.afterTransitionWritten?.(journal);
    }
  }
  await continueTransitionSupersede(paths, journal, hooks);
  await continueRunRetreat(paths, journal, hooks);
  await fs.rm(loopSchemaMigrationJournalFile(paths, name), { force: true });
  return journal.nextState;
}

async function stableEvidenceRetreat(options: {
  paths: LoopProjectPaths;
  state: LoopV2ChangeState;
  migrationId: string;
}): Promise<NonNullable<LoopSchemaMigrationJournal['runRetreat']>> {
  const runtimeDir = loopChangeRuntimeDir(options.paths, options.state.name);
  const run = await readLoopRunState(runtimeDir);
  if (
    !run ||
    run.runId !== options.state.run_id ||
    run.currentStep !== options.state.phase ||
    (run.currentStep !== 'verify' && run.currentStep !== 'archive') ||
    run.pending !== null
  ) {
    throw new Error(
      `Loop v2 ${options.state.phase} change ${options.state.name} has no consistent Run state for safe Build retreat`,
    );
  }
  const nextRun: RunState = {
    ...run,
    currentStep: 'build',
    iteration: run.iteration + 1,
    pending: null,
    status: 'running',
  };
  const evidenceHash = sha256Text(
    `schema-v3-evidence-retreat:${options.state.name}:${options.state.revision}:${options.migrationId}`,
  );
  return {
    previousRun: run,
    nextRun,
    evidenceHash,
    eventData: {
      fromSchema: LOOP_V2_CHANGE_SCHEMA,
      toSchema: LOOP_CHANGE_SCHEMA,
      previousPhase: options.state.phase,
      nextPhase: 'build',
      reason: 'implementation-scope-required',
    },
  };
}

async function pendingEvidenceTransitionSupersede(options: {
  paths: LoopProjectPaths;
  state: LoopV2ChangeState;
  journal: LoopV2TransitionJournal;
  migrationId: string;
}): Promise<{
  nextState: LoopChangeState;
  plan: NonNullable<LoopSchemaMigrationJournal['transitionSupersede']>;
}> {
  const { journal, state } = options;
  const requiresV3Evidence =
    (journal.previousState.phase === 'build' && journal.nextState.phase === 'verify') ||
    (journal.previousState.phase === 'verify' &&
      (journal.nextState.phase === 'build' || journal.nextState.phase === 'archive'));
  if (!requiresV3Evidence) {
    throw new Error('Only a pending v2 evidence-bearing transition can be superseded');
  }
  const stateIsPrevious = sameV2State(state, journal.previousState);
  const stateIsNext = sameV2State(state, journal.nextState);
  if (!stateIsPrevious && !stateIsNext) {
    throw new Error(`Loop change ${state.name} does not match its v2 evidence transition`);
  }
  const runtimeDir = loopChangeRuntimeDir(options.paths, state.name);
  const currentRun = await readLoopRunState(runtimeDir);
  if (!currentRun) throw new Error(`Loop v2 transition Run is missing for ${state.name}`);
  const runIsPrevious =
    journal.previousRun !== null && sameRunState(currentRun, journal.previousRun);
  const runIsNext = sameRunState(currentRun, journal.nextRun);
  if ((!runIsPrevious && !runIsNext) || (stateIsNext && !runIsNext)) {
    throw new Error(`Loop v2 transition Run does not match its durable state for ${state.name}`);
  }

  const trajectory = await readLoopTrajectory(runtimeDir, journal.nextRun.trajectoryRef);
  const collisions = trajectory
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.data.transitionId === journal.id);
  if (collisions.length > 1) {
    throw new Error(`Loop v2 evidence transition ${journal.id} has duplicate trajectory events`);
  }
  const durable = collisions[0];
  if (durable) {
    const expected = {
      sequence: durable.index + 1,
      timestamp: journal.createdAt,
      type: 'state_transitioned',
      runId: journal.nextRun.runId,
      data: { ...journal.eventData, transitionId: journal.id },
    };
    if (!isDeepStrictEqual(durable.event, expected) || !stateIsNext || !runIsNext) {
      throw new Error(
        `Loop v2 evidence transition ${journal.id} trajectory event does not match its journal`,
      );
    }
  }

  const nextState: LoopChangeState = {
    ...upgradeV2StateToV3(state),
    revision: state.revision + (state.phase === 'build' ? 0 : 1),
    phase: 'build',
    verification_result: 'pending',
    verification_report: null,
    implementation_scope: null,
    verification_evidence: null,
    partial_allowance: null,
    archived: false,
  };
  const previousRun = currentRun;
  const nextRun: RunState =
    currentRun.currentStep !== 'build'
      ? {
          ...currentRun,
          currentStep: 'build',
          iteration: currentRun.iteration + 1,
          pending: null,
          status: 'running',
        }
      : currentRun;
  const evidenceHash = sha256Text(
    JSON.stringify({
      operation: 'supersede-v2-evidence-transition',
      change: state.name,
      transitionId: journal.id,
      migrationId: options.migrationId,
      previousPhase: state.phase,
      nextPhase: 'build',
      reason: 'implementation-scope-required',
      previousIteration: currentRun.iteration,
      nextRevision: nextState.revision,
    }),
  );
  return {
    nextState,
    plan: {
      sourceHash: await sha256File(loopTransitionJournalFile(options.paths, state.name)),
      transitionId: journal.id,
      previousRun,
      nextRun,
      evidenceHash,
      eventData: {
        fromSchema: LOOP_V2_CHANGE_SCHEMA,
        toSchema: LOOP_CHANGE_SCHEMA,
        previousPhase: state.phase,
        nextPhase: 'build',
        reason: 'implementation-scope-required',
        supersededTransitionId: journal.id,
      },
    },
  };
}

async function prepareNextMigration(options: {
  paths: LoopProjectPaths;
  name: string;
  state: LoopLegacyChangeState | LoopV2ChangeState;
  pendingTransition: Awaited<ReturnType<typeof inspectPendingLoopTransitionSchema>>;
  now: Date;
  id: string;
}): Promise<LoopSchemaMigrationJournal> {
  let nextState: LoopV2ChangeState | LoopChangeState;
  let transition: LoopSchemaMigrationJournal['transition'];
  let transitionSupersede: LoopSchemaMigrationJournal['transitionSupersede'];
  let runRetreat: LoopSchemaMigrationJournal['runRetreat'];
  if (options.state.schema === LOOP_LEGACY_CHANGE_SCHEMA) {
    nextState = upgradeV1StateToV2(options.state, 1);
    if (options.pendingTransition) {
      if (options.pendingTransition.journal.schema !== LOOP_LEGACY_TRANSITION_SCHEMA) {
        throw new Error('Loop v1 change has a transition from another schema generation');
      }
      const nextJournal = upgradeV1TransitionToV2(options.pendingTransition.journal);
      if (sameV1State(options.state, options.pendingTransition.journal.previousState)) {
        nextState = nextJournal.previousState;
      } else if (sameV1State(options.state, options.pendingTransition.journal.nextState)) {
        nextState = nextJournal.nextState;
      } else {
        throw new Error(
          `Loop change ${options.name} does not match either state in its v1 transition journal`,
        );
      }
      const transitionFile = loopTransitionJournalFile(options.paths, options.name);
      transition = {
        sourceHash: await sha256File(transitionFile),
        targetHash: sha256Text(transitionContent(nextJournal)),
        nextJournal,
      };
    }
  } else {
    if (options.pendingTransition) {
      if (options.pendingTransition.journal.schema !== LOOP_V2_TRANSITION_SCHEMA) {
        throw new Error('Loop v2 change has a transition from another schema generation');
      }
      const v2Journal = options.pendingTransition.journal;
      const requiresV3Evidence =
        (v2Journal.previousState.phase === 'build' && v2Journal.nextState.phase === 'verify') ||
        (v2Journal.previousState.phase === 'verify' &&
          (v2Journal.nextState.phase === 'build' || v2Journal.nextState.phase === 'archive'));
      if (requiresV3Evidence) {
        const supersede = await pendingEvidenceTransitionSupersede({
          paths: options.paths,
          state: options.state,
          journal: v2Journal,
          migrationId: options.id,
        });
        nextState = supersede.nextState;
        transitionSupersede = supersede.plan;
      } else {
        const nextJournal = upgradeV2TransitionToV3(v2Journal);
        if (sameV2State(options.state, options.pendingTransition.journal.previousState)) {
          nextState = nextJournal.previousState;
        } else if (sameV2State(options.state, options.pendingTransition.journal.nextState)) {
          nextState = nextJournal.nextState;
        } else {
          throw new Error(
            `Loop change ${options.name} does not match either state in its v2 transition journal`,
          );
        }
        const transitionFile = loopTransitionJournalFile(options.paths, options.name);
        transition = {
          sourceHash: await sha256File(transitionFile),
          targetHash: sha256Text(transitionContent(nextJournal)),
          nextJournal,
        };
      }
    } else {
      nextState = upgradeV2StateToV3(options.state, {
        retreatEvidencePhase: true,
        incrementRetreatRevision: true,
      });
      if (options.state.phase === 'verify' || options.state.phase === 'archive') {
        runRetreat = await stableEvidenceRetreat({
          paths: options.paths,
          state: options.state,
          migrationId: options.id,
        });
      }
    }
  }
  const changeFile = path.join(loopChangeDir(options.paths, options.name), LOOP_CHANGE_STATE_FILE);
  const targetContent = stringify(migrationStateDocument(nextState));
  return {
    schema: 'owner.loop.schema-migration.v1',
    id: options.id,
    change: options.name,
    fromSchema: options.state.schema,
    toSchema:
      options.state.schema === LOOP_LEGACY_CHANGE_SCHEMA
        ? LOOP_V2_CHANGE_SCHEMA
        : LOOP_CHANGE_SCHEMA,
    sourceHash: await sha256File(changeFile),
    targetHash: sha256Text(targetContent),
    createdAt: options.now.toISOString(),
    nextState,
    ...(transition ? { transition } : {}),
    ...(transitionSupersede ? { transitionSupersede } : {}),
    ...(runRetreat ? { runRetreat } : {}),
  };
}

export async function migrateLoopChange(options: {
  paths: LoopProjectPaths;
  name: string;
  now?: Date;
  id?: () => string;
  hooks?: LoopSchemaMigrationHooks;
}): Promise<LoopChangeState> {
  return withLoopMutationLock(options.paths, `migrate schema for ${options.name}`, () =>
    withLoopTransitionLock(
      options.paths,
      options.name,
      `migrate schema for ${options.name}`,
      async () => {
        for (let step = 0; step < 3; step += 1) {
          const continued = await continueLoopSchemaMigrationLocked(
            options.paths,
            options.name,
            options.hooks,
          );
          if (continued?.schema === LOOP_CHANGE_SCHEMA) return continued;

          const inspection = await inspectLoopChange(options.paths, options.name);
          if (inspection.status === 'current' && inspection.state) {
            return inspection.state as LoopChangeState;
          }
          if (inspection.status !== 'migration-required' || !inspection.state) {
            throw new Error(inspection.message ?? `Loop change ${options.name} cannot be migrated`);
          }
          if (await hasPendingLoopCheckpointRecovery(options.paths, options.name)) {
            throw new Error(
              `Loop change ${options.name} has a pending progress checkpoint; recover it with its v2 runtime before schema migration`,
            );
          }
          const state = inspection.state as LoopReadableChangeState;
          if (
            state.schema !== LOOP_LEGACY_CHANGE_SCHEMA &&
            state.schema !== LOOP_V2_CHANGE_SCHEMA
          ) {
            throw new Error(`Loop change ${options.name} has no supported migration route`);
          }
          const pendingTransition = await inspectPendingLoopTransitionSchema(
            options.paths,
            options.name,
          );
          if (pendingTransition?.status === 'current') {
            throw new Error(
              `Loop change ${options.name} has a current-schema pending transition; recover it before schema migration`,
            );
          }
          const journal = await prepareNextMigration({
            paths: options.paths,
            name: options.name,
            state,
            pendingTransition,
            now: options.now ?? new Date(),
            id: options.id?.() ?? randomUUID(),
          });
          const journalFile = loopSchemaMigrationJournalFile(options.paths, options.name);
          const storageRoot = loopStorageRoot(options.paths, journalFile);
          await resolveContainedLoopPath(storageRoot, journalFile);
          await atomicWriteJson(journalFile, journal, { containedRoot: storageRoot });
          await options.hooks?.afterPrepared?.(journal);
        }
        throw new Error(`Loop change ${options.name} exceeded the supported schema migration path`);
      },
    ),
  );
}
