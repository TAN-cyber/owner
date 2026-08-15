import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readLoopChange: vi.fn(),
  advanceRuntimeLoopChange: vi.fn(),
}));

vi.mock('../../../domains/owner-loop/loop-change.js', () => ({
  readLoopChange: mocks.readLoopChange,
}));

vi.mock('../../../domains/owner-loop/loop-transitions.js', () => ({
  advanceLoopChange: mocks.advanceRuntimeLoopChange,
}));

import { advanceLoopChange } from '../../helpers/loop-confirmed-transition.js';

describe('advanceLoopChange test helper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('falls back to runtime creation only when the change is missing', async () => {
    const missing = Object.assign(new Error('missing change'), {
      code: 'ENOENT',
    });
    const created = { phase: 'build' };
    mocks.readLoopChange.mockRejectedValue(missing);
    mocks.advanceRuntimeLoopChange.mockResolvedValue(created);

    await expect(
      advanceLoopChange({
        paths: {} as never,
        name: 'missing-change',
        evidence: { summary: 'confirmed' },
      }),
    ).resolves.toBe(created);
    expect(mocks.advanceRuntimeLoopChange).toHaveBeenCalledWith(
      expect.objectContaining({
        clarificationMode: 'sequential',
        name: 'missing-change',
      }),
    );
  });

  it('does not hide malformed state or filesystem failures', async () => {
    const failure = Object.assign(new Error('permission denied'), {
      code: 'EACCES',
    });
    mocks.readLoopChange.mockRejectedValue(failure);

    await expect(
      advanceLoopChange({
        paths: {} as never,
        name: 'unreadable-change',
        evidence: { summary: 'confirmed' },
      }),
    ).rejects.toBe(failure);
    expect(mocks.advanceRuntimeLoopChange).not.toHaveBeenCalled();
  });
});
