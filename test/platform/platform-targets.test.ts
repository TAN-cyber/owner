import { describe, expect, it } from 'vitest';
import { PLATFORMS } from '../../platform/install/platforms.js';
import { resolvePlatformTarget } from '../../platform/install/platform-targets.js';

describe('resolvePlatformTarget', () => {
  it('returns a registered loop platform by id', () => {
    const codex = PLATFORMS.find((platform) => platform.id === 'codex')!;

    expect(resolvePlatformTarget('codex', 'project')).toEqual({
      platform: codex,
      loop: true,
    });
  });

  it('rejects unsupported project-scoped platforms', () => {
    expect(() => resolvePlatformTarget('test', 'project')).toThrow(
      'Owner supports only claude and codex (project scope)',
    );
  });

  it.each(['', '   '])('rejects empty platform id %#', (platformId) => {
    expect(() => resolvePlatformTarget(platformId, 'project')).toThrow(
      '--platform must be a non-empty platform id',
    );
  });

  it.each(['Codex', 'codex_cli', 'codex.cli', 'codex/cli'])(
    'rejects malformed platform id %s',
    (platformId) => {
      expect(() => resolvePlatformTarget(platformId, 'project')).toThrow(
        '--platform must contain only lowercase letters, numbers, and hyphens',
      );
    },
  );

  it('rejects unsupported global platform targets', () => {
    expect(() => resolvePlatformTarget('test', 'global')).toThrow(
      'Owner supports only claude and codex (global scope)',
    );
  });
});
