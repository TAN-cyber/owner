import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  describeLoopPortableTransactionEntry,
  isLoopPortableTransactionUnfinished,
  listLoopPortableTransactionEntryNames,
  loopPortableTransactionFile,
  parseLoopPortableArchiveTransaction,
  readLoopPortableTransaction,
  readLoopPortableTransactionEntry,
} from '../../../domains/owner-loop/loop-portable-transactions.js';
import { loopProjectPaths } from '../../../domains/owner-loop/loop-paths.js';
import { LOOP_PORTABLE_ARCHIVE_TRANSACTION_SCHEMA } from '../../../domains/owner-loop/loop-portable-transactions.js';
import type { LoopProjectPaths } from '../../../domains/owner-loop/loop-types.js';

const id = '123e4567-e89b-12d3-a456-426614174000';

function validJournal(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: LOOP_PORTABLE_ARCHIVE_TRANSACTION_SCHEMA,
    id,
    change: 'portable-change',
    start_state_version: 1,
    archive_ref: '2026-08-12-portable-change',
    status: 'prepared',
    next_spec_index: 0,
    spec_changes: [],
    created_at: '2026-08-12T00:00:00.000Z',
    ...patch,
  };
}

describe('Loop portable transaction records', () => {
  let projectRoot: string;
  let paths: LoopProjectPaths;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-portable-transactions-'));
    paths = await loopProjectPaths(projectRoot, '.');
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('parses create, modify, and remove records and classifies entries', () => {
    const parsed = parseLoopPortableArchiveTransaction(
      validJournal({
        spec_changes: [
          {
            capability: 'create-cap',
            operation: 'create',
            source: 'specs/create.md',
            content: 'new',
          },
          {
            capability: 'modify-cap',
            operation: 'modify',
            source: 'specs/modify.md',
            content: 'edit',
          },
          { capability: 'remove-cap', operation: 'remove', source: null, content: null },
        ],
        next_spec_index: 3,
        status: 'moved',
      }),
    );
    expect(parsed.spec_changes).toHaveLength(3);
    expect(
      isLoopPortableTransactionUnfinished({
        kind: 'archive',
        change: parsed.change,
        file: '',
        journal: parsed,
      }),
    ).toBe(true);
    expect(describeLoopPortableTransactionEntry('portable-archive-portable-change.json')).toEqual({
      kind: 'archive',
      change: 'portable-change',
    });
    expect(describeLoopPortableTransactionEntry('portable-migration-portable-change.json')).toEqual(
      {
        kind: 'migration',
        change: 'portable-change',
      },
    );
    expect(describeLoopPortableTransactionEntry('unrelated.json')).toBeNull();
  });

  it.each([
    ['schema', { schema: 'wrong' }, 'schema'],
    ['id', { id: 'not-an-uuid' }, 'id'],
    ['change', { change: 'Bad Name' }, 'change'],
    ['archive ref', { archive_ref: '2026-08-12-other' }, 'ref'],
    ['status', { status: 'committed' }, 'status'],
    ['spec cursor', { next_spec_index: 1 }, 'spec cursor'],
    ['timestamp', { created_at: 'not-a-date' }, 'timestamp'],
    [
      'duplicate capability',
      {
        spec_changes: [
          { capability: 'same', operation: 'create', source: 'a.md', content: 'a' },
          { capability: 'same', operation: 'remove', source: null, content: null },
        ],
      },
      'unique',
    ],
    [
      'invalid source',
      {
        spec_changes: [
          { capability: 'bad-source', operation: 'create', source: '../x', content: 'x' },
        ],
      },
      'source',
    ],
  ])('rejects invalid %s records', (_label, patch, message) => {
    expect(() => parseLoopPortableArchiveTransaction(validJournal(patch))).toThrow(message);
  });

  it('reads, lists, and safely handles missing portable transaction records', async () => {
    await expect(listLoopPortableTransactionEntryNames(paths)).resolves.toEqual([]);
    await expect(
      readLoopPortableTransaction(paths, { kind: 'archive', change: 'missing' }),
    ).resolves.toBeNull();

    await fs.mkdir(paths.transactionsDir, { recursive: true });
    const entry = 'portable-archive-portable-change.json';
    await fs.writeFile(path.join(paths.transactionsDir, entry), JSON.stringify(validJournal()));
    await fs.writeFile(path.join(paths.transactionsDir, 'ignored.json'), '{}');
    await expect(listLoopPortableTransactionEntryNames(paths)).resolves.toEqual([entry]);
    await expect(readLoopPortableTransactionEntry(paths, entry)).resolves.toMatchObject({
      kind: 'archive',
      change: 'portable-change',
    });
    expect(loopPortableTransactionFile(paths, { kind: 'archive', change: 'portable-change' })).toBe(
      path.join(paths.transactionsDir, entry),
    );
  });
});
