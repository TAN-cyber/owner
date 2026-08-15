import { settleLoopChangeJournalsLocked } from './loop-change-recovery.js';
import { readLoopChange } from './loop-change.js';
import { executeLoopCheckReceipt, type LoopCheckReceipt } from './loop-check-receipt.js';
import { withLoopMutationLock } from './loop-mutation-lock.js';
import { withLoopTransitionLock } from './loop-transition-journal.js';
import type { LoopChangeState, LoopProjectPaths } from './loop-types.js';
import {
  findLoopReusableRequiredCheckReceipt,
  persistLoopStaticInspectionReceipt,
} from './loop-verification-receipt-runtime.js';

export interface LoopCheckResult {
  change: LoopChangeState;
  receipt: LoopCheckReceipt;
  checkRef: string;
  ref: string;
}

/**
 * Run the one built-in, read-only Loop check without advancing workflow state.
 *
 * Journal recovery and the state read happen under the same lock pair as transitions. The receipt
 * is independent evidence: this function deliberately writes no state, run, or trajectory record.
 */
export async function checkLoopChange(options: {
  paths: LoopProjectPaths;
  name: string;
}): Promise<LoopCheckResult> {
  return withLoopMutationLock(options.paths, `check ${options.name}`, () =>
    withLoopTransitionLock(options.paths, options.name, `check ${options.name}`, () =>
      checkLoopChangeLocked(options),
    ),
  );
}

/** Run the check while the caller already owns Loop's mutation and transition locks. */
export async function checkLoopChangeLocked(options: {
  paths: LoopProjectPaths;
  name: string;
}): Promise<LoopCheckResult> {
  await settleLoopChangeJournalsLocked(options.paths, options.name);
  const state = await readLoopChange(options.paths, options.name);
  if (state.phase !== 'verify') throw new Error(`Loop check requires Verify, got ${state.phase}`);
  if (!state.implementation_scope) throw new Error('Loop check requires an implementation scope');
  const reusable = await findLoopReusableRequiredCheckReceipt({
    paths: options.paths,
    state,
  });
  if (reusable) {
    return {
      change: state,
      receipt: reusable.checkReceipt,
      checkRef: reusable.checkReceiptRef,
      ref: reusable.ref,
    };
  }
  const executed = await executeLoopCheckReceipt({ paths: options.paths, state });
  const typed = await persistLoopStaticInspectionReceipt({
    paths: options.paths,
    state,
    checkReceipt: executed.receipt,
    checkReceiptRef: executed.ref,
  });
  return {
    change: state,
    receipt: executed.receipt,
    checkRef: executed.ref,
    ref: typed.ref,
  };
}
