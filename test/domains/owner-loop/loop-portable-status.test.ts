import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  defaultProjectConfig,
  writeProjectConfig,
} from '../../../domains/owner-loop/loop-config.js';
import { ensureLoopDirectories, loopProjectPaths } from '../../../domains/owner-loop/loop-paths.js';
import { createLoopPortableChange } from '../../../domains/owner-loop/loop-portable-runtime.js';
import { loopSelectCommand } from '../../../domains/owner-loop/loop-select-command.js';
import {
  inspectLoopPortableStatus,
  listLoopPortableStatus,
} from '../../../domains/owner-loop/loop-portable-status.js';

describe('Loop portable status', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it('projects the portable loop even when local execution is missing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-status-v2-'));
    roots.push(root);
    const config = defaultProjectConfig('docs', 'en');
    await writeProjectConfig(root, config);
    const paths = await loopProjectPaths(root, 'docs');
    await ensureLoopDirectories(paths);
    await createLoopPortableChange({ paths, name: 'portable-status', language: 'en' });
    await fs.rm(path.join(paths.changesRuntimeDir, 'portable-status'), {
      recursive: true,
      force: true,
    });

    const status = await inspectLoopPortableStatus({
      paths,
      name: 'portable-status',
      details: true,
    });
    expect(status).toMatchObject({
      schema: 'owner.loop.status.v2',
      phase: 'shape',
      loop: { stage: 'shape', iteration: 0, attempt: 0 },
      localExecution: { status: 'missing', operation: null },
      continuation: { action: 'confirm-shape' },
    });
    expect((await listLoopPortableStatus({ paths })).items).toHaveLength(1);
    await expect(loopSelectCommand(['portable-status'], root)).resolves.toMatchObject({
      exitCode: 0,
      data: {
        selected: 'portable-status',
        continuation: { schema: 'owner.loop.continuation.v2', action: 'confirm-shape' },
      },
    });
  });

  it('does not expose a malformed local overlay as available execution state', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-status-invalid-'));
    roots.push(root);
    const config = defaultProjectConfig('docs', 'en');
    await writeProjectConfig(root, config);
    const paths = await loopProjectPaths(root, 'docs');
    await ensureLoopDirectories(paths);
    await createLoopPortableChange({ paths, name: 'invalid-overlay', language: 'en' });
    await fs.writeFile(
      path.join(paths.changesRuntimeDir, 'invalid-overlay', 'state.json'),
      JSON.stringify({ basedOnStateVersion: 1, execution: { status: 'made-up' } }),
    );

    await expect(
      inspectLoopPortableStatus({ paths, name: 'invalid-overlay' }),
    ).resolves.toMatchObject({
      localExecution: { status: 'invalid', operation: null },
    });
  });
});
