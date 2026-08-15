import { execFileSync } from 'node:child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  acquireLoopLock,
  diagnoseLoopLock,
  isProcessAlive,
  readLoopLock,
  releaseLoopLock,
  takeOverLoopStaleLock,
  withLoopLockRecovery,
} from '../../../domains/owner-loop/loop-lock.js';
import { withLoopMutationLock } from '../../../domains/owner-loop/loop-mutation-lock.js';
import { loopProjectPaths } from '../../../domains/owner-loop/loop-paths.js';
import { withLoopTransitionLock } from '../../../domains/owner-loop/loop-transition-journal.js';
import type { LoopProjectPaths } from '../../../domains/owner-loop/loop-types.js';

describe('Loop operation locks', () => {
  let projectRoot: string;
  let paths: LoopProjectPaths;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-lock-'));
    paths = await loopProjectPaths(projectRoot, '.');
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('stores owner metadata, rejects contention, and permits owner release', async () => {
    const lock = await acquireLoopLock(paths, 'archive', 'archive example');
    expect(await readLoopLock(lock.file)).toMatchObject({
      id: lock.owner.id,
      pid: process.pid,
      hostname: os.hostname(),
      operation: 'archive example',
    });
    await expect(acquireLoopLock(paths, 'archive', 'another archive')).rejects.toThrow(
      /already held/u,
    );
    await releaseLoopLock(lock);
    expect(await readLoopLock(lock.file)).toBeNull();
  });

  it('validates lock names, tolerates a missing release target, and reuses nested coordinators', async () => {
    await expect(acquireLoopLock(paths, 'Bad Name', 'invalid')).rejects.toThrow(
      'Invalid Loop lock name',
    );
    const lock = await acquireLoopLock(paths, 'nested', 'nested operation');
    await fs.rm(lock.file);
    await expect(releaseLoopLock(lock)).resolves.toBeUndefined();

    const events: string[] = [];
    await withLoopLockRecovery([paths, paths], 'nested recovery', async () => {
      events.push('outer');
      await withLoopLockRecovery([paths], 'nested recovery', async () => {
        events.push('inner');
      });
    });
    expect(events).toEqual(['outer', 'inner']);
  });

  it('does not release a lock whose ownership changed', async () => {
    const lock = await acquireLoopLock(paths, 'archive', 'archive example');
    await fs.writeFile(lock.file, JSON.stringify({ ...lock.owner, id: 'another-owner' }));
    await expect(releaseLoopLock(lock)).rejects.toThrow(/ownership changed/u);
    expect(await readLoopLock(lock.file)).toMatchObject({ id: 'another-owner' });
  });

  it('does not release a replacement file that reuses the same owner metadata', async () => {
    const lock = await acquireLoopLock(paths, 'archive', 'archive example');
    const displaced = `${lock.file}.displaced`;
    await fs.rename(lock.file, displaced);
    await fs.writeFile(lock.file, JSON.stringify(lock.owner, null, 2) + '\n');

    await expect(releaseLoopLock(lock)).rejects.toThrow(/identity changed/u);
    expect(await readLoopLock(lock.file)).toMatchObject({ id: lock.owner.id });
    await fs.rm(displaced, { force: true });
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a symlinked lock file instead of following it',
    async () => {
      const lock = await acquireLoopLock(paths, 'archive', 'archive example');
      const displaced = `${lock.file}.real`;
      await fs.rename(lock.file, displaced);
      await fs.symlink(displaced, lock.file);

      await expect(readLoopLock(lock.file)).rejects.toThrow(/regular file/u);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a FIFO at the lock path without blocking on open',
    async () => {
      const lock = await acquireLoopLock(paths, 'archive', 'archive example');
      await fs.rm(lock.file);
      execFileSync('mkfifo', [lock.file]);

      await expect(readLoopLock(lock.file)).rejects.toThrow(/regular file/u);
    },
  );

  it.each([
    {
      fileName: 'root-move.lock',
      run: (work: () => Promise<void>) =>
        withLoopMutationLock(paths, 'mutate after stale owner', work),
    },
    {
      fileName: 'transition-example.lock',
      run: (work: () => Promise<void>) =>
        withLoopTransitionLock(paths, 'example', 'transition after stale owner', work),
    },
  ])('requires doctor takeover for a stale $fileName', async ({ fileName, run }) => {
    await fs.mkdir(paths.locksDir, { recursive: true });
    const file = path.join(paths.locksDir, fileName);
    const stale = {
      id: `stale-${fileName}`,
      pid: 2_147_483_647,
      hostname: os.hostname(),
      createdAt: '2026-07-17T00:00:00.000Z',
      operation: 'interrupted operation',
    };
    await fs.writeFile(file, JSON.stringify(stale));
    let entered = false;

    await expect(
      run(async () => {
        entered = true;
      }),
    ).rejects.toThrow(/already held/u);
    expect(entered).toBe(false);
    expect(await readLoopLock(file)).toEqual(stale);
  });

  it('diagnoses stale local and unknown remote locks without breaking them', async () => {
    await fs.mkdir(paths.locksDir, { recursive: true });
    const file = path.join(paths.locksDir, 'archive.lock');
    const stale = {
      id: 'stale-owner',
      pid: 2_147_483_647,
      hostname: os.hostname(),
      createdAt: '2026-07-14T00:00:00.000Z',
      operation: 'archive old-change',
    };
    await fs.writeFile(file, JSON.stringify(stale));
    expect(await diagnoseLoopLock(file)).toMatchObject({ status: 'stale', owner: stale });
    expect(await fs.readFile(file, 'utf8')).toContain('stale-owner');

    await fs.writeFile(file, JSON.stringify({ ...stale, hostname: 'another-host' }));
    expect(await diagnoseLoopLock(file)).toMatchObject({ status: 'unknown' });
    expect(await fs.readFile(file, 'utf8')).toContain('another-host');
  });

  it('fails closed for missing, malformed, oversized, and non-lock takeover targets', async () => {
    const missing = path.join(paths.locksDir, 'archive.lock');
    expect(await diagnoseLoopLock(missing)).toEqual({
      status: 'missing',
      owner: null,
      identity: null,
    });
    await expect(takeOverLoopStaleLock(paths, missing)).resolves.toEqual({ status: 'missing' });

    await fs.mkdir(paths.locksDir, { recursive: true });
    await fs.writeFile(missing, JSON.stringify({ pid: 1 }));
    await expect(readLoopLock(missing)).rejects.toThrow(/Invalid Loop lock metadata/u);

    await fs.rm(missing);
    await fs.mkdir(missing);
    await expect(readLoopLock(missing)).rejects.toThrow(/regular file/u);
    await fs.rm(missing, { recursive: true });

    await fs.writeFile(missing, 'x'.repeat(16 * 1024 + 1));
    await expect(readLoopLock(missing)).rejects.toThrow(/exceeds/u);

    await fs.writeFile(
      missing,
      JSON.stringify({
        id: 'active-owner',
        pid: process.pid,
        hostname: os.hostname(),
        createdAt: '2026-07-17T00:00:00.000Z',
        operation: 'active operation',
      }),
    );
    const active = await diagnoseLoopLock(missing);
    expect(active.status).toBe('active');
    await expect(takeOverLoopStaleLock(paths, missing, active)).resolves.toMatchObject({
      status: 'changed',
      diagnosis: { status: 'active' },
    });

    await expect(
      takeOverLoopStaleLock(paths, path.join(paths.runtimeDir, 'outside.lock')),
    ).rejects.toThrow(/outside the lock directory/u);
  });

  it('takes over a stale lock only when the diagnosis still matches', async () => {
    await fs.mkdir(paths.locksDir, { recursive: true });
    const file = path.join(paths.locksDir, 'archive.lock');
    const stale = {
      id: 'stale-owner',
      pid: 2_147_483_647,
      hostname: os.hostname(),
      createdAt: '2026-07-17T00:00:00.000Z',
      operation: 'archive old-change',
    };
    await fs.writeFile(file, JSON.stringify(stale));
    const diagnosis = await diagnoseLoopLock(file);
    await expect(
      takeOverLoopStaleLock(paths, file, {
        ...diagnosis,
        owner: { ...stale, id: 'different-owner' },
      }),
    ).resolves.toMatchObject({ status: 'changed', diagnosis: { status: 'stale' } });
    await expect(takeOverLoopStaleLock(paths, file, diagnosis)).resolves.toEqual({
      status: 'removed',
      owner: stale,
    });
    expect(await readLoopLock(file)).toBeNull();
  });

  it('reports process liveness without turning invalid signals into a false stale result', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2_147_483_647)).toBe(false);
    expect(isProcessAlive(Number.NaN)).toBeNull();
  });

  it('serializes live mutation contenders so the later command can recheck state', async () => {
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => (releaseFirst = resolve));
    let firstEntered!: () => void;
    const firstDidEnter = new Promise<void>((resolve) => (firstEntered = resolve));
    const order: string[] = [];
    const first = withLoopMutationLock(paths, 'first mutation', async () => {
      order.push('first');
      firstEntered();
      await firstMayFinish;
    });
    await firstDidEnter;
    const second = withLoopMutationLock(paths, 'second mutation', async () => {
      order.push('second');
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(['first']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
  });
});
