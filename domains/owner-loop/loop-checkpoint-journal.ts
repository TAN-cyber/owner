import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';

import { compareAndSwapLoopChangeLocked } from './loop-change.js';
import {
  loopCheckpointJournalFile,
  readLoopCheckpointJournal,
  writeLoopCheckpointJournal,
  writeLoopCheckpointManifest,
  writeLoopProgressCheckpoint,
} from './loop-checkpoint-storage.js';
import type {
  LoopChangeState,
  LoopCheckpointHooks,
  LoopCheckpointJournal,
  LoopCheckpointManifest,
  LoopProgressCheckpoint,
  LoopProjectPaths,
} from './loop-types.js';
import { withLoopMutationLock } from './loop-mutation-lock.js';
import { continueLoopTransitionLocked, withLoopTransitionLock } from './loop-transition-journal.js';

export async function prepareLoopCheckpointJournal(options: {
  paths: LoopProjectPaths;
  previousState: LoopChangeState;
  nextState: LoopChangeState;
  checkpoint: LoopProgressCheckpoint;
  manifest: LoopCheckpointManifest;
  now?: Date;
  checkpointId?: () => string;
}): Promise<LoopCheckpointJournal> {
  const createdAt = (options.now ?? new Date()).toISOString();
  const id = options.checkpointId?.() ?? randomUUID();
  const checkpoint: LoopProgressCheckpoint = {
    ...options.checkpoint,
    id,
    createdAt,
  };
  const journal: LoopCheckpointJournal = {
    schema: 'owner.loop.checkpoint-journal.v1',
    id,
    change: options.previousState.name,
    inputHash: checkpoint.inputHash,
    createdAt,
    previousState: options.previousState,
    nextState: options.nextState,
    checkpoint,
    manifest: options.manifest,
  };
  await writeLoopCheckpointManifest(options.paths, options.previousState.name, options.manifest);
  await writeLoopCheckpointJournal(options.paths, journal);
  return journal;
}

export async function continueLoopCheckpointLocked(
  paths: LoopProjectPaths,
  name: string,
  hooks?: LoopCheckpointHooks,
): Promise<LoopCheckpointJournal | null> {
  const journal = await readLoopCheckpointJournal(paths, name);
  if (!journal) return null;
  const manifestHash = await writeLoopCheckpointManifest(paths, journal.change, journal.manifest);
  if (manifestHash !== journal.checkpoint.manifestHash) {
    throw new Error('Loop checkpoint recovery manifest hash mismatch');
  }
  await compareAndSwapLoopChangeLocked(paths, journal.nextState, journal.previousState.revision, {
    allowPendingCheckpointRecovery: true,
  });
  await hooks?.afterStateWritten?.(journal);
  await writeLoopProgressCheckpoint(paths, journal.checkpoint);
  await hooks?.afterProgressWritten?.(journal);
  await fs.rm(loopCheckpointJournalFile(paths, name), { force: true });
  return journal;
}

export async function continueLoopCheckpoint(
  paths: LoopProjectPaths,
  name: string,
  hooks?: LoopCheckpointHooks,
): Promise<LoopCheckpointJournal | null> {
  return withLoopMutationLock(paths, `continue checkpoint ${name}`, () =>
    withLoopTransitionLock(paths, name, `continue checkpoint ${name}`, async () => {
      await continueLoopTransitionLocked(paths, name);
      return continueLoopCheckpointLocked(paths, name, hooks);
    }),
  );
}
