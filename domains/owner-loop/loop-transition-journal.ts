import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { isDeepStrictEqual } from 'util';

import { LOOP_RUN_STORAGE } from '../engine/storage-layout.js';
import { atomicWriteJson } from './loop-atomic-file.js';
import {
  hasPendingLoopSchemaMigration,
  compareAndSwapLoopChangeLocked,
  parseLegacyLoopChangeValue,
  parseLoopChangeValue,
  parseV2LoopChangeValue,
  readLoopChange,
} from './loop-change.js';
import { sha256Text } from './loop-hash.js';
import { acquireLoopLock, releaseLoopLock, type LoopLock } from './loop-lock.js';
import { withLoopMutationLock } from './loop-mutation-lock.js';
import { loopChangeRuntimeDir, loopStorageRoot, resolveContainedLoopPath } from './loop-paths.js';
import { readLoopProtectedFile } from './loop-protected-file.js';
import { redactLoopCredentialText } from './loop-redaction.js';
import {
  parseLoopRepairTrajectoryProjection,
  type LoopRepairTrajectoryProjection,
} from './loop-repair-runtime.js';
import { assertLoopTrajectoryText } from './loop-trajectory-limits.js';
import {
  isCompatibleLoopRuntimeIdentity,
  LOOP_RUNTIME_HASH,
  LOOP_RUNTIME_PACKAGE,
} from './loop-runtime-package.js';
import {
  parseLoopStoredRunStateValue,
  readLoopRunState,
  readLoopTrajectory,
  writeLoopRunState,
} from './loop-run-store.js';
import { appendLoopTrajectoryEvent, writeLoopCheckpoint } from './loop-trajectory.js';
import { loopAdvanceEvidenceHash } from './loop-transition-evidence.js';
import { assertLoopTrajectoryHealthy } from './loop-trajectory-recovery.js';
import type {
  LoopChangeState,
  LoopLegacyTransitionJournal,
  LoopProjectPaths,
  LoopReadableChangeState,
  LoopTransitionHooks,
  LoopTransitionJournal,
  LoopTransitionOperation,
  LoopTransitionSchemaInspection,
  LoopV2TransitionJournal,
} from './loop-types.js';
import {
  LOOP_LEGACY_TRANSITION_SCHEMA,
  LOOP_RUNTIME_PROTOCOL_VERSION,
  LOOP_TRANSITION_SCHEMA,
  LOOP_V2_TRANSITION_SCHEMA,
} from './loop-types.js';

const COMMON_JOURNAL_KEYS = [
  'schema',
  'id',
  'change',
  'evidenceHash',
  'createdAt',
  'previousState',
  'nextState',
  'previousRun',
  'nextRun',
  'eventData',
] as const;
const LEGACY_JOURNAL_KEYS = new Set<string>(COMMON_JOURNAL_KEYS);
const V2_JOURNAL_KEYS = new Set<string>([
  ...COMMON_JOURNAL_KEYS,
  'minimum_runtime_version',
  'revision',
]);
const CURRENT_JOURNAL_KEYS = new Set<string>([...V2_JOURNAL_KEYS, 'operation']);
export const LOOP_TRANSITION_JOURNAL_MAX_BYTES = 512 * 1024;
const REQUIRED_TRANSITION_EVENT_DATA_KEYS = new Set([
  'previousPhase',
  'nextPhase',
  'evidenceHash',
  'summary',
  'artifacts',
  'noCodeReason',
  'verificationResult',
]);
const TRANSITION_EVENT_DATA_KEYS = new Set([
  ...REQUIRED_TRANSITION_EVENT_DATA_KEYS,
  'implementationScopeHash',
  'repairScopeHash',
  'repairStagnation',
  'returnToBuild',
]);

interface LoopTransitionEventData extends Record<string, unknown> {
  previousPhase: LoopReadableChangeState['phase'];
  nextPhase: LoopReadableChangeState['phase'];
  evidenceHash: string;
  summary: string;
  artifacts: string[];
  noCodeReason: string | null;
  verificationResult: 'pass' | 'fail' | null;
  implementationScopeHash?: string;
  repairScopeHash?: string;
  repairStagnation?: LoopRepairTrajectoryProjection;
  returnToBuild?: boolean;
}

export class LoopTransitionMigrationRequiredError extends Error {
  readonly code = 'loop-transition-migration-required';

  constructor(readonly change: string) {
    super(`Loop transition for ${change} requires doctor migration before recovery`);
    this.name = 'LoopTransitionMigrationRequiredError';
  }
}

export function loopTransitionJournalFile(paths: LoopProjectPaths, name: string): string {
  return path.join(loopChangeRuntimeDir(paths, name), 'transition.json');
}

function loopTransitionLockName(name: string): string {
  return `transition-${name}`;
}

async function acquireLoopTransitionLock(
  paths: LoopProjectPaths,
  name: string,
  operation: string,
): Promise<LoopLock> {
  const lockName = loopTransitionLockName(name);
  return acquireLoopLock(paths, lockName, operation);
}

export async function withLoopTransitionLock<T>(
  paths: LoopProjectPaths,
  name: string,
  operation: string,
  work: () => Promise<T>,
): Promise<T> {
  const lock = await acquireLoopTransitionLock(paths, name, operation);
  try {
    return await work();
  } finally {
    await releaseLoopLock(lock);
  }
}

function journalRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Loop transition journal must be an object');
  }
  return value as Record<string, unknown>;
}

function rejectUnknownJournalFields(journal: Record<string, unknown>, known: Set<string>): void {
  const unknown = Object.keys(journal).find((key) => !known.has(key));
  if (unknown) throw new Error(`Loop transition journal contains unknown field: ${unknown}`);
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value as number;
}

function sameValue(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

function parseTransitionEventData(value: unknown, evidenceHash: string): LoopTransitionEventData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Loop transition journal event data is invalid');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const unknown = keys.find((key) => !TRANSITION_EVENT_DATA_KEYS.has(key));
  const missing = [...REQUIRED_TRANSITION_EVENT_DATA_KEYS].find(
    (key) => !Object.hasOwn(record, key),
  );
  const expectedSize =
    REQUIRED_TRANSITION_EVENT_DATA_KEYS.size +
    (Object.hasOwn(record, 'implementationScopeHash') ? 1 : 0) +
    (Object.hasOwn(record, 'repairScopeHash') ? 1 : 0) +
    (Object.hasOwn(record, 'repairStagnation') ? 1 : 0) +
    (Object.hasOwn(record, 'returnToBuild') ? 1 : 0);
  if (unknown || missing || keys.length !== expectedSize) {
    throw new Error(
      `Loop transition journal event data keys are invalid${unknown ? `: ${unknown}` : missing ? `: missing ${missing}` : ''}`,
    );
  }
  if (
    !['shape', 'build', 'verify', 'archive'].includes(record.previousPhase as string) ||
    !['shape', 'build', 'verify', 'archive'].includes(record.nextPhase as string)
  ) {
    throw new Error('Loop transition journal event phases are invalid');
  }
  if (record.evidenceHash !== evidenceHash) {
    throw new Error('Loop transition journal event evidence hash mismatch');
  }
  if (record.returnToBuild !== undefined && typeof record.returnToBuild !== 'boolean') {
    throw new Error('Loop transition journal returnToBuild flag is invalid');
  }
  assertLoopTrajectoryText(record.summary, 'Loop transition journal event summary');
  if (redactLoopCredentialText(record.summary) !== record.summary) {
    throw new Error('Loop transition journal event summary contains unredacted credentials');
  }
  if (
    !Array.isArray(record.artifacts) ||
    record.artifacts.length > 128 ||
    record.artifacts.some(
      (artifact) =>
        typeof artifact !== 'string' ||
        artifact.length === 0 ||
        Buffer.byteLength(artifact, 'utf8') > 512,
    )
  ) {
    throw new Error('Loop transition journal event artifacts are invalid');
  }
  if (record.noCodeReason !== null) {
    assertLoopTrajectoryText(record.noCodeReason, 'Loop transition journal event no-code reason');
    if (redactLoopCredentialText(record.noCodeReason) !== record.noCodeReason) {
      throw new Error(
        'Loop transition journal event no-code reason contains unredacted credentials',
      );
    }
  }
  if (
    record.verificationResult !== null &&
    record.verificationResult !== 'pass' &&
    record.verificationResult !== 'fail'
  ) {
    throw new Error('Loop transition journal event verification result is invalid');
  }
  const implementationScopeHash = Object.hasOwn(record, 'implementationScopeHash')
    ? record.implementationScopeHash
    : null;
  if (
    implementationScopeHash !== null &&
    (typeof implementationScopeHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(implementationScopeHash) ||
      (record.previousPhase !== 'build' && record.previousPhase !== 'verify'))
  ) {
    throw new Error('Loop transition journal implementation scope hash is invalid');
  }
  const repairStagnation = Object.hasOwn(record, 'repairStagnation')
    ? parseLoopRepairTrajectoryProjection(record.repairStagnation)
    : null;
  if (repairStagnation) {
    const failureProjection = repairStagnation.overrideSummaryHash === null;
    if (
      (failureProjection &&
        (record.previousPhase !== 'verify' ||
          record.nextPhase !== 'build' ||
          record.verificationResult !== 'fail')) ||
      (!failureProjection &&
        (record.previousPhase !== 'build' ||
          record.nextPhase !== 'verify' ||
          record.verificationResult !== null))
    ) {
      throw new Error('Loop transition journal repair projection does not match its phase');
    }
  }
  const repairScopeHash = Object.hasOwn(record, 'repairScopeHash') ? record.repairScopeHash : null;
  if (
    repairScopeHash !== null &&
    (typeof repairScopeHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(repairScopeHash) ||
      (record.previousPhase !== 'build' && record.previousPhase !== 'verify') ||
      implementationScopeHash === null)
  ) {
    throw new Error('Loop transition journal repair scope hash is invalid');
  }
  return {
    previousPhase: record.previousPhase as LoopTransitionEventData['previousPhase'],
    nextPhase: record.nextPhase as LoopTransitionEventData['nextPhase'],
    evidenceHash,
    summary: record.summary,
    artifacts: [...record.artifacts] as string[],
    noCodeReason: record.noCodeReason as string | null,
    verificationResult: record.verificationResult as 'pass' | 'fail' | null,
    ...(record.returnToBuild === true ? { returnToBuild: true } : {}),
    ...(implementationScopeHash ? { implementationScopeHash } : {}),
    ...(repairScopeHash ? { repairScopeHash } : {}),
    ...(repairStagnation ? { repairStagnation } : {}),
  };
}

function parseLegacyTransitionEventData(
  value: unknown,
  evidenceHash: string,
): LoopTransitionEventData {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    const legacyRebaseKeys = new Set([
      'previousPhase',
      'nextPhase',
      'evidenceHash',
      'summary',
      'reason',
    ]);
    if (
      keys.length === legacyRebaseKeys.size &&
      keys.every((key) => legacyRebaseKeys.has(key)) &&
      record.reason === 'spec-rebase'
    ) {
      return parseTransitionEventData(
        {
          previousPhase: record.previousPhase,
          nextPhase: record.nextPhase,
          evidenceHash: record.evidenceHash,
          summary: record.summary,
          artifacts: [],
          noCodeReason: null,
          verificationResult: null,
        },
        evidenceHash,
      );
    }
  }
  return parseTransitionEventData(value, evidenceHash);
}

function validateJournalEnvelope(
  journal: Record<string, unknown>,
  expectedName: string,
  legacyEventData = false,
): {
  id: string;
  evidenceHash: string;
  createdAt: string;
  previousRun: LoopTransitionJournal['previousRun'];
  nextRun: LoopTransitionJournal['nextRun'];
  eventData: LoopTransitionEventData;
} {
  if (journal.change !== expectedName) throw new Error('Loop transition journal change mismatch');
  if (typeof journal.id !== 'string' || journal.id.length === 0) {
    throw new Error('Loop transition journal id is invalid');
  }
  if (typeof journal.evidenceHash !== 'string' || !/^[a-f0-9]{64}$/u.test(journal.evidenceHash)) {
    throw new Error('Loop transition journal evidence hash is invalid');
  }
  if (typeof journal.createdAt !== 'string' || Number.isNaN(Date.parse(journal.createdAt))) {
    throw new Error('Loop transition journal timestamp is invalid');
  }
  const eventData = legacyEventData
    ? parseLegacyTransitionEventData(journal.eventData, journal.evidenceHash)
    : parseTransitionEventData(journal.eventData, journal.evidenceHash);
  const nextRun = parseLoopStoredRunStateValue(journal.nextRun);
  const previousRun =
    journal.previousRun === null ? null : parseLoopStoredRunStateValue(journal.previousRun);
  return {
    id: journal.id,
    evidenceHash: journal.evidenceHash,
    createdAt: journal.createdAt,
    previousRun,
    nextRun,
    eventData,
  };
}

function assertLoopRunMetadata(
  run: LoopTransitionJournal['nextRun'],
  label: string,
  allowCompatibleLegacyIdentity = false,
): void {
  if (
    run.skill !== LOOP_RUNTIME_PACKAGE.definition.metadata.name ||
    (allowCompatibleLegacyIdentity
      ? !isCompatibleLoopRuntimeIdentity(run)
      : run.skillVersion !== LOOP_RUNTIME_PACKAGE.definition.metadata.version ||
        run.skillHash !== LOOP_RUNTIME_HASH) ||
    run.orchestration !== LOOP_RUNTIME_PACKAGE.definition.orchestration.mode ||
    run.pendingRef !== LOOP_RUN_STORAGE.pendingRef ||
    run.trajectoryRef !== LOOP_RUN_STORAGE.trajectoryRef ||
    run.contextRef !== LOOP_RUN_STORAGE.contextRef ||
    run.artifactsRef !== LOOP_RUN_STORAGE.artifactsRef ||
    run.checkpointRef !== LOOP_RUN_STORAGE.checkpointRef
  ) {
    throw new Error(`Loop transition journal ${label} metadata or storage refs are invalid`);
  }
}

function runInvariantProjection(run: LoopTransitionJournal['nextRun']): Record<string, unknown> {
  return {
    runId: run.runId,
    skill: run.skill,
    skillVersion: run.skillVersion,
    skillHash: run.skillHash,
    orchestration: run.orchestration,
    pendingRef: run.pendingRef,
    trajectoryRef: run.trajectoryRef,
    contextRef: run.contextRef,
    artifactsRef: run.artifactsRef,
    checkpointRef: run.checkpointRef,
    retries: run.retries,
  };
}

function assertCommittableRun(run: LoopTransitionJournal['nextRun'], label: string): void {
  if (run.status !== 'running') {
    throw new Error(`Loop transition journal ${label} status must be running`);
  }
  if (run.pending !== null) {
    throw new Error(`Loop transition journal ${label} pending action must be null`);
  }
}

function validateTransitionRunSemantics(
  previousState: LoopReadableChangeState,
  nextState: LoopReadableChangeState,
  envelope: ReturnType<typeof validateJournalEnvelope>,
  allowCompatibleLegacyIdentity = false,
  operation: LoopTransitionOperation = 'advance',
): void {
  const { previousRun, nextRun } = envelope;
  assertLoopRunMetadata(nextRun, 'next Run', allowCompatibleLegacyIdentity || previousRun !== null);
  assertCommittableRun(nextRun, 'next Run');
  if (nextRun.runId !== nextState.run_id || nextRun.currentStep !== nextState.phase) {
    throw new Error('Loop transition journal next Run does not match the next change state');
  }

  if (operation === 'runtime-rebuild') {
    if (
      previousRun !== null ||
      previousState.phase === 'shape' ||
      nextState.phase !== 'build' ||
      nextRun.iteration !== 1 ||
      Object.keys(nextRun.retries).length !== 0
    ) {
      throw new Error('Loop Runtime rebuild Run transition is invalid');
    }
    return;
  }

  if (previousRun === null) {
    if (
      previousState.run_id !== null ||
      previousState.phase !== 'shape' ||
      nextRun.iteration !== 1 ||
      Object.keys(nextRun.retries).length !== 0
    ) {
      throw new Error('Loop transition journal first Run transition is invalid');
    }
    return;
  }

  assertLoopRunMetadata(previousRun, 'previous Run', true);
  assertCommittableRun(previousRun, 'previous Run');
  if (
    previousState.run_id !== previousRun.runId ||
    previousRun.currentStep !== previousState.phase ||
    nextState.run_id !== previousRun.runId
  ) {
    throw new Error('Loop transition journal previous Run does not match the change state');
  }
  if (nextRun.iteration !== previousRun.iteration + 1) {
    throw new Error('Loop transition journal next Run iteration must advance exactly once');
  }
  if (!isDeepStrictEqual(runInvariantProjection(previousRun), runInvariantProjection(nextRun))) {
    throw new Error('Loop transition journal Run identity or storage invariants changed');
  }
}

function specRebaseEvidenceHash(
  name: string,
  summary: string,
  specChanges: LoopReadableChangeState['spec_changes'],
): string {
  return sha256Text(
    JSON.stringify({
      operation: 'spec-rebase',
      change: name,
      summary,
      specChanges,
    }),
  );
}

function inferredLegacyTransitionOperation(
  previousState: LoopReadableChangeState,
  nextState: LoopReadableChangeState,
  event: LoopTransitionEventData,
): LoopTransitionOperation {
  return previousState.phase !== 'shape' &&
    nextState.phase === 'build' &&
    event.verificationResult === null
    ? 'spec-rebase'
    : 'advance';
}

function currentStateRefs(
  state: LoopReadableChangeState,
): Pick<
  LoopChangeState,
  'implementation_scope' | 'verification_evidence' | 'partial_allowance'
> | null {
  return 'implementation_scope' in state
    ? {
        implementation_scope: state.implementation_scope,
        verification_evidence: state.verification_evidence,
        partial_allowance: state.partial_allowance,
      }
    : null;
}

function validateTransitionStateSemantics(
  previousState: LoopReadableChangeState,
  nextState: LoopReadableChangeState,
  envelope: ReturnType<typeof validateJournalEnvelope>,
  operation: LoopTransitionOperation,
  legacyOperation = false,
): void {
  const event = envelope.eventData;
  const previousRefs = currentStateRefs(previousState);
  const nextRefs = currentStateRefs(nextState);
  if (event.previousPhase !== previousState.phase || event.nextPhase !== nextState.phase) {
    throw new Error('Loop transition journal event phases do not match its states');
  }
  if (previousState.archived || nextState.archived) {
    throw new Error('Loop transition journal cannot mutate an archived change');
  }

  if (operation === 'runtime-rebuild') {
    const sameDurableIdentity =
      previousState.name === nextState.name &&
      previousState.language === nextState.language &&
      previousState.brief === nextState.brief &&
      previousState.approval === nextState.approval &&
      ('approved_contract_hash' in previousState
        ? 'approved_contract_hash' in nextState &&
          previousState.approved_contract_hash === nextState.approved_contract_hash
        : !('approved_contract_hash' in nextState)) &&
      previousState.created_at === nextState.created_at &&
      isDeepStrictEqual(previousState.spec_changes, nextState.spec_changes);
    if (
      previousState.phase === 'shape' ||
      nextState.phase !== 'build' ||
      nextState.verification_result !== 'pending' ||
      nextState.verification_report !== null ||
      event.verificationResult !== null ||
      event.artifacts.length !== 0 ||
      event.noCodeReason !== null ||
      !sameDurableIdentity ||
      nextRefs === null ||
      nextRefs.implementation_scope !== null ||
      nextRefs.verification_evidence !== null ||
      nextRefs.partial_allowance !== null
    ) {
      throw new Error('Loop Runtime rebuild transition semantics are invalid');
    }
    return;
  }

  if (operation === 'evidence-retreat') {
    const sameIdentity =
      previousState.name === nextState.name &&
      previousState.language === nextState.language &&
      previousState.brief === nextState.brief &&
      previousState.approval === nextState.approval &&
      ('approved_contract_hash' in previousState
        ? 'approved_contract_hash' in nextState &&
          previousState.approved_contract_hash === nextState.approved_contract_hash
        : !('approved_contract_hash' in nextState)) &&
      previousState.created_at === nextState.created_at &&
      previousState.run_id === nextState.run_id &&
      isDeepStrictEqual(previousState.spec_changes, nextState.spec_changes);
    const expectedHash = loopAdvanceEvidenceHash({
      summary: event.summary,
      ...(event.returnToBuild ? { returnToBuild: true } : {}),
    });
    const validSourcePhase =
      (previousState.phase === 'archive' && previousState.verification_result === 'pass') ||
      (previousState.phase === 'verify' && previousState.verification_result === 'pending');
    if (
      !validSourcePhase ||
      nextState.phase !== 'build' ||
      nextState.verification_result !== 'pending' ||
      nextState.verification_report !== null ||
      event.verificationResult !== null ||
      event.artifacts.length !== 0 ||
      event.noCodeReason !== null ||
      envelope.evidenceHash !== expectedHash ||
      !sameIdentity ||
      previousRefs === null ||
      nextRefs === null ||
      nextRefs.implementation_scope !== null ||
      nextRefs.verification_evidence !== null ||
      nextRefs.partial_allowance !== null
    ) {
      throw new Error('Loop transition journal evidence retreat semantics are invalid');
    }
    return;
  }

  if (operation === 'spec-rebase') {
    const currentHash = specRebaseEvidenceHash(
      previousState.name,
      event.summary,
      nextState.spec_changes,
    );
    const legacyHash = sha256Text(`spec-rebase:${previousState.name}:${event.summary}`);
    if (
      previousState.phase === 'shape' ||
      nextState.phase !== 'build' ||
      event.verificationResult !== null ||
      event.artifacts.length !== 0 ||
      event.noCodeReason !== null ||
      nextState.verification_result !== 'pending' ||
      nextState.verification_report !== null ||
      (!legacyOperation && envelope.evidenceHash !== currentHash) ||
      (legacyOperation &&
        envelope.evidenceHash !== currentHash &&
        envelope.evidenceHash !== legacyHash) ||
      ('implementation_scope' in nextState &&
        (nextState.implementation_scope !== null ||
          nextState.verification_evidence !== null ||
          nextState.partial_allowance !== null))
    ) {
      throw new Error('Loop transition journal spec rebase semantics are invalid');
    }
    return;
  }

  if (previousState.phase === 'shape') {
    if (
      nextState.phase !== 'build' ||
      event.verificationResult !== null ||
      event.artifacts.length !== 0 ||
      event.noCodeReason !== null ||
      previousState.verification_result !== 'pending' ||
      nextState.verification_result !== 'pending' ||
      previousState.verification_report !== null ||
      nextState.verification_report !== null ||
      (previousRefs !== null &&
        nextRefs !== null &&
        (previousRefs.implementation_scope !== null ||
          previousRefs.verification_evidence !== null ||
          previousRefs.partial_allowance !== null ||
          nextRefs.implementation_scope !== null ||
          nextRefs.verification_evidence !== null ||
          nextRefs.partial_allowance !== null))
    ) {
      throw new Error('Loop transition journal Shape to Build semantics are invalid');
    }
    return;
  }

  if (previousState.phase === 'build') {
    if (
      nextState.phase !== 'verify' ||
      event.verificationResult !== null ||
      (event.artifacts.length === 0 && event.noCodeReason === null) ||
      nextState.verification_result !== 'pending' ||
      nextState.verification_report !== null ||
      (previousRefs !== null &&
        nextRefs !== null &&
        (nextRefs.implementation_scope === null ||
          nextRefs.verification_evidence !== null ||
          (nextRefs.implementation_scope !== previousRefs.implementation_scope &&
            nextRefs.partial_allowance !== null &&
            nextRefs.partial_allowance === previousRefs.partial_allowance)))
    ) {
      throw new Error('Loop transition journal Build to Verify semantics are invalid');
    }
    return;
  }

  if (previousState.phase === 'verify') {
    const expectedNext = event.verificationResult === 'pass' ? 'archive' : 'build';
    if (
      (event.verificationResult !== 'pass' && event.verificationResult !== 'fail') ||
      nextState.phase !== expectedNext ||
      event.artifacts.length !== 0 ||
      event.noCodeReason !== null ||
      nextState.verification_result !== event.verificationResult ||
      nextState.verification_report === null ||
      (previousRefs !== null &&
        nextRefs !== null &&
        (previousRefs.implementation_scope === null ||
          nextRefs.implementation_scope !== previousRefs.implementation_scope ||
          nextRefs.partial_allowance !== previousRefs.partial_allowance ||
          previousRefs.verification_evidence !== null ||
          nextRefs.verification_evidence === null))
    ) {
      throw new Error('Loop transition journal Verify outcome semantics are invalid');
    }
    return;
  }

  throw new Error('Loop transition journal cannot advance from Archive');
}

export function parseLoopTransitionJournalValue(
  value: unknown,
  expectedName: string,
): LoopTransitionJournal {
  const journal = journalRecord(value);
  rejectUnknownJournalFields(journal, CURRENT_JOURNAL_KEYS);
  if (journal.schema !== LOOP_TRANSITION_SCHEMA) {
    throw new Error(`Expected Loop transition schema ${LOOP_TRANSITION_SCHEMA}`);
  }
  const minimumRuntimeVersion = positiveInteger(
    journal.minimum_runtime_version,
    'Loop transition minimum_runtime_version',
  );
  if (minimumRuntimeVersion > LOOP_RUNTIME_PROTOCOL_VERSION) {
    throw new Error(
      `Loop transition requires runtime protocol ${minimumRuntimeVersion}; current protocol is ${LOOP_RUNTIME_PROTOCOL_VERSION}`,
    );
  }
  if (minimumRuntimeVersion !== LOOP_RUNTIME_PROTOCOL_VERSION) {
    throw new Error(
      `Loop transition ${LOOP_TRANSITION_SCHEMA} minimum_runtime_version must be ${LOOP_RUNTIME_PROTOCOL_VERSION}`,
    );
  }
  const revision = positiveInteger(journal.revision, 'Loop transition revision');
  if (revision !== 1) throw new Error('Loop transition journal revision must be 1');
  if (
    journal.operation !== 'advance' &&
    journal.operation !== 'spec-rebase' &&
    journal.operation !== 'evidence-retreat' &&
    journal.operation !== 'runtime-rebuild'
  ) {
    throw new Error('Loop transition journal operation is invalid');
  }
  const envelope = validateJournalEnvelope(journal, expectedName);
  const previousState = parseLoopChangeValue(journal.previousState);
  const nextState = parseLoopChangeValue(journal.nextState);
  if (previousState.name !== expectedName || nextState.name !== expectedName) {
    throw new Error('Loop transition journal state mismatch');
  }
  validateTransitionStateSemantics(previousState, nextState, envelope, journal.operation);
  validateTransitionRunSemantics(previousState, nextState, envelope, false, journal.operation);
  if (nextState.revision !== previousState.revision + 1) {
    throw new Error('Loop transition journal state revision must advance exactly once');
  }
  return {
    schema: LOOP_TRANSITION_SCHEMA,
    minimum_runtime_version: LOOP_RUNTIME_PROTOCOL_VERSION,
    revision,
    operation: journal.operation,
    id: envelope.id,
    change: expectedName,
    evidenceHash: envelope.evidenceHash,
    createdAt: envelope.createdAt,
    previousState,
    nextState,
    previousRun: envelope.previousRun,
    nextRun: envelope.nextRun,
    eventData: envelope.eventData,
  };
}

export function parseLegacyLoopTransitionJournalValue(
  value: unknown,
  expectedName: string,
): LoopLegacyTransitionJournal {
  const journal = journalRecord(value);
  rejectUnknownJournalFields(journal, LEGACY_JOURNAL_KEYS);
  if (journal.schema !== LOOP_LEGACY_TRANSITION_SCHEMA) {
    throw new Error(`Expected Loop transition schema ${LOOP_LEGACY_TRANSITION_SCHEMA}`);
  }
  const envelope = validateJournalEnvelope(journal, expectedName, true);
  const previousState = parseLegacyLoopChangeValue(journal.previousState);
  const nextState = parseLegacyLoopChangeValue(journal.nextState);
  if (previousState.name !== expectedName || nextState.name !== expectedName) {
    throw new Error('Loop transition journal state mismatch');
  }
  validateTransitionStateSemantics(
    previousState,
    nextState,
    envelope,
    inferredLegacyTransitionOperation(previousState, nextState, envelope.eventData),
    true,
  );
  validateTransitionRunSemantics(previousState, nextState, envelope, true);
  return {
    schema: LOOP_LEGACY_TRANSITION_SCHEMA,
    id: envelope.id,
    change: expectedName,
    evidenceHash: envelope.evidenceHash,
    createdAt: envelope.createdAt,
    previousState,
    nextState,
    previousRun: envelope.previousRun,
    nextRun: envelope.nextRun,
    eventData: envelope.eventData,
  };
}

export function parseV2LoopTransitionJournalValue(
  value: unknown,
  expectedName: string,
): LoopV2TransitionJournal {
  const journal = journalRecord(value);
  rejectUnknownJournalFields(journal, V2_JOURNAL_KEYS);
  if (journal.schema !== LOOP_V2_TRANSITION_SCHEMA) {
    throw new Error(`Expected Loop transition schema ${LOOP_V2_TRANSITION_SCHEMA}`);
  }
  const minimumRuntimeVersion = positiveInteger(
    journal.minimum_runtime_version,
    'Loop v2 transition minimum_runtime_version',
  );
  if (minimumRuntimeVersion !== 2) {
    throw new Error(
      `Loop transition ${LOOP_V2_TRANSITION_SCHEMA} minimum_runtime_version must be 2`,
    );
  }
  const revision = positiveInteger(journal.revision, 'Loop v2 transition revision');
  if (revision !== 1) throw new Error('Loop v2 transition journal revision must be 1');
  const envelope = validateJournalEnvelope(journal, expectedName, true);
  const previousState = parseV2LoopChangeValue(journal.previousState);
  const nextState = parseV2LoopChangeValue(journal.nextState);
  if (previousState.name !== expectedName || nextState.name !== expectedName) {
    throw new Error('Loop v2 transition journal state mismatch');
  }
  validateTransitionStateSemantics(
    previousState,
    nextState,
    envelope,
    inferredLegacyTransitionOperation(previousState, nextState, envelope.eventData),
    true,
  );
  validateTransitionRunSemantics(previousState, nextState, envelope, true);
  if (nextState.revision !== previousState.revision + 1) {
    throw new Error('Loop v2 transition journal state revision must advance exactly once');
  }
  return {
    schema: LOOP_V2_TRANSITION_SCHEMA,
    minimum_runtime_version: 2,
    revision,
    id: envelope.id,
    change: expectedName,
    evidenceHash: envelope.evidenceHash,
    createdAt: envelope.createdAt,
    previousState,
    nextState,
    previousRun: envelope.previousRun,
    nextRun: envelope.nextRun,
    eventData: envelope.eventData,
  };
}

export function inspectLoopTransitionJournalValue(
  value: unknown,
  expectedName: string,
): LoopTransitionSchemaInspection {
  const journal = journalRecord(value);
  if (journal.schema === LOOP_TRANSITION_SCHEMA) {
    return { status: 'current', journal: parseLoopTransitionJournalValue(journal, expectedName) };
  }
  if (journal.schema === LOOP_LEGACY_TRANSITION_SCHEMA) {
    return {
      status: 'migration-required',
      journal: parseLegacyLoopTransitionJournalValue(journal, expectedName),
    };
  }
  if (journal.schema === LOOP_V2_TRANSITION_SCHEMA) {
    return {
      status: 'migration-required',
      journal: parseV2LoopTransitionJournalValue(journal, expectedName),
    };
  }
  throw new Error(`Unsupported Loop transition journal schema: ${String(journal.schema)}`);
}

export async function inspectPendingLoopTransitionSchema(
  paths: LoopProjectPaths,
  name: string,
): Promise<LoopTransitionSchemaInspection | null> {
  const file = loopTransitionJournalFile(paths, name);
  const storageRoot = loopStorageRoot(paths, file);
  await resolveContainedLoopPath(storageRoot, file);
  try {
    const snapshot = await readLoopProtectedFile({
      root: storageRoot,
      file,
      maxBytes: LOOP_TRANSITION_JOURNAL_MAX_BYTES,
      label: `Loop transition journal ${name}`,
    });
    return inspectLoopTransitionJournalValue(JSON.parse(snapshot.bytes.toString('utf8')), name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function inspectPendingLoopTransition(
  paths: LoopProjectPaths,
  name: string,
): Promise<LoopTransitionJournal | null> {
  const inspection = await inspectPendingLoopTransitionSchema(paths, name);
  if (!inspection) return null;
  if (inspection.status === 'migration-required') {
    throw new LoopTransitionMigrationRequiredError(name);
  }
  return inspection.journal;
}

export async function prepareLoopTransition(options: {
  paths: LoopProjectPaths;
  previousState: LoopChangeState;
  nextState: LoopChangeState;
  previousRun: LoopTransitionJournal['previousRun'];
  nextRun: LoopTransitionJournal['nextRun'];
  evidenceHash: string;
  eventData: Record<string, unknown>;
  operation?: LoopTransitionOperation;
  now?: Date;
  transitionId?: () => string;
}): Promise<LoopTransitionJournal> {
  if (await hasPendingLoopSchemaMigration(options.paths, options.nextState.name)) {
    throw new Error(
      `Loop schema migration is incomplete for ${options.nextState.name}; run doctor --repair`,
    );
  }
  await assertLoopTrajectoryHealthy(options.paths, options.nextState.name);
  const journal: LoopTransitionJournal = {
    schema: LOOP_TRANSITION_SCHEMA,
    minimum_runtime_version: LOOP_RUNTIME_PROTOCOL_VERSION,
    revision: 1,
    operation: options.operation ?? 'advance',
    id: options.transitionId?.() ?? randomUUID(),
    change: options.nextState.name,
    evidenceHash: options.evidenceHash,
    createdAt: (options.now ?? new Date()).toISOString(),
    previousState: options.previousState,
    nextState: options.nextState,
    previousRun: options.previousRun,
    nextRun: options.nextRun,
    eventData: options.eventData,
  };
  const validated = parseLoopTransitionJournalValue(journal, journal.change);
  const file = loopTransitionJournalFile(options.paths, validated.change);
  const storageRoot = loopStorageRoot(options.paths, file);
  await resolveContainedLoopPath(storageRoot, file);
  if (await inspectPendingLoopTransition(options.paths, validated.change)) {
    throw new Error(`Loop transition recovery is already pending for ${validated.change}`);
  }
  await atomicWriteJson(file, validated, { containedRoot: storageRoot });
  return validated;
}

function assertRunRecoverySource(
  actual: Awaited<ReturnType<typeof readLoopRunState>>,
  journal: LoopTransitionJournal,
): 'previous' | 'next' {
  if (sameValue(actual, journal.nextRun)) return 'next';
  if (journal.previousRun === null) {
    if (actual === null) return 'previous';
  } else if (sameValue(actual, journal.previousRun)) {
    return 'previous';
  }
  throw new Error(
    `Loop transition Run content changed for ${journal.change}; recovery journal was preserved`,
  );
}

function assertChangeRecoverySource(
  actual: LoopChangeState,
  journal: LoopTransitionJournal,
): 'previous' | 'next' {
  if (sameValue(actual, journal.nextState)) return 'next';
  if (sameValue(actual, journal.previousState)) return 'previous';
  throw new Error(
    `Loop transition change content changed for ${journal.change}; recovery journal was preserved`,
  );
}

function expectedTrajectoryEvent(options: {
  sequence: number;
  journal: LoopTransitionJournal;
  type: 'run_started' | 'state_transitioned';
}): ReturnType<typeof trajectoryEventForComparison> {
  const { journal } = options;
  return trajectoryEventForComparison({
    sequence: options.sequence,
    timestamp: journal.createdAt,
    type: options.type,
    runId: journal.nextRun.runId,
    data:
      options.type === 'run_started'
        ? {
            runtime: 'owner-loop',
            phase: journal.previousState.phase,
            transitionId: journal.id,
          }
        : { ...journal.eventData, transitionId: journal.id },
  });
}

function trajectoryEventForComparison(event: {
  sequence: number;
  timestamp: string;
  type: string;
  runId: string;
  data: Record<string, unknown>;
}): {
  sequence: number;
  timestamp: string;
  type: string;
  runId: string;
  data: Record<string, unknown>;
} {
  return {
    sequence: event.sequence,
    timestamp: event.timestamp,
    type: event.type,
    runId: event.runId,
    data: event.data,
  };
}

function inspectExistingTransitionEvents(
  trajectory: Awaited<ReturnType<typeof readLoopTrajectory>>,
  journal: LoopTransitionJournal,
): {
  started: (typeof trajectory)[number] | null;
  transitioned: (typeof trajectory)[number] | null;
} {
  const collisions = trajectory
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.data.transitionId === journal.id);
  const started = collisions.filter(({ event }) => event.type === 'run_started');
  const transitioned = collisions.filter(({ event }) => event.type === 'state_transitioned');
  if (
    collisions.length !== started.length + transitioned.length ||
    started.length > (journal.previousRun === null ? 1 : 0) ||
    transitioned.length > 1 ||
    (journal.previousRun === null &&
      transitioned.length === 1 &&
      (started.length !== 1 || started[0].index >= transitioned[0].index))
  ) {
    throw new Error(
      `Loop trajectory transition id collision for ${journal.change}; recovery journal was preserved`,
    );
  }
  for (const item of [...started, ...transitioned]) {
    const expected = expectedTrajectoryEvent({
      sequence: item.index + 1,
      journal,
      type: item.event.type as 'run_started' | 'state_transitioned',
    });
    if (!sameValue(trajectoryEventForComparison(item.event), expected)) {
      throw new Error(
        `Loop trajectory event changed for transition ${journal.id}; recovery journal was preserved`,
      );
    }
  }
  return {
    started: started[0]?.event ?? null,
    transitioned: transitioned[0]?.event ?? null,
  };
}

export async function continueLoopTransitionLocked(
  paths: LoopProjectPaths,
  name: string,
  hooks?: LoopTransitionHooks,
): Promise<LoopChangeState | null> {
  if (await hasPendingLoopSchemaMigration(paths, name)) {
    throw new Error(`Loop schema migration is incomplete for ${name}; run doctor --repair`);
  }
  await assertLoopTrajectoryHealthy(paths, name);
  const journal = await inspectPendingLoopTransition(paths, name);
  if (!journal) return null;
  const runtimeDir = loopChangeRuntimeDir(paths, name);
  const initialEvents = inspectExistingTransitionEvents(
    await readLoopTrajectory(runtimeDir, journal.nextRun.trajectoryRef),
    journal,
  );
  const [actualRun, actualChange] = await Promise.all([
    readLoopRunState(runtimeDir),
    readLoopChange(paths, name),
  ]);
  const runSource = assertRunRecoverySource(actualRun, journal);
  const changeSource = assertChangeRecoverySource(actualChange, journal);
  if (
    (initialEvents.started || initialEvents.transitioned) &&
    (runSource !== 'next' || changeSource !== 'next')
  ) {
    throw new Error(
      `Loop trajectory is ahead of transition state for ${journal.change}; recovery journal was preserved`,
    );
  }

  if (runSource === 'previous') {
    await writeLoopRunState(runtimeDir, journal.nextRun);
    await hooks?.afterRunStateWritten?.(journal);
  }
  if (!sameValue(await readLoopRunState(runtimeDir), journal.nextRun)) {
    throw new Error(
      `Loop transition Run content changed while continuing ${journal.change}; recovery journal was preserved`,
    );
  }
  if (changeSource === 'previous') {
    const persisted = await compareAndSwapLoopChangeLocked(
      paths,
      journal.nextState,
      journal.previousState.revision,
    );
    if (!sameValue(persisted, journal.nextState)) {
      throw new Error(
        `Loop transition change write diverged for ${journal.change}; recovery journal was preserved`,
      );
    }
    await hooks?.afterChangeStateWritten?.(journal);
  }
  if (!sameValue(await readLoopChange(paths, name), journal.nextState)) {
    throw new Error(
      `Loop transition change content changed while continuing ${journal.change}; recovery journal was preserved`,
    );
  }
  const activeJournal = await inspectPendingLoopTransition(paths, name);
  if (!activeJournal || !sameValue(activeJournal, journal)) {
    throw new Error(
      `Loop transition journal changed while continuing ${journal.change}; it was preserved`,
    );
  }

  const existingEvents = inspectExistingTransitionEvents(
    await readLoopTrajectory(runtimeDir, journal.nextRun.trajectoryRef),
    journal,
  );
  if (journal.previousRun === null) {
    if (!existingEvents.started) {
      await appendLoopTrajectoryEvent({
        changeDir: runtimeDir,
        run: journal.nextRun,
        type: 'run_started',
        data: {
          runtime: 'owner-loop',
          phase: journal.previousState.phase,
          transitionId: journal.id,
        },
        now: new Date(journal.createdAt),
      });
    }
  }
  let event = existingEvents.transitioned;
  if (!event) {
    event = await appendLoopTrajectoryEvent({
      changeDir: runtimeDir,
      run: journal.nextRun,
      type: 'state_transitioned',
      data: { ...journal.eventData, transitionId: journal.id },
      now: new Date(journal.createdAt),
    });
  }
  await writeLoopCheckpoint({
    changeDir: runtimeDir,
    run: journal.nextRun,
    trajectoryOffset: event.sequence,
    evidenceHash: journal.evidenceHash,
    now: new Date(journal.createdAt),
  });
  const [finalRun, finalChange] = await Promise.all([
    readLoopRunState(runtimeDir),
    readLoopChange(paths, name),
  ]);
  assertRunRecoverySource(finalRun, { ...journal, previousRun: journal.nextRun });
  assertChangeRecoverySource(finalChange, {
    ...journal,
    previousState: journal.nextState,
  });
  const finalJournal = await inspectPendingLoopTransition(paths, name);
  if (!finalJournal || !sameValue(finalJournal, journal)) {
    throw new Error(
      `Loop transition journal changed while continuing ${journal.change}; it was not removed`,
    );
  }
  await fs.rm(loopTransitionJournalFile(paths, name), { force: true });
  return journal.nextState;
}

export async function continueLoopTransition(
  paths: LoopProjectPaths,
  name: string,
  hooks?: LoopTransitionHooks,
): Promise<LoopChangeState | null> {
  return withLoopMutationLock(paths, `continue transition ${name}`, () =>
    withLoopTransitionLock(paths, name, `continue transition ${name}`, () =>
      continueLoopTransitionLocked(paths, name, hooks),
    ),
  );
}
