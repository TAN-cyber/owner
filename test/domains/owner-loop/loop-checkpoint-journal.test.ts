import { describe, expect, it, vi } from 'vitest';

const readLoopCheckpointJournal = vi.hoisted(() => vi.fn());
const writeLoopCheckpointManifest = vi.hoisted(() => vi.fn());
const writeLoopCheckpointJournal = vi.hoisted(() => vi.fn());

vi.mock('../../../domains/owner-loop/loop-checkpoint-storage.js', () => ({
  loopCheckpointJournalFile: vi.fn(() => 'checkpoint-journal.json'),
  readLoopCheckpointJournal,
  writeLoopCheckpointJournal,
  writeLoopCheckpointManifest,
  writeLoopProgressCheckpoint: vi.fn(),
}));
vi.mock('../../../domains/owner-loop/loop-change.js', () => ({
  compareAndSwapLoopChangeLocked: vi.fn(),
}));
vi.mock('../../../domains/owner-loop/loop-mutation-lock.js', () => ({
  withLoopMutationLock: vi.fn(),
}));
vi.mock('../../../domains/owner-loop/loop-transition-journal.js', () => ({
  continueLoopTransitionLocked: vi.fn(),
  withLoopTransitionLock: vi.fn(),
}));

import {
  continueLoopCheckpointLocked,
  prepareLoopCheckpointJournal,
} from '../../../domains/owner-loop/loop-checkpoint-journal.js';

describe('Loop checkpoint journal branches', () => {
  const paths = {} as never;
  const previousState = { name: 'demo', revision: 1 } as never;
  const nextState = { name: 'demo', revision: 2 } as never;
  const checkpoint = { inputHash: 'a'.repeat(64), manifestHash: 'b'.repeat(64) } as never;
  const manifest = { files: [] } as never;

  it('generates a journal id when no id factory is supplied', async () => {
    writeLoopCheckpointManifest.mockResolvedValueOnce('b'.repeat(64));

    const journal = await prepareLoopCheckpointJournal({
      paths,
      previousState,
      nextState,
      checkpoint,
      manifest,
      now: new Date('2026-07-17T00:00:00.000Z'),
    });

    expect(journal.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(writeLoopCheckpointJournal).toHaveBeenCalledWith(paths, journal);
  });

  it('rejects recovery when the checkpoint manifest hash changed', async () => {
    const journal = {
      change: 'demo',
      checkpoint,
      manifest,
      previousState,
      nextState,
    } as never;
    readLoopCheckpointJournal.mockResolvedValueOnce(journal);
    writeLoopCheckpointManifest.mockResolvedValueOnce('c'.repeat(64));

    await expect(continueLoopCheckpointLocked(paths, 'demo')).rejects.toThrow(
      'manifest hash mismatch',
    );
  });
});
