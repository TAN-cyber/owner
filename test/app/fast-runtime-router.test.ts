import { describe, expect, it } from 'vitest';

import { resolveFastRuntime } from '../../bin/fast-runtime-router.js';

describe('CLI fast runtime router', () => {
  it('maps public high-frequency commands to their package-owned runtime bundles', () => {
    expect(resolveFastRuntime(['state', 'current', '--json'])).toEqual({
      assetPath: 'assets/skills/owner/scripts/owner-state.mjs',
      args: ['current', '--json'],
    });
    expect(resolveFastRuntime(['workflow', 'resolve', '.', '--json'])).toEqual({
      assetPath: 'assets/skills/owner/scripts/owner-entry-runtime.mjs',
      args: ['.', '--json'],
    });
    expect(resolveFastRuntime(['workflow', 'resolve', '.', '--activate', '--json'])).toBeNull();
    expect(resolveFastRuntime(['loop', 'status', '--project-root', 'project', '--json'])).toEqual({
      assetPath: 'assets/skills/owner-loop/scripts/owner-loop-status.mjs',
      args: ['--project-root', 'project', '--json'],
    });
  });

  it('preserves the command tail without parsing it', () => {
    expect(
      resolveFastRuntime(['loop', 'next', 'change', '--summary', 'ready', '--confirmed']),
    ).toEqual({
      assetPath: 'assets/skills/owner-loop/scripts/owner-loop-next.mjs',
      args: ['change', '--summary', 'ready', '--confirmed'],
    });
  });

  it('falls back to Commander for help, unsupported groups, and unknown subcommands', () => {
    expect(resolveFastRuntime(['state', '--help'])).toBeNull();
    expect(resolveFastRuntime(['loop', '--help'])).toBeNull();
    expect(resolveFastRuntime(['loop', 'unknown'])).toBeNull();
    for (const retired of ['checkpoint', 'check', 'evidence', 'receipt']) {
      expect(resolveFastRuntime(['loop', retired, 'change'])).toBeNull();
    }
    expect(resolveFastRuntime(['pipeline', 'root', 'show'])).toBeNull();
    expect(resolveFastRuntime(['resume-probe', '.', '--json'])).toBeNull();
  });
});
