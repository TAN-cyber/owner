import path from 'path';
import { describe, expect, it } from 'vitest';

import {
  readRepositoryLayout,
  resolveRepositoryPath,
} from '../../platform/paths/repository-layout.js';

describe('repository layout registry', () => {
  it('resolves the manifest and pipeline script output paths', () => {
    const layout = readRepositoryLayout();

    expect(layout.assetsRoot).toBe('assets');
    expect(layout.manifestPath).toBe('assets/manifest.json');
    expect(layout.pipelineRuntime.outputs).toMatchObject({
      runtime: 'assets/skills/owner/scripts/owner-runtime.mjs',
      state: 'assets/skills/owner/scripts/owner-state.mjs',
      guard: 'assets/skills/owner/scripts/owner-guard.mjs',
      archive: 'assets/skills/owner/scripts/owner-archive.mjs',
      intent: 'assets/skills/owner/scripts/owner-intent.mjs',
    });
    expect(Object.values(layout.pipelineRuntime.outputs)).toContain(
      'assets/skills/owner/scripts/owner-runtime.mjs',
    );
    expect(resolveRepositoryPath(layout.pipelineRuntime.outputs.state)).toBe(
      path.resolve('assets', 'skills', 'owner', 'scripts', 'owner-state.mjs'),
    );
    expect(layout.loopRuntime).toMatchObject({
      entries: {
        runtime: 'domains/owner-loop/loop-cli-entry.ts',
        hookGuard: 'domains/owner-loop/loop-hook-guard-entry.ts',
      },
      outputs: {
        runtime: 'assets/skills/owner-loop/scripts/owner-loop-runtime.mjs',
        hookGuard: 'assets/skills/owner-loop/scripts/owner-loop-hook-guard.mjs',
      },
    });
    expect(resolveRepositoryPath(layout.loopRuntime.outputs.runtime)).toBe(
      path.resolve('assets', 'skills', 'owner-loop', 'scripts', 'owner-loop-runtime.mjs'),
    );
    for (const retired of ['checkpoint', 'check', 'evidence', 'receipt']) {
      expect(layout.loopRuntime.entries).not.toHaveProperty(retired);
      expect(layout.loopRuntime.outputs).not.toHaveProperty(retired);
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
      'owner-entry',
      'owner-loop',
      'owner-pipeline',
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
