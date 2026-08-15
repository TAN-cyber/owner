import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import {
  ownerCurrentSelectionFile,
  readOwnerCurrentSelection,
  writeOwnerCurrentSelection,
} from '../../../domains/owner-entry/current-selection.js';
import { repairOwnerCurrentSelection } from '../../../domains/owner-entry/current-selection-repair.js';
import {
  defaultProjectConfig,
  writeProjectConfig,
} from '../../../domains/owner-loop/loop-config.js';

describe('shared Owner current selection repair', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-selection-repair-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('clears a selection only when its target is structurally missing', async () => {
    await writeProjectConfig(root, defaultProjectConfig('.'));
    await writeOwnerCurrentSelection(root, {
      schema: 'owner.selection.v2',
      workflow: 'loop',
      change: 'missing-change',
      branch: null,
    });

    await expect(
      repairOwnerCurrentSelection(root, { migrateLegacyPipeline: false }),
    ).resolves.toEqual({ migratedLegacyPipeline: false, clearedStaleSelection: true });
    await expect(readOwnerCurrentSelection(root)).resolves.toEqual({ status: 'missing' });
  });

  it('preserves a selection for a disabled workflow', async () => {
    await writeProjectConfig(root, defaultProjectConfig('.'));
    await writeOwnerCurrentSelection(root, {
      schema: 'owner.selection.v2',
      workflow: 'pipeline',
      change: 'pipeline-change',
      branch: null,
    });

    await expect(
      repairOwnerCurrentSelection(root, { migrateLegacyPipeline: false }),
    ).resolves.toEqual({ migratedLegacyPipeline: false, clearedStaleSelection: false });
    await expect(readOwnerCurrentSelection(root)).resolves.toMatchObject({
      status: 'selected',
      selection: { workflow: 'pipeline', change: 'pipeline-change' },
    });
  });

  it('preserves malformed selection bytes for manual recovery', async () => {
    await writeProjectConfig(root, defaultProjectConfig('.'));
    const file = ownerCurrentSelectionFile(root);
    await fs.writeFile(file, '{broken\n');

    await expect(
      repairOwnerCurrentSelection(root, { migrateLegacyPipeline: false }),
    ).resolves.toEqual({ migratedLegacyPipeline: false, clearedStaleSelection: false });
    await expect(fs.readFile(file, 'utf8')).resolves.toBe('{broken\n');
  });

  it('propagates deterministic Pipeline migration failures to the lifecycle command', async () => {
    const migrationFailure = new Error('cannot replace current selection');

    await expect(
      repairOwnerCurrentSelection(
        root,
        { migrateLegacyPipeline: true },
        {
          migrateLegacyPipeline: async () => {
            throw migrationFailure;
          },
          resolveOwner: async () => ({ status: 'none' }),
          clearSelection: async () => undefined,
        },
      ),
    ).rejects.toBe(migrationFailure);
  });

  it('propagates stale-selection cleanup failures to the lifecycle command', async () => {
    const cleanupFailure = new Error('cannot remove current selection');

    await expect(
      repairOwnerCurrentSelection(
        root,
        { migrateLegacyPipeline: false },
        {
          migrateLegacyPipeline: async () => false,
          resolveOwner: async () => ({
            status: 'none',
            staleSelection: {
              code: 'target-missing',
              reason: 'missing',
            },
          }),
          clearSelection: async () => {
            throw cleanupFailure;
          },
        },
      ),
    ).rejects.toBe(cleanupFailure);
  });
});
