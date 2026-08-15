import { describe, expect, it, vi } from 'vitest';

const settleNativeChangeJournalsLocked = vi.hoisted(() => vi.fn());
const readNativeChange = vi.hoisted(() => vi.fn());

vi.mock('../../../domains/owner-native/native-change-recovery.js', () => ({
  settleNativeChangeJournalsLocked,
}));
vi.mock('../../../domains/owner-native/native-change.js', () => ({ readNativeChange }));
vi.mock('../../../domains/owner-native/native-check-receipt.js', () => ({
  executeNativeCheckReceipt: vi.fn(),
}));
vi.mock('../../../domains/owner-native/native-mutation-lock.js', () => ({
  withNativeMutationLock: vi.fn(),
}));
vi.mock('../../../domains/owner-native/native-transition-journal.js', () => ({
  withNativeTransitionLock: vi.fn(),
}));
vi.mock('../../../domains/owner-native/native-verification-receipt-runtime.js', () => ({
  findNativeReusableRequiredCheckReceipt: vi.fn(),
  persistNativeStaticInspectionReceipt: vi.fn(),
}));

import { checkNativeChangeLocked } from '../../../domains/owner-native/native-check.js';

describe('Native check phase preconditions', () => {
  const options = { paths: {} as never, name: 'demo' };

  it('rejects checks before Verify', async () => {
    readNativeChange.mockResolvedValue({ phase: 'build' });

    await expect(checkNativeChangeLocked(options)).rejects.toThrow(
      'Native check requires Verify, got build',
    );
  });

  it('rejects Verify checks without an implementation scope', async () => {
    readNativeChange.mockResolvedValue({ phase: 'verify', implementation_scope: null });

    await expect(checkNativeChangeLocked(options)).rejects.toThrow(
      'Native check requires an implementation scope',
    );
  });
});
