import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const checkpointLoopChange = vi.hoisted(() => vi.fn());
const inspectLoopStatus = vi.hoisted(() => vi.fn());

vi.mock('../../../domains/owner-loop/loop-progress-checkpoint.js', () => ({
  checkpointLoopChange,
}));
vi.mock('../../../domains/owner-loop/loop-diagnostics.js', () => ({ inspectLoopStatus }));

import { loopCheckpointCommand } from '../../../domains/owner-loop/loop-checkpoint-command.js';
import {
  defaultProjectConfig,
  writeProjectConfig,
} from '../../../domains/owner-loop/loop-config.js';

describe('Loop checkpoint command argument branches', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-checkpoint-command-'));
    await writeProjectConfig(projectRoot, defaultProjectConfig('docs'));
    checkpointLoopChange.mockReset();
    inspectLoopStatus.mockReset();
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('requires both summary and next action', async () => {
    await expect(loopCheckpointCommand(['demo'], projectRoot)).rejects.toThrow(
      '--summary is required',
    );
    await expect(
      loopCheckpointCommand(['demo', '--summary', 'checkpoint'], projectRoot),
    ).rejects.toThrow('--next-action is required');
  });

  it('dispatches a valid checkpoint and includes continuation status', async () => {
    checkpointLoopChange.mockResolvedValue({ revision: 4, phase: 'build' });
    inspectLoopStatus.mockResolvedValue({ continuation: { kind: 'build' } });

    await expect(
      loopCheckpointCommand(
        ['demo', '--summary', 'checkpoint', '--next-action', 'continue', '--artifact', 'src.ts'],
        projectRoot,
      ),
    ).resolves.toMatchObject({ command: 'checkpoint', exitCode: 0 });
    expect(checkpointLoopChange).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'demo',
        summary: 'checkpoint',
        nextAction: 'continue',
        artifacts: ['src.ts'],
        expectedRevision: undefined,
      }),
    );
  });
});
