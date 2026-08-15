import { describe, expect, it } from 'vitest';

import { loopSensitiveRelativePathReason } from '../../../domains/owner-loop/loop-sensitive-paths.js';

describe('Loop sensitive path classification', () => {
  it('classifies Owner runtime configuration and selection files', () => {
    expect(loopSensitiveRelativePathReason('.owner/config.yaml')).toBe('owner-config');
    expect(loopSensitiveRelativePathReason('.owner/current-change.json')).toBe('owner-selection');
  });
});
