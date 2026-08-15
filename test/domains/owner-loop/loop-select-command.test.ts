import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const inspectLoopStatus = vi.hoisted(() => vi.fn());
const inspectLoopPortableStatus = vi.hoisted(() => vi.fn());
const isLoopPortableChange = vi.hoisted(() => vi.fn());
const selectLoopChange = vi.hoisted(() => vi.fn());

vi.mock('../../../domains/owner-loop/loop-diagnostics.js', () => ({ inspectLoopStatus }));
vi.mock('../../../domains/owner-loop/loop-portable-status.js', () => ({
  inspectLoopPortableStatus,
}));
vi.mock('../../../domains/owner-loop/loop-portable-runtime.js', () => ({
  isLoopPortableChange,
}));
vi.mock('../../../domains/owner-loop/loop-selection.js', () => ({ selectLoopChange }));

import { loopSelectCommand } from '../../../domains/owner-loop/loop-select-command.js';
import {
  defaultProjectConfig,
  writeProjectConfig,
} from '../../../domains/owner-loop/loop-config.js';

describe('Loop select command branches', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-select-command-'));
    await writeProjectConfig(projectRoot, defaultProjectConfig('docs'));
    inspectLoopStatus.mockReset();
    inspectLoopPortableStatus.mockReset();
    isLoopPortableChange.mockReset();
    selectLoopChange.mockReset();
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('uses the regular status projection for a non-portable change', async () => {
    isLoopPortableChange.mockResolvedValue(false);
    inspectLoopStatus.mockResolvedValue({ continuation: { kind: 'shape' } });

    await expect(loopSelectCommand(['demo'], projectRoot)).resolves.toMatchObject({
      command: 'select',
      exitCode: 0,
      data: { selected: 'demo', continuation: { kind: 'shape' } },
    });
    expect(inspectLoopPortableStatus).not.toHaveBeenCalled();
  });
});
