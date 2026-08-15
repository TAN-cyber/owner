import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { createLoopChange } from '../../../domains/owner-loop/loop-change.js';
import { loopProjectPaths } from '../../../domains/owner-loop/loop-paths.js';
import {
  clearLoopSelection,
  loopSelectionFile,
  resolveSelectedLoopChange,
  selectLoopChange,
} from '../../../domains/owner-loop/loop-selection.js';
import type { LoopProjectPaths } from '../../../domains/owner-loop/loop-types.js';

describe('Loop current change selection', () => {
  let projectRoot: string;
  let outside: string;
  let paths: LoopProjectPaths;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-selection-'));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-selection-outside-'));
    paths = await loopProjectPaths(projectRoot, '.');
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('stores the Loop owner in the shared project selection', async () => {
    await createLoopChange({
      paths,
      name: 'selected-change',
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });
    await selectLoopChange(paths, 'selected-change');

    expect(await resolveSelectedLoopChange(paths)).toBe('selected-change');
    expect(loopSelectionFile(paths)).toBe(path.join(projectRoot, '.owner', 'current-change.json'));
    expect(JSON.parse(await fs.readFile(loopSelectionFile(paths), 'utf8'))).toEqual({
      schema: 'owner.selection.v2',
      workflow: 'loop',
      change: 'selected-change',
      branch: null,
    });

    await clearLoopSelection(paths);
    expect(await resolveSelectedLoopChange(paths)).toBeNull();
  });

  it('refuses to select a missing active change', async () => {
    await expect(selectLoopChange(paths, 'missing-change')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('refuses a runtime junction before writing the shared selection', async () => {
    await createLoopChange({
      paths,
      name: 'selected-change',
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });
    await fs.rm(paths.runtimeDir, { recursive: true, force: true });
    await fs.symlink(outside, paths.runtimeDir, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(selectLoopChange(paths, 'selected-change')).rejects.toThrow(
      /must not be a symbolic link|resolves outside the Loop root/u,
    );
    await expect(fs.access(loopSelectionFile(paths))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(path.join(outside, 'current-change.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
