import { promises as fs } from 'fs';
import path from 'path';

import { assertNoPendingLoopRootMove } from './loop-config.js';
import { acquireLoopLock, diagnoseLoopLock, releaseLoopLock, type LoopLock } from './loop-lock.js';
import {
  describeLoopPortableTransactionEntry,
  isLoopPortableTransactionUnfinished,
  readLoopPortableTransactionEntry,
  type LoopPortableTransactionRef,
} from './loop-portable-transactions.js';
import { readLoopTransaction } from './loop-transaction.js';
import type { LoopProjectPaths } from './loop-types.js';

async function hasUnfinishedTransaction(
  paths: LoopProjectPaths,
  allowedTransactionId?: string,
  allowedPortableTransaction?: LoopPortableTransactionRef,
): Promise<boolean> {
  let entries;
  try {
    entries = await fs.readdir(paths.transactionsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    try {
      const transaction = await readLoopTransaction(paths, entry.name);
      if (
        transaction.id !== allowedTransactionId &&
        transaction.status !== 'committed' &&
        transaction.status !== 'rolled-back'
      ) {
        return true;
      }
    } catch {
      return true;
    }
  }
  for (const entry of entries) {
    if (!describeLoopPortableTransactionEntry(entry.name)) continue;
    try {
      const transaction = await readLoopPortableTransactionEntry(paths, entry.name);
      if (!transaction) continue;
      if (
        allowedPortableTransaction?.kind === transaction.kind &&
        allowedPortableTransaction.change === transaction.change
      ) {
        continue;
      }
      if (isLoopPortableTransactionUnfinished(transaction)) return true;
    } catch {
      // A file with an exact portable transaction name must be diagnosed or
      // removed before a mutation can safely cross its unknown boundary.
      return true;
    }
  }
  return false;
}

async function acquireLoopMutationLock(
  paths: LoopProjectPaths,
  operation: string,
): Promise<LoopLock> {
  const deadline = Date.now() + 5_000;
  const file = path.join(paths.locksDir, 'root-move.lock');
  while (true) {
    try {
      return await acquireLoopLock(paths, 'root-move', operation);
    } catch (error) {
      const cause = (error as Error & { cause?: NodeJS.ErrnoException }).cause;
      if (cause?.code !== 'EEXIST') throw error;
      const diagnosis = await diagnoseLoopLock(file);
      if (diagnosis.status === 'missing') continue;
      if (diagnosis.status !== 'active' || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5 + Math.floor(Math.random() * 11)));
    }
  }
}

export async function withLoopMutationLock<T>(
  paths: LoopProjectPaths,
  operation: string,
  work: () => Promise<T>,
  options?: {
    allowedTransactionId?: string;
    allowedPortableTransaction?: LoopPortableTransactionRef;
  },
): Promise<T> {
  const lock = await acquireLoopMutationLock(paths, operation);
  try {
    await assertNoPendingLoopRootMove(paths.projectRoot);
    if (
      await hasUnfinishedTransaction(
        paths,
        options?.allowedTransactionId,
        options?.allowedPortableTransaction,
      )
    ) {
      throw new Error('Loop transaction recovery is required before another mutation');
    }
    return await work();
  } finally {
    await releaseLoopLock(lock);
  }
}
