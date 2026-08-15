import { randomUUID } from 'crypto';

import { LoopChangeRevisionConflictError, readLoopChange } from './loop-change.js';
import { settleLoopChangeJournalsLocked } from './loop-change-recovery.js';
import {
  continueLoopCheckpointLocked,
  prepareLoopCheckpointJournal,
} from './loop-checkpoint-journal.js';
import {
  createLoopCheckpointManifest,
  hashLoopCheckpointManifest,
  loopCheckpointManifestRef,
  readLoopProgressCheckpoint,
} from './loop-checkpoint-storage.js';
import { loopContinuation } from './loop-continuation.js';
import { sha256Text } from './loop-hash.js';
import { withLoopMutationLock } from './loop-mutation-lock.js';
import { redactLoopCredentialText } from './loop-redaction.js';
import { withLoopTransitionLock } from './loop-transition-journal.js';
import type {
  LoopCheckpointHooks,
  LoopCheckpointResult,
  LoopProgressCheckpoint,
  LoopProjectPaths,
} from './loop-types.js';

function requiredText(value: string, label: string): string {
  const normalized = redactLoopCredentialText(value).trim();
  if (normalized.length === 0 || normalized.length > 2_000) {
    throw new Error(`${label} must be between 1 and 2000 characters`);
  }
  return normalized;
}

function expectedRevisionValue(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('Loop expected revision must be a positive integer');
  }
  return value;
}

export async function checkpointLoopChange(options: {
  paths: LoopProjectPaths;
  name: string;
  summary: string;
  nextAction: string;
  artifacts?: readonly string[];
  expectedRevision?: number;
  now?: Date;
  checkpointId?: () => string;
  hooks?: LoopCheckpointHooks;
}): Promise<LoopCheckpointResult> {
  const summary = requiredText(options.summary, 'Checkpoint summary');
  const nextAction = requiredText(options.nextAction, 'Checkpoint next action');
  const expectedRevision = expectedRevisionValue(options.expectedRevision);
  return withLoopMutationLock(options.paths, `checkpoint ${options.name}`, () =>
    withLoopTransitionLock(options.paths, options.name, `checkpoint ${options.name}`, async () => {
      await settleLoopChangeJournalsLocked(options.paths, options.name);
      const state = await readLoopChange(options.paths, options.name);
      const manifest = await createLoopCheckpointManifest(
        options.paths,
        options.name,
        options.artifacts ?? [],
      );
      const manifestHash = hashLoopCheckpointManifest(manifest);
      const inputHash = sha256Text(
        JSON.stringify({
          summary,
          nextAction,
          artifacts: manifest.artifacts,
        }),
      );
      const existing = await readLoopProgressCheckpoint(options.paths, options.name);
      if (
        existing?.inputHash === inputHash &&
        existing.stateRevision === state.revision &&
        existing.phase === state.phase
      ) {
        if (
          expectedRevision !== undefined &&
          expectedRevision !== existing.previousRevision &&
          expectedRevision !== state.revision
        ) {
          throw new LoopChangeRevisionConflictError(state.name, expectedRevision, state.revision);
        }
        return {
          change: state,
          checkpoint: existing,
          idempotent: true,
          expectedRevision: expectedRevision ?? existing.previousRevision,
          previousRevision: existing.previousRevision,
          revision: state.revision,
          outcome: 'idempotent',
          continuation: loopContinuation({ state }),
        };
      }
      if (expectedRevision !== undefined && state.revision !== expectedRevision) {
        throw new LoopChangeRevisionConflictError(state.name, expectedRevision, state.revision);
      }
      const nextState = { ...state, revision: state.revision + 1 };
      const checkpoint: LoopProgressCheckpoint = {
        schema: 'owner.loop.progress-checkpoint.v1',
        id: options.checkpointId?.() ?? randomUUID(),
        change: state.name,
        phase: state.phase,
        previousRevision: state.revision,
        stateRevision: nextState.revision,
        summary,
        nextAction,
        inputHash,
        manifestHash,
        manifestRef: loopCheckpointManifestRef(manifestHash),
        artifactCount: manifest.artifacts.length,
        createdAt: (options.now ?? new Date()).toISOString(),
      };
      const journal = await prepareLoopCheckpointJournal({
        paths: options.paths,
        previousState: state,
        nextState,
        checkpoint,
        manifest,
        now: options.now,
        checkpointId: () => checkpoint.id,
      });
      await options.hooks?.afterPrepared?.(journal);
      const persisted = await continueLoopCheckpointLocked(
        options.paths,
        options.name,
        options.hooks,
      );
      if (!persisted) throw new Error('Loop checkpoint journal disappeared before completion');
      return {
        change: persisted.nextState,
        checkpoint: persisted.checkpoint,
        idempotent: false,
        expectedRevision: expectedRevision ?? persisted.checkpoint.previousRevision,
        previousRevision: persisted.checkpoint.previousRevision,
        revision: persisted.nextState.revision,
        outcome: 'recorded',
        continuation: loopContinuation({ state: persisted.nextState }),
      };
    }),
  );
}
