import { continueLoopCheckpointLocked } from './loop-checkpoint-journal.js';
import { continueLoopTransitionLocked } from './loop-transition-journal.js';
import type { LoopProjectPaths } from './loop-types.js';

/**
 * Settles every change-local write-ahead journal before a new state mutation.
 *
 * The caller must hold the project mutation lock and the change transition
 * lock. Transition recovery remains first for compatibility with the existing
 * phase WAL; a pending progress checkpoint is then completed before the caller
 * reads the revision it intends to mutate.
 */
export async function settleLoopChangeJournalsLocked(
  paths: LoopProjectPaths,
  name: string,
): Promise<void> {
  await continueLoopTransitionLocked(paths, name);
  await continueLoopCheckpointLocked(paths, name);
}
