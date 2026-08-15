import { describe, expect, it } from 'vitest';

import { nativeSensitiveRelativePathReason } from '../../../domains/owner-native/native-sensitive-paths.js';

describe('Native sensitive path classification', () => {
  it('classifies Owner runtime configuration and selection files', () => {
    expect(nativeSensitiveRelativePathReason('.owner/config.yaml')).toBe('owner-config');
    expect(nativeSensitiveRelativePathReason('.owner/current-change.json')).toBe('owner-selection');
  });
});
