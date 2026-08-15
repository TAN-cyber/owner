import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const moveLoopRoot = vi.hoisted(() => vi.fn());
vi.mock('../../../domains/owner-loop/loop-root-move.js', () => ({ moveLoopRoot }));

import { loopRootCommand } from '../../../domains/owner-loop/loop-root-command.js';
import {
  defaultProjectConfig,
  writeProjectConfig,
} from '../../../domains/owner-loop/loop-config.js';

describe('Loop root command branches', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-root-command-'));
    moveLoopRoot.mockReset();
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('requires config for root show and returns configured root metadata', async () => {
    await expect(loopRootCommand(['show'], projectRoot)).rejects.toThrow(
      '.owner/config.yaml was not found',
    );

    await writeProjectConfig(projectRoot, defaultProjectConfig('docs', 'zh-CN'));
    await expect(loopRootCommand(['show'], projectRoot)).resolves.toMatchObject({
      command: 'root show',
      exitCode: 0,
      data: { artifactRoot: 'docs', language: 'zh-CN', pendingRootMove: null },
    });
  });

  it('dispatches root move and rejects unknown root commands', async () => {
    moveLoopRoot.mockResolvedValue({ toLoopRoot: path.join(projectRoot, 'new-docs') });

    await expect(loopRootCommand(['move', 'new-docs'], projectRoot)).resolves.toMatchObject({
      command: 'root move',
      exitCode: 0,
    });
    await expect(loopRootCommand(['unknown'], projectRoot)).rejects.toThrow('Unknown root command');
  });
});
