import path from 'path';
import { describe, expect, it } from 'vitest';

import {
  readRepositoryLayout,
  resolveRepositoryPath,
} from '../../platform/paths/repository-layout.js';

describe('repository layout registry', () => {
  it('resolves the manifest and classic script output paths', () => {
    const layout = readRepositoryLayout();

    expect(layout.assetsRoot).toBe('assets');
    expect(layout.manifestPath).toBe('assets/manifest.json');
    expect(layout.classicRuntime.outputs).toMatchObject({
      runtime: 'assets/skills/owner/scripts/owner-runtime.mjs',
      state: 'assets/skills/owner/scripts/owner-state.mjs',
      guard: 'assets/skills/owner/scripts/owner-guard.mjs',
      archive: 'assets/skills/owner/scripts/owner-archive.mjs',
      intent: 'assets/skills/owner/scripts/owner-intent.mjs',
    });
    expect(Object.values(layout.classicRuntime.outputs)).toContain(
      'assets/skills/owner/scripts/owner-runtime.mjs',
    );
    expect(resolveRepositoryPath(layout.classicRuntime.outputs.state)).toBe(
      path.resolve('assets', 'skills', 'owner', 'scripts', 'owner-state.mjs'),
    );
    expect(layout.nativeRuntime).toMatchObject({
      entries: {
        runtime: 'domains/owner-native/native-cli-entry.ts',
        hookGuard: 'domains/owner-native/native-hook-guard-entry.ts',
      },
      outputs: {
        runtime: 'assets/skills/owner-native/scripts/owner-native-runtime.mjs',
        hookGuard: 'assets/skills/owner-native/scripts/owner-native-hook-guard.mjs',
      },
    });
    expect(resolveRepositoryPath(layout.nativeRuntime.outputs.runtime)).toBe(
      path.resolve('assets', 'skills', 'owner-native', 'scripts', 'owner-native-runtime.mjs'),
    );
    for (const retired of ['checkpoint', 'check', 'evidence', 'receipt']) {
      expect(layout.nativeRuntime.entries).not.toHaveProperty(retired);
      expect(layout.nativeRuntime.outputs).not.toHaveProperty(retired);
    }
    expect(layout.entryRuntime).toEqual({
      entries: {
        runtime: 'domains/owner-entry/entry-runtime-entry.ts',
        hookRouter: 'domains/owner-entry/hook-router-entry.ts',
      },
      outputs: {
        runtime: 'assets/skills/owner/scripts/owner-entry-runtime.mjs',
        hookRouter: 'assets/skills/owner/scripts/owner-hook-router.mjs',
      },
    });
    expect(resolveRepositoryPath(layout.entryRuntime.outputs.runtime)).toBe(
      path.resolve('assets', 'skills', 'owner', 'scripts', 'owner-entry-runtime.mjs'),
    );
  });

  it('tracks active source roots', () => {
    const layout = readRepositoryLayout();

    expect(layout.sourceRoots).toEqual(['app', 'domains', 'platform']);
    expect(layout.appModules).toEqual(['cli', 'commands']);
    expect(layout.domainModules).toEqual([
      'engine',
      'integrations',
      'owner-classic',
      'owner-entry',
      'owner-native',
      'skill',
      'workflow-contract',
    ]);
    expect(layout.platformModules).toEqual(['fs', 'install', 'paths', 'process', 'version']);
    expect(layout.scriptModules).toEqual(['build', 'install', 'lib', 'lint', 'release']);
    expect(layout.allowedTopLevelEntries).toContain('app');
    expect(layout.allowedTopLevelEntries).toContain('domains');
    expect(layout.allowedTopLevelEntries).toContain('platform');
    expect(layout.allowedTopLevelEntries).toContain('.superpowers');
    expect(layout.allowedTopLevelEntries).toContain('codecov.yml');
    expect(layout.allowedTopLevelEntries).not.toContain('src');
    expect(layout.allowedCodeFiles).toEqual(['bin/fast-runtime-router.js']);
  });
});
