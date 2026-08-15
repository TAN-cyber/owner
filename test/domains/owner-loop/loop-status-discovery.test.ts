import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLoopChange } from '../../../domains/owner-loop/loop-change.js';
import {
  defaultProjectConfig,
  writeProjectConfig,
} from '../../../domains/owner-loop/loop-config.js';
import {
  inspectDiscoveredLoopStatus,
  listDiscoveredLoopStatusPage,
} from '../../../domains/owner-loop/loop-status-discovery.js';
import { ensureLoopDirectories, loopProjectPaths } from '../../../domains/owner-loop/loop-paths.js';

describe('Loop status discovery pagination', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-status-discovery-'));
    await writeProjectConfig(projectRoot, defaultProjectConfig('.'));
    const paths = await loopProjectPaths(projectRoot, '.');
    await ensureLoopDirectories(paths);
    for (let index = 0; index < 25; index += 1) {
      await createLoopChange({
        paths,
        name: `change-${String(index).padStart(2, '0')}`,
        language: 'en',
      });
    }
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('keeps JSON mode in the public continuation command', async () => {
    const page = await listDiscoveredLoopStatusPage({ projectRoot });

    expect(page.nextCursor).not.toBeNull();
    expect(page.nextPageArgs).toEqual([
      'owner',
      'loop',
      'status',
      '--cursor',
      page.nextCursor,
      '--project-root',
      path.resolve(projectRoot),
      '--json',
    ]);
  });

  it('follows a signed cursor and ends pagination at the final page', async () => {
    const first = await listDiscoveredLoopStatusPage({ projectRoot });
    const second = await listDiscoveredLoopStatusPage({
      projectRoot,
      cursor: first.nextCursor,
    });

    expect(second.offset).toBe(first.items.length);
    expect(second.items.length).toBeGreaterThan(0);
    expect(second.nextCursor).toBeNull();
    expect(second.nextPageCommand).toBeNull();
    expect(second.nextPageArgs).toBeNull();
  });

  it('rejects missing, stale, malformed, and invalid-offset cursors', async () => {
    const first = await listDiscoveredLoopStatusPage({ projectRoot });
    const cursor = first.nextCursor!;

    await expect(
      listDiscoveredLoopStatusPage({
        projectRoot,
        cursor: cursor.replace('loop-workspaces-v1.', 'bad.'),
      }),
    ).rejects.toThrow('invalid or stale');
    await expect(
      listDiscoveredLoopStatusPage({ projectRoot, cursor: `${cursor}extra` }),
    ).rejects.toThrow('invalid or stale');

    const parts = cursor.split('.');
    await expect(
      listDiscoveredLoopStatusPage({
        projectRoot,
        cursor: `${parts[0]}.${parts[1]}.0.${parts[3]}`,
      }),
    ).rejects.toThrow('offset is invalid');
    await expect(
      listDiscoveredLoopStatusPage({
        projectRoot,
        cursor: `${parts[0]}.${parts[1]}.zz.${parts[3]}`,
      }),
    ).rejects.toThrow('offset is invalid');
    await expect(
      listDiscoveredLoopStatusPage({
        projectRoot,
        cursor: `${parts[0]}.${parts[1]}.1.${'0'.repeat(64)}`,
      }),
    ).rejects.toThrow('integrity failed');
  });

  it('returns a status projection for an existing and an unknown change', async () => {
    const existing = await inspectDiscoveredLoopStatus({
      projectRoot,
      name: 'change-00',
      details: true,
    });
    expect(existing).toMatchObject({ name: 'change-00' });

    const missing = await inspectDiscoveredLoopStatus({
      projectRoot,
      name: 'not-created',
      acceptanceCursor: 'acceptance-cursor',
    });
    expect(missing).toMatchObject({ name: 'not-created' });
  });
});
