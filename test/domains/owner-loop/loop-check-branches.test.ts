import { describe, expect, it, vi } from 'vitest';

const settleLoopChangeJournalsLocked = vi.hoisted(() => vi.fn());
const readLoopChange = vi.hoisted(() => vi.fn());

vi.mock('../../../domains/owner-loop/loop-change-recovery.js', () => ({
  settleLoopChangeJournalsLocked,
}));
vi.mock('../../../domains/owner-loop/loop-change.js', () => ({ readLoopChange }));
vi.mock('../../../domains/owner-loop/loop-check-receipt.js', () => ({
  executeLoopCheckReceipt: vi.fn(),
}));
vi.mock('../../../domains/owner-loop/loop-mutation-lock.js', () => ({
  withLoopMutationLock: vi.fn(),
}));
vi.mock('../../../domains/owner-loop/loop-transition-journal.js', () => ({
  withLoopTransitionLock: vi.fn(),
}));
vi.mock('../../../domains/owner-loop/loop-verification-receipt-runtime.js', () => ({
  findLoopReusableRequiredCheckReceipt: vi.fn(),
  persistLoopStaticInspectionReceipt: vi.fn(),
}));

import { checkLoopChangeLocked } from '../../../domains/owner-loop/loop-check.js';

describe('Loop check phase preconditions', () => {
  const options = { paths: {} as never, name: 'demo' };

  it('rejects checks before Verify', async () => {
    readLoopChange.mockResolvedValue({ phase: 'build' });

    await expect(checkLoopChangeLocked(options)).rejects.toThrow(
      'Loop check requires Verify, got build',
    );
  });

  it('rejects Verify checks without an implementation scope', async () => {
    readLoopChange.mockResolvedValue({ phase: 'verify', implementation_scope: null });

    await expect(checkLoopChangeLocked(options)).rejects.toThrow(
      'Loop check requires an implementation scope',
    );
  });
});
