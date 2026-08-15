import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { isDeepStrictEqual } from 'util';

import { decideWithResolver, recordOutcomeWithResolver } from '../engine/loop.js';
import {
  canonicalSpecPath,
  resolveLoopArtifactFile,
  validateLoopBrief,
  validateLoopVerification,
} from './loop-artifacts.js';
import { readLoopRunState, readLoopTrajectory, writeLoopRunState } from './loop-run-store.js';
import { inspectLoopArchivePreflight } from './loop-archive-inspection.js';
import type { LoopArchivePreflight } from './loop-archive-preflight.js';
import { hashLoopArchiveTree, inspectLoopArchiveContent } from './loop-archive-content.js';
import {
  applyLoopArchiveTransactionV2,
  createLoopArchiveTransactionV2,
  finalizeLoopArchiveTransactionV2,
  readLoopArchiveTransactionV2,
  rollbackLoopArchiveTransactionV2,
  type LoopArchiveTransactionHooksV2,
} from './loop-archive-transaction.js';
import {
  LOOP_CHANGE_STATE_FILE,
  loopChangeDir,
  readLoopChange,
  readLoopChangeFile,
  writeLoopChangeFile,
} from './loop-change.js';
import { settleLoopChangeJournalsLocked } from './loop-change-recovery.js';
import { writeLoopEvidenceProjection } from './loop-evidence-projection.js';
import { sha256File, sha256Text } from './loop-hash.js';
import { acquireLoopLock, releaseLoopLock } from './loop-lock.js';
import { withLoopMutationLock } from './loop-mutation-lock.js';
import {
  inspectLoopRuntimeStorage,
  loopChangeRuntimeDir,
  loopPreferredChangeRuntimeDir,
  resolveContainedLoopPath,
} from './loop-paths.js';
import { copyLoopProtectedFile } from './loop-protected-file.js';
import { LOOP_RUNTIME_PACKAGE, loopPhaseResolver } from './loop-runtime-package.js';
import { clearLoopSelectionIfLocked } from './loop-selection.js';
import {
  applyLoopTransaction,
  finalizeLoopTransaction,
  loopRootRef,
  readLoopTransaction,
  readLoopTransactionEvents,
  resolveLoopTransactionPaths,
  rollbackLoopTransaction,
  type LoopArchiveTransactionJournalV2,
  type LoopArchiveTransactionOperationV2,
} from './loop-transaction.js';
import { appendLoopTrajectoryEvent, writeLoopCheckpoint } from './loop-trajectory.js';
import { withLoopTransitionLock } from './loop-transition-journal.js';
import type {
  LoopChangeState,
  LoopProjectPaths,
  LoopSpecChange,
  LoopTransactionJournal,
} from './loop-types.js';
import { inspectLoopVerificationFreshness } from './loop-verification-runtime.js';

type AnyArchiveTransactionJournal = LoopTransactionJournal | LoopArchiveTransactionJournalV2;

const LOOP_ARCHIVE_COPY_MAX_BYTES = 16 * 1024 * 1024;

export class LoopSpecConflictError extends Error {
  readonly code = 'loop-spec-conflict';

  constructor(
    readonly capability: string,
    readonly expectedHash: string | null,
    readonly actualHash: string | null,
    readonly canonicalPath: string,
  ) {
    super(
      `Canonical spec conflict for ${capability}: expected ${expectedHash ?? '(missing)'}, actual ${actualHash ?? '(missing)'}`,
    );
    this.name = 'LoopSpecConflictError';
  }
}

export class LoopArchivePreflightError extends Error {
  readonly code = 'loop-archive-preflight';

  constructor(
    readonly preflight: LoopArchivePreflight,
    message = preflight.ready
      ? 'Loop Archive preflight no longer matches the expected hash'
      : `Loop Archive preflight is blocked: ${preflight.findingCodes.join(', ')}`,
  ) {
    super(message);
    this.name = 'LoopArchivePreflightError';
  }
}

async function optionalHash(file: string): Promise<string | null> {
  try {
    return await sha256File(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function assertArchiveReady(state: LoopChangeState): void {
  if (state.phase !== 'archive') throw new Error(`Loop change ${state.name} is not in Archive`);
  if (state.verification_result !== 'pass') {
    throw new Error(`Loop change ${state.name} has not passed verification`);
  }
  if (!state.verification_report) {
    throw new Error(`Loop change ${state.name} has no verification report`);
  }
  if (state.archived) throw new Error(`Loop change ${state.name} is already archived`);
}

async function assertArchiveArtifacts(
  paths: LoopProjectPaths,
  state: LoopChangeState,
): Promise<void> {
  const changeDir = loopChangeDir(paths, state.name);
  const brief = await validateLoopBrief(changeDir, state.brief);
  const verification = await validateLoopVerification(changeDir, state.verification_report!);
  const findings = [...brief.findings, ...verification.findings];
  if (findings.length > 0) {
    throw new Error(`Loop archive artifacts are invalid: ${findings[0].message}`);
  }
}

async function assertSpecBase(paths: LoopProjectPaths, change: LoopSpecChange): Promise<void> {
  const canonical = canonicalSpecPath(paths, change.capability);
  await resolveContainedLoopPath(paths.loopRoot, canonical);
  const actual = await optionalHash(canonical);
  const expected = change.operation === 'create' ? null : change.base_hash;
  if (actual !== expected) {
    throw new LoopSpecConflictError(change.capability, expected, actual, canonical);
  }
}

function archiveTarget(paths: LoopProjectPaths, name: string, now: Date): string {
  return path.join(paths.archiveDir, `${now.toISOString().slice(0, 10)}-${name}`);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function buildArchiveJournal(options: {
  paths: LoopProjectPaths;
  state: LoopChangeState;
  now: Date;
  transactionId: string;
  preflight: LoopArchivePreflight;
  hooks?: LoopArchiveTransactionHooksV2;
}): Promise<LoopArchiveTransactionJournalV2> {
  const { paths, state, now, transactionId, preflight } = options;
  const target = archiveTarget(paths, state.name, now);
  if (await pathExists(target)) throw new Error(`Loop archive target already exists: ${target}`);
  if (loopRootRef(paths, target) !== preflight.targetRef) {
    throw new Error('Loop Archive target changed after preflight');
  }

  const tx = await resolveLoopTransactionPaths(paths, transactionId);
  const operations: LoopArchiveTransactionOperationV2[] = [];
  for (const [index, change] of state.spec_changes.entries()) {
    await assertSpecBase(paths, change);
    const canonical = canonicalSpecPath(paths, change.capability);
    const preview = preflight.operations.find(
      (operation) =>
        operation.capability === change.capability && operation.operation === change.operation,
    );
    if (!preview) {
      throw new Error(`Loop Archive preflight has no operation for ${change.capability}`);
    }
    if (change.operation !== 'remove' && preview.proposedHash === null) {
      throw new Error(`Loop Archive preflight has no proposed hash for ${change.capability}`);
    }
    const backup = path.join(tx.backups, 'specs', change.capability, 'spec.md');
    if (change.operation === 'remove') {
      operations.push({
        id: `spec-${index + 1}-${change.capability}`,
        type: 'remove',
        target: loopRootRef(paths, canonical),
        backup: loopRootRef(paths, backup),
        expectedTargetHash: change.base_hash,
      });
      continue;
    }
    const changeDir = loopChangeDir(paths, state.name);
    await resolveLoopArtifactFile(changeDir, change.source!);
    const source = path.resolve(changeDir, ...change.source!.split(/[\\/]/u));
    const staged = path.join(tx.staged, 'specs', change.capability, 'spec.md');
    const stagedSnapshot = await copyLoopProtectedFile({
      sourceRoot: changeDir,
      source,
      targetRoot: paths.runtimeDir,
      target: staged,
      maxBytes: LOOP_ARCHIVE_COPY_MAX_BYTES,
      label: `Loop Archive proposed spec ${change.capability}`,
      expectedHash: preview.proposedHash!,
      expectedTargetHash: null,
      exclusive: true,
      hooks: {
        afterParentChainCaptured: () =>
          options.hooks?.afterProtectedCopySourceParentCaptured?.('stage', change.source!),
      },
    });
    const stagedHash = stagedSnapshot.hash;
    if (stagedHash !== preview.proposedHash) {
      throw new Error(`Proposed Loop spec changed after preflight: ${change.capability}`);
    }
    operations.push({
      id: `spec-${index + 1}-${change.capability}`,
      type: 'write',
      target: loopRootRef(paths, canonical),
      staged: loopRootRef(paths, staged),
      ...(change.operation === 'replace' ? { backup: loopRootRef(paths, backup) } : {}),
      expectedTargetHash: change.operation === 'create' ? null : change.base_hash,
      stagedHash,
    });
  }
  const source = loopChangeDir(paths, state.name);
  operations.push({
    id: 'archive-change',
    type: 'move',
    source: loopRootRef(paths, source),
    target: loopRootRef(paths, target),
    expectedSourceHash: await hashLoopArchiveTree(source),
    expectedTargetHash: null,
  });
  return {
    schema: 'owner.loop.transaction.v2',
    id: transactionId,
    kind: 'archive',
    status: 'prepared',
    change: state.name,
    createdAt: now.toISOString(),
    preflightHash: preflight.preflightHash,
    operations,
  };
}

function archiveDirectoryFromJournal(
  paths: LoopProjectPaths,
  journal: AnyArchiveTransactionJournal,
): string {
  const operation = journal.operations.find((item) => item.id === 'archive-change');
  if (!operation || operation.type !== 'move') {
    throw new Error(`Archive transaction ${journal.id} has no archive move`);
  }
  return path.resolve(paths.loopRoot, ...operation.target.split('/'));
}

async function finalizeArchive(
  paths: LoopProjectPaths,
  journal: AnyArchiveTransactionJournal,
  hooks?: LoopArchiveTransactionHooksV2,
): Promise<void> {
  const events = await readLoopTransactionEvents(paths, journal.id);
  if (events.some((event) => event.type === 'archive-finalized')) return;
  const finalizationStarted = events.some((event) => event.type === 'archive-finalization-started');
  if (journal.schema === 'owner.loop.transaction.v2' && !finalizationStarted) {
    const move = journal.operations.find((operation) => operation.id === 'archive-change');
    if (!move || move.type !== 'move' || !move.expectedSourceHash) {
      throw new Error(`Archive transaction ${journal.id} has no content-bound archive move`);
    }
    const archiveContent = await inspectLoopArchiveContent(
      archiveDirectoryFromJournal(paths, journal),
    );
    if (archiveContent?.kind !== 'directory' || archiveContent.hash !== move.expectedSourceHash) {
      throw new Error(
        `Loop Archive content changed before finalization for transaction ${journal.id}`,
      );
    }
  }
  const archiveDir = archiveDirectoryFromJournal(paths, journal);
  const stateFile = path.join(archiveDir, LOOP_CHANGE_STATE_FILE);
  const state = await readLoopChangeFile(stateFile);
  if (!journal.change || state.name !== journal.change) {
    throw new Error(`Archive transaction ${journal.id} change mismatch`);
  }
  const runtimeDir = loopChangeRuntimeDir(paths, state.name);
  const run = await readLoopRunState(runtimeDir);
  if (
    !run ||
    run.runId !== state.run_id ||
    (run.currentStep !== 'archive' && !(run.currentStep === null && run.status === 'completed'))
  ) {
    throw new Error(`Loop archive Run state is missing or inconsistent for ${state.name}`);
  }
  let completed = run;
  if (run.currentStep === 'archive') {
    const decision = decideWithResolver(
      LOOP_RUNTIME_PACKAGE,
      run,
      new Set(),
      loopPhaseResolver,
      undefined,
    );
    if (!decision.action) throw new Error(decision.reason ?? 'Loop archive produced no action');
    completed = recordOutcomeWithResolver(
      LOOP_RUNTIME_PACKAGE,
      decision.state,
      {
        actionId: decision.action.id,
        status: 'succeeded',
        summary: `Archived Loop change ${state.name}`,
      },
      loopPhaseResolver,
      undefined,
    );
  }
  const evidenceHash = sha256Text(`archive:${journal.id}:${state.name}`);
  const trajectory = await readLoopTrajectory(runtimeDir, completed.trajectoryRef);
  const transactionEvents = trajectory.filter((item) => item.data.transactionId === journal.id);
  if (
    journal.schema === 'owner.loop.transaction.v2' &&
    (transactionEvents.length > 1 ||
      transactionEvents.some((item) => item.type !== 'state_transitioned'))
  ) {
    throw new Error(`Loop Archive trajectory has a transaction id collision: ${journal.id}`);
  }
  let event = transactionEvents.find((item) => item.type === 'state_transitioned');
  const eventData = {
    previousPhase: 'archive',
    nextPhase: null,
    evidenceHash,
    summary: `Archived Loop change ${state.name}`,
    transactionId: journal.id,
  };
  if (
    event &&
    journal.schema === 'owner.loop.transaction.v2' &&
    (!isDeepStrictEqual(event.data, eventData) ||
      event.runId !== completed.runId ||
      event.timestamp !== journal.createdAt ||
      event !== trajectory.at(-1))
  ) {
    throw new Error(`Loop Archive trajectory event changed for transaction ${journal.id}`);
  }
  if (
    !finalizationStarted &&
    (state.archived || run.currentStep === null || transactionEvents.length > 0)
  ) {
    throw new Error(
      `Loop Archive finalization state changed before its irreversible marker: ${journal.id}`,
    );
  }

  // Everything above is read-only and repeatable. Only after the state, Run and trajectory have
  // been proven coherent do we cross the transaction's no-rollback boundary.
  if (!finalizationStarted) {
    if (journal.schema === 'owner.loop.transaction.v2') {
      await finalizeLoopArchiveTransactionV2(paths, journal, 'archive-finalization-started');
      await hooks?.afterFinalizationStarted?.(journal);
    } else {
      await finalizeLoopTransaction(paths, journal, 'archive-finalization-started');
    }
  }
  if (!state.archived) {
    const updated = { ...state, archived: true };
    await writeLoopChangeFile(stateFile, updated);
  }
  if (!event) {
    event = await appendLoopTrajectoryEvent({
      changeDir: runtimeDir,
      run: completed,
      type: 'state_transitioned',
      data: eventData,
      ...(journal.schema === 'owner.loop.transaction.v2'
        ? { now: new Date(journal.createdAt) }
        : {}),
    });
  }
  await writeLoopCheckpoint({
    changeDir: runtimeDir,
    run: completed,
    trajectoryOffset: event.sequence,
    evidenceHash,
    ...(journal.schema === 'owner.loop.transaction.v2' ? { now: new Date(journal.createdAt) } : {}),
  });
  await writeLoopRunState(runtimeDir, completed);
  await clearLoopSelectionIfLocked(paths, state.name);
  if (journal.schema === 'owner.loop.transaction.v2') {
    await finalizeLoopArchiveTransactionV2(paths, journal, 'archive-finalized');
  } else {
    await finalizeLoopTransaction(paths, journal, 'archive-finalized');
  }
}

async function cleanupArchivedLoopRuntime(
  paths: LoopProjectPaths,
  change: string,
): Promise<string | null> {
  const runtimeDir = loopPreferredChangeRuntimeDir(paths, change);
  try {
    const stat = await fs.lstat(runtimeDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Loop Runtime cleanup target is not a real directory: ${runtimeDir}`);
    }
    await resolveContainedLoopPath(paths.runtimeDir, runtimeDir);
    await fs.rm(runtimeDir, { recursive: true, force: true });
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return `Archived change ${change}, but local Runtime cleanup failed: ${(error as Error).message}`;
  }
}

async function continueArchive(
  paths: LoopProjectPaths,
  journal: AnyArchiveTransactionJournal,
  hooks?: LoopArchiveTransactionHooksV2,
): Promise<{ journal: AnyArchiveTransactionJournal; runtimeCleanupWarning: string | null }> {
  if (journal.schema === 'owner.loop.transaction.v2') {
    const events = await readLoopTransactionEvents(paths, journal.id);
    if (!events.some((event) => event.type === 'operation-started')) {
      const preflight = await inspectLoopArchivePreflight({
        paths,
        name: journal.change,
        now: new Date(journal.createdAt),
      });
      if (!preflight.ready || preflight.preflightHash !== journal.preflightHash) {
        throw new LoopArchivePreflightError(
          preflight,
          'Loop Archive facts changed before the first transaction operation',
        );
      }
    }
    const applied = await applyLoopArchiveTransactionV2(paths, journal, {
      ...hooks,
      beforeArchiveChangeMove: async (operation) => {
        await hooks?.beforeArchiveChangeMove?.(operation);
        const state = await readLoopChange(paths, journal.change);
        const freshness = await inspectLoopVerificationFreshness({
          paths,
          state,
          now: new Date(journal.createdAt),
        });
        if (
          state.phase !== 'archive' ||
          state.archived ||
          state.verification_result !== 'pass' ||
          !['complete', 'partial'].includes(freshness.freshness) ||
          freshness.findingCodes.length > 0
        ) {
          throw new Error(
            `Loop Archive verification freshness changed before moving ${journal.change}: ${freshness.findingCodes.join(', ') || freshness.freshness}`,
          );
        }
      },
    });
    await finalizeArchive(paths, applied, hooks);
    const committed = await finalizeLoopArchiveTransactionV2(paths, applied, 'commit');
    return {
      journal: committed,
      runtimeCleanupWarning: await cleanupArchivedLoopRuntime(paths, committed.change),
    };
  }
  const applied = await applyLoopTransaction(paths, journal);
  await finalizeArchive(paths, applied, hooks);
  const committed = await finalizeLoopTransaction(paths, applied, 'commit');
  return {
    journal: committed,
    runtimeCleanupWarning: committed.change
      ? await cleanupArchivedLoopRuntime(paths, committed.change)
      : null,
  };
}

function assertMatchingJournal(
  paths: LoopProjectPaths,
  journal: AnyArchiveTransactionJournal,
): void {
  if (journal.kind !== 'archive') throw new Error(`Transaction ${journal.id} is not an archive`);
  if (journal.schema === 'owner.loop.transaction.v2') {
    if (!journal.change) throw new Error(`Archive transaction ${journal.id} has no change`);
    return;
  }
  if (
    path.resolve(journal.projectRoot) !== path.resolve(paths.projectRoot) ||
    path.resolve(journal.loopRoot) !== path.resolve(paths.loopRoot)
  ) {
    throw new Error(`Transaction ${journal.id} belongs to a different Loop root`);
  }
}

export async function archiveLoopChange(options: {
  paths: LoopProjectPaths;
  name: string;
  expectedPreflightHash: string;
  now?: Date;
  hooks?: LoopArchiveTransactionHooksV2;
}): Promise<{
  archiveDir: string;
  transactionId: string;
  preflightHash: string;
  runtimeCleanupWarning: string | null;
}> {
  return withLoopMutationLock(options.paths, `archive ${options.name}`, () =>
    withLoopTransitionLock(options.paths, options.name, `archive ${options.name}`, async () => {
      await settleLoopChangeJournalsLocked(options.paths, options.name);
      const lock = await acquireLoopLock(options.paths, 'archive', `archive ${options.name}`);
      try {
        if (!/^[a-f0-9]{64}$/u.test(options.expectedPreflightHash)) {
          throw new Error('Loop Archive expected preflight must be a SHA-256 hash');
        }
        const now = options.now ?? new Date();
        const preflight = await inspectLoopArchivePreflight({
          paths: options.paths,
          name: options.name,
          now,
        });
        if (!preflight.ready || preflight.preflightHash !== options.expectedPreflightHash) {
          throw new LoopArchivePreflightError(preflight);
        }
        const state = await readLoopChange(options.paths, options.name);
        assertArchiveReady(state);
        const runtimeStorage = await inspectLoopRuntimeStorage(options.paths, options.name);
        if (runtimeStorage.status !== 'available') {
          throw new Error(
            runtimeStorage.message ??
              `Loop Runtime is ${runtimeStorage.status}: ${runtimeStorage.path}`,
          );
        }
        if (runtimeStorage.layout === 'legacy') {
          throw new Error(
            `Loop Archive requires project-local Runtime; run owner loop doctor ${options.name} --repair`,
          );
        }
        await writeLoopEvidenceProjection(options.paths, state.name, { now: options.now });
        await assertArchiveArtifacts(options.paths, state);
        const transactionId = randomUUID();
        const journal = await buildArchiveJournal({
          paths: options.paths,
          state,
          now,
          transactionId,
          preflight,
          hooks: options.hooks,
        });
        await createLoopArchiveTransactionV2(options.paths, journal);
        await options.hooks?.afterPrepared?.(journal);
        const continued = await continueArchive(options.paths, journal, options.hooks);
        return {
          archiveDir: archiveDirectoryFromJournal(options.paths, journal),
          transactionId,
          preflightHash: preflight.preflightHash,
          runtimeCleanupWarning: continued.runtimeCleanupWarning,
        };
      } finally {
        await releaseLoopLock(lock);
      }
    }),
  );
}

export async function recoverArchiveTransaction(options: {
  paths: LoopProjectPaths;
  transactionId: string;
  strategy: 'continue' | 'rollback';
}): Promise<AnyArchiveTransactionJournal> {
  return withLoopMutationLock(
    options.paths,
    `recover archive ${options.transactionId}`,
    async () => {
      const lock = await acquireLoopLock(
        options.paths,
        'archive',
        `recover archive ${options.transactionId}`,
      );
      try {
        const generic = await readLoopTransaction(options.paths, options.transactionId);
        const journal: AnyArchiveTransactionJournal =
          (generic as unknown as { schema: string }).schema === 'owner.loop.transaction.v2'
            ? await readLoopArchiveTransactionV2(options.paths, options.transactionId)
            : generic;
        assertMatchingJournal(options.paths, journal);
        if (journal.status === 'committed') {
          if (journal.change) await cleanupArchivedLoopRuntime(options.paths, journal.change);
          return journal;
        }
        if (journal.status === 'rolled-back') return journal;
        return options.strategy === 'continue'
          ? (await continueArchive(options.paths, journal)).journal
          : journal.schema === 'owner.loop.transaction.v2'
            ? rollbackLoopArchiveTransactionV2(options.paths, journal)
            : rollbackLoopTransaction(options.paths, journal);
      } finally {
        await releaseLoopLock(lock);
      }
    },
    { allowedTransactionId: options.transactionId },
  );
}
