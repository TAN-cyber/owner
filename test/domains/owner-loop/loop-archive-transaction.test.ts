import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyLoopArchiveTransactionV2,
  createLoopArchiveTransactionV2,
  finalizeLoopArchiveTransactionV2,
  loopArchiveTransactionPaths,
  readLoopArchiveTransactionV2,
  rollbackLoopArchiveTransactionV2,
} from '../../../domains/owner-loop/loop-archive-transaction.js';
import { inspectLoopArchiveContent } from '../../../domains/owner-loop/loop-archive-content.js';
import { ensureLoopDirectories, loopProjectPaths } from '../../../domains/owner-loop/loop-paths.js';
import {
  appendLoopTransactionEvent,
  type LoopArchiveTransactionJournalV2,
} from '../../../domains/owner-loop/loop-transaction.js';
import type { LoopProjectPaths } from '../../../domains/owner-loop/loop-types.js';

describe('Loop Archive transaction V2 public lifecycle', () => {
  let root: string;
  let paths: LoopProjectPaths;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-archive-transaction-'));
    paths = await loopProjectPaths(root, '.');
    await ensureLoopDirectories(paths);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function journal(
    id: string,
    change: string,
    status: LoopArchiveTransactionJournalV2['status'] = 'prepared',
  ) {
    const source = path.join(paths.changesDir, change);
    await fs.mkdir(source, { recursive: true });
    const sourceContent = await inspectLoopArchiveContent(source);
    return {
      schema: 'owner.loop.transaction.v2',
      id,
      kind: 'archive',
      status,
      change,
      createdAt: '2026-08-12T00:00:00.000Z',
      preflightHash: 'a'.repeat(64),
      operations: [
        {
          id: 'archive-change',
          type: 'move',
          source: `changes/${change}`,
          target: `archive/2026-08-12-${change}`,
          expectedSourceHash: sourceContent?.hash ?? 'b'.repeat(64),
          expectedTargetHash: null,
        },
      ],
    } satisfies LoopArchiveTransactionJournalV2;
  }

  it('creates, reads, applies, and finalizes an empty transaction', async () => {
    const initial = await journal('12345678-abcd', 'transaction-change');
    await createLoopArchiveTransactionV2(paths, initial);
    await expect(readLoopArchiveTransactionV2(paths, initial.id)).resolves.toMatchObject({
      status: 'prepared',
      operations: [{ id: 'archive-change', type: 'move' }],
    });

    const applying = await applyLoopArchiveTransactionV2(paths, initial);
    expect(applying.status).toBe('applying');
    const alreadyApplying = await applyLoopArchiveTransactionV2(paths, applying);
    expect(alreadyApplying.status).toBe('applying');

    await finalizeLoopArchiveTransactionV2(paths, alreadyApplying, 'archive-finalization-started');
    const finalized = await finalizeLoopArchiveTransactionV2(
      paths,
      alreadyApplying,
      'archive-finalized',
    );
    expect(finalized.status).toBe('applying');
    const committed = await finalizeLoopArchiveTransactionV2(paths, finalized, 'commit');
    expect(committed.status).toBe('committed');
    expect(loopArchiveTransactionPaths(paths, initial.id).journal).toContain(initial.id);
  });

  it('rejects invalid lifecycle transitions and finalization rollback', async () => {
    const committed = await journal('22345678-abcd', 'committed-change', 'committed');
    await createLoopArchiveTransactionV2(paths, committed);
    await expect(applyLoopArchiveTransactionV2(paths, committed)).rejects.toThrow(
      'cannot apply from committed',
    );

    const rollback = await journal('32345678-abcd', 'rollback-change');
    await createLoopArchiveTransactionV2(paths, rollback);
    await expect(rollbackLoopArchiveTransactionV2(paths, rollback)).resolves.toMatchObject({
      status: 'rolled-back',
    });

    const irreversible = await journal('42345678-abcd', 'irreversible-change');
    await createLoopArchiveTransactionV2(paths, irreversible);
    await appendLoopTransactionEvent(paths, irreversible.id, 'archive-finalization-started');
    await expect(rollbackLoopArchiveTransactionV2(paths, irreversible)).rejects.toThrow(
      'finalization started',
    );
  });
});
