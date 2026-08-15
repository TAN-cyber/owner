import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LOOP_RUN_STORAGE } from '../../../domains/engine/storage-layout.js';
import type { TrajectoryEvent } from '../../../domains/engine/types.js';
import {
  LOOP_RUNTIME_HASH,
  LOOP_RUNTIME_PACKAGE,
} from '../../../domains/owner-loop/loop-runtime-package.js';
import {
  LOOP_RUN_IO_LIMITS,
  appendLoopTrajectory,
  clearLoopPendingAction,
  readLoopArtifacts,
  readLoopCheckpoint,
  readLoopContext,
  readLoopPendingAction,
  readLoopRunState,
  readLoopTrajectory,
  removeLoopRunState,
  startLoopRun,
  writeLoopArtifacts,
  writeLoopCheckpoint,
  writeLoopContext,
  writeLoopPendingAction,
  writeLoopRunState,
} from '../../../domains/owner-loop/loop-run-store.js';

const execFileAsync = promisify(execFile);

function event(sequence = 1): TrajectoryEvent {
  return {
    sequence,
    timestamp: '2026-07-17T00:00:00.000Z',
    type: 'run_started',
    runId: 'run-one',
    data: { phase: 'shape' },
  };
}

describe('Loop protected Run store', () => {
  let root: string;
  let runtimeDir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-run-store-'));
    runtimeDir = path.join(root, 'runtime');
    await fs.mkdir(runtimeDir);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('owns bounded I/O for every Loop Run document', async () => {
    const run = startLoopRun(LOOP_RUNTIME_PACKAGE, 'run-one', LOOP_RUNTIME_HASH);
    await writeLoopRunState(runtimeDir, run);
    expect(await readLoopRunState(runtimeDir)).toEqual(run);

    await appendLoopTrajectory(runtimeDir, run.trajectoryRef, event());
    expect(await readLoopTrajectory(runtimeDir, run.trajectoryRef)).toEqual([event()]);

    const checkpoint = {
      runId: run.runId,
      stateVersion: 0,
      trajectoryOffset: 1,
      contextHash: null,
      artifactsHash: 'a'.repeat(64),
      createdAt: '2026-07-17T00:00:00.000Z',
    };
    await writeLoopCheckpoint(runtimeDir, run.checkpointRef, checkpoint);
    expect(await readLoopCheckpoint(runtimeDir, run.checkpointRef)).toEqual(checkpoint);

    await writeLoopContext(runtimeDir, run.contextRef, 'bounded context\n');
    expect(await readLoopContext(runtimeDir, run.contextRef)).toBe('bounded context\n');

    await writeLoopArtifacts(runtimeDir, run.artifactsRef, { output: 'feature.ts' });
    expect(await readLoopArtifacts(runtimeDir, run.artifactsRef)).toEqual({
      output: 'feature.ts',
    });

    const action = { id: 'action-one', stepId: 'shape', type: 'checkpoint' as const };
    await writeLoopPendingAction(runtimeDir, run.pendingRef, action);
    expect(await readLoopPendingAction(runtimeDir, run.pendingRef)).toEqual(action);
    await clearLoopPendingAction(runtimeDir, run.pendingRef);
    expect(await readLoopPendingAction(runtimeDir, run.pendingRef)).toBeNull();

    await removeLoopRunState(runtimeDir);
    expect(await readLoopRunState(runtimeDir)).toBeNull();
  });

  it('rejects a parent symlink or junction without touching its outside target', async () => {
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside);
    const sentinel = path.join(outside, 'sentinel.txt');
    await fs.writeFile(sentinel, 'outside stays unchanged\n');
    await fs.rm(runtimeDir, { recursive: true });
    await fs.symlink(outside, runtimeDir, process.platform === 'win32' ? 'junction' : 'dir');

    const run = startLoopRun(LOOP_RUNTIME_PACKAGE, 'run-one', LOOP_RUNTIME_HASH);
    await expect(readLoopRunState(runtimeDir)).rejects.toThrow(/real directory|outside/u);
    await expect(writeLoopRunState(runtimeDir, run)).rejects.toThrow(/real directory|outside/u);
    await expect(fs.readFile(sentinel, 'utf8')).resolves.toBe('outside stays unchanged\n');
    await expect(fs.access(path.join(outside, 'run-state.json'))).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a Run file symlink and leaves the outside file unchanged',
    async () => {
      const outside = path.join(root, 'outside-state.json');
      await fs.writeFile(outside, 'outside stays unchanged\n');
      await fs.symlink(outside, path.join(runtimeDir, 'run-state.json'), 'file');
      const run = startLoopRun(LOOP_RUNTIME_PACKAGE, 'run-one', LOOP_RUNTIME_HASH);

      await expect(readLoopRunState(runtimeDir)).rejects.toThrow(/regular file/u);
      await expect(writeLoopRunState(runtimeDir, run)).rejects.toThrow(/regular file/u);
      await expect(fs.readFile(outside, 'utf8')).resolves.toBe('outside stays unchanged\n');
    },
  );

  it.skipIf(process.platform === 'win32')('rejects a FIFO before opening it', async () => {
    const fifo = path.join(runtimeDir, 'run-state.json');
    await execFileAsync('mkfifo', [fifo]);

    await expect(readLoopRunState(runtimeDir)).rejects.toThrow(/regular file/u);
  });

  it('rejects oversized reads and writes without replacing the prior document', async () => {
    await fs.writeFile(
      path.join(runtimeDir, 'run-state.json'),
      'x'.repeat(LOOP_RUN_IO_LIMITS.runStateBytes + 1),
    );
    await expect(readLoopRunState(runtimeDir)).rejects.toThrow(/exceeds/u);

    await writeLoopContext(runtimeDir, LOOP_RUN_STORAGE.contextRef, 'safe context');
    await expect(
      writeLoopContext(
        runtimeDir,
        LOOP_RUN_STORAGE.contextRef,
        'x'.repeat(LOOP_RUN_IO_LIMITS.contextBytes + 1),
      ),
    ).rejects.toThrow(/exceeds/u);
    await expect(readLoopContext(runtimeDir, LOOP_RUN_STORAGE.contextRef)).resolves.toBe(
      'safe context',
    );
  });

  it.skipIf(process.platform === 'win32')(
    'detects a file replacement during a protected read',
    async () => {
      const run = startLoopRun(LOOP_RUNTIME_PACKAGE, 'run-one', LOOP_RUNTIME_HASH);
      await writeLoopRunState(runtimeDir, run);
      const file = path.join(runtimeDir, 'run-state.json');
      const displaced = `${file}.displaced`;
      const outside = path.join(root, 'outside-state.json');
      await fs.writeFile(outside, 'outside stays unchanged\n');

      await expect(
        readLoopRunState(runtimeDir, {
          afterOpen: async () => {
            await fs.rename(file, displaced);
            await fs.symlink(outside, file, 'file');
          },
        }),
      ).rejects.toThrow(/changed while reading/u);
      await expect(fs.readFile(outside, 'utf8')).resolves.toBe('outside stays unchanged\n');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'detects append TOCTOU and never appends through a replacement symlink',
    async () => {
      const trajectory = path.join(runtimeDir, 'trajectory.jsonl');
      await appendLoopTrajectory(runtimeDir, LOOP_RUN_STORAGE.trajectoryRef, event());
      const displaced = `${trajectory}.displaced`;
      const outside = path.join(root, 'outside-trajectory.jsonl');
      await fs.writeFile(outside, 'outside stays unchanged\n');

      await expect(
        appendLoopTrajectory(runtimeDir, LOOP_RUN_STORAGE.trajectoryRef, event(2), {
          beforeCommit: async () => {
            await fs.rename(trajectory, displaced);
            await fs.symlink(outside, trajectory, 'file');
          },
        }),
      ).rejects.toThrow(/changed before commit/u);
      await expect(fs.readFile(outside, 'utf8')).resolves.toBe('outside stays unchanged\n');
      await expect(fs.readFile(displaced, 'utf8')).resolves.toBe(`${JSON.stringify(event())}\n`);
    },
  );

  it('rejects any Run ref that is not the fixed Loop layout', async () => {
    await expect(readLoopTrajectory(runtimeDir, '../trajectory.jsonl')).rejects.toThrow(
      /ref must be/u,
    );
  });
});
