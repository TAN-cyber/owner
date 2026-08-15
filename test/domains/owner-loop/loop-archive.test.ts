import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  archiveLoopChange,
  LoopArchivePreflightError,
  recoverArchiveTransaction,
} from '../../../domains/owner-loop/loop-archive.js';
import { loopArchiveTransactionPaths } from '../../../domains/owner-loop/loop-archive-transaction.js';
import { createLoopChange, readLoopChangeFile } from '../../../domains/owner-loop/loop-change.js';
import { sha256File } from '../../../domains/owner-loop/loop-hash.js';
import {
  loopPreferredChangeRuntimeDir,
  loopProjectPaths,
} from '../../../domains/owner-loop/loop-paths.js';
import {
  resolveSelectedLoopChange,
  selectLoopChange,
} from '../../../domains/owner-loop/loop-selection.js';
import { readLoopTransaction } from '../../../domains/owner-loop/loop-transaction.js';
import type { LoopProjectPaths, LoopSpecChange } from '../../../domains/owner-loop/loop-types.js';
import {
  prepareLoopArchiveFixture,
  readyLoopArchivePreflight,
} from '../../helpers/loop-archive.js';

describe('Loop archive', () => {
  let projectRoot: string;
  let paths: LoopProjectPaths;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-archive-'));
    paths = await loopProjectPaths(projectRoot, '.');
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('rejects an invalid preflight hash before inspecting Archive state', async () => {
    await createLoopChange({
      paths,
      verificationProtocol: 'legacy-v1',
      name: 'invalid-preflight',
      language: 'en',
    });
    await expect(
      archiveLoopChange({ paths, name: 'invalid-preflight', expectedPreflightHash: 'bad' }),
    ).rejects.toThrow('expected preflight must be a SHA-256 hash');
  });

  it('applies create, replace, and remove specs before archiving the active change', async () => {
    const replace = path.join(paths.specsDir, 'authentication', 'spec.md');
    const remove = path.join(paths.specsDir, 'legacy-auth', 'spec.md');
    await fs.mkdir(path.dirname(replace), { recursive: true });
    await fs.mkdir(path.dirname(remove), { recursive: true });
    await fs.writeFile(replace, 'old authentication\n');
    await fs.writeFile(remove, 'legacy authentication\n');
    const specChanges: LoopSpecChange[] = [
      { capability: 'sessions', operation: 'create', source: 'specs/sessions.md', base_hash: null },
      {
        capability: 'authentication',
        operation: 'replace',
        source: 'specs/authentication.md',
        base_hash: await sha256File(replace),
      },
      {
        capability: 'legacy-auth',
        operation: 'remove',
        base_hash: await sha256File(remove),
      },
    ];
    const now = new Date('2026-07-14T02:00:00.000Z');
    const { changeDir } = await prepareLoopArchiveFixture({
      paths,
      name: 'auth-update',
      specChanges,
      proposedSpecs: {
        'specs/sessions.md': 'session spec\n',
        'specs/authentication.md': 'new auth spec\n',
      },
    });
    await selectLoopChange(paths, 'auth-update');
    const expectedPreflightHash = await readyLoopArchivePreflight({
      paths,
      name: 'auth-update',
      now,
    });

    const result = await archiveLoopChange({
      paths,
      name: 'auth-update',
      expectedPreflightHash,
      now,
    });

    expect(result.archiveDir).toBe(path.join(paths.archiveDir, '2026-07-14-auth-update'));
    expect(await fs.readFile(path.join(paths.specsDir, 'sessions', 'spec.md'), 'utf8')).toBe(
      'session spec\n',
    );
    expect(await fs.readFile(replace, 'utf8')).toBe('new auth spec\n');
    await expect(fs.access(remove)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(changeDir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      await readLoopChangeFile(path.join(result.archiveDir, 'owner-state.yaml')),
    ).toMatchObject({
      archived: true,
      phase: 'archive',
    });
    await expect(
      fs.access(loopPreferredChangeRuntimeDir(paths, 'auth-update')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(path.join(result.archiveDir, 'runtime'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(result.runtimeCleanupWarning).toBeNull();
    expect(await readLoopTransaction(paths, result.transactionId)).toMatchObject({
      schema: 'owner.loop.transaction.v2',
      kind: 'archive',
      status: 'committed',
      preflightHash: expectedPreflightHash,
    });
    const storedJournal = JSON.parse(
      await fs.readFile(loopArchiveTransactionPaths(paths, result.transactionId).journal, 'utf8'),
    ) as Record<string, unknown>;
    expect(storedJournal).not.toHaveProperty('projectRoot');
    expect(storedJournal).not.toHaveProperty('loopRoot');
    expect(JSON.stringify(storedJournal)).not.toContain(projectRoot);
    expect(storedJournal.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'write',
          expectedTargetHash: null,
          stagedHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
        expect.objectContaining({
          type: 'move',
          expectedSourceHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          expectedTargetHash: null,
        }),
      ]),
    );
    await expect(
      fs.access(path.join(paths.projectRoot, '.owner', 'current-change.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('supports an archive with no spec changes', async () => {
    const now = new Date('2026-07-15T00:00:00.000Z');
    const { changeDir } = await prepareLoopArchiveFixture({ paths, name: 'docs-only' });
    const expectedPreflightHash = await readyLoopArchivePreflight({
      paths,
      name: 'docs-only',
      now,
    });
    await fs.rm(path.join(changeDir, 'evidence.md'), { force: true });
    const result = await archiveLoopChange({
      paths,
      name: 'docs-only',
      expectedPreflightHash,
      now,
    });
    expect(await fs.readdir(paths.specsDir).catch(() => [])).toEqual([]);
    expect(
      await readLoopChangeFile(path.join(result.archiveDir, 'owner-state.yaml')),
    ).toMatchObject({
      archived: true,
    });
    await expect(
      fs.readFile(path.join(result.archiveDir, 'evidence.md'), 'utf8'),
    ).resolves.toContain('# Owner Loop Evidence Projection');
  });

  it('keeps a committed archive when local Runtime cleanup fails', async () => {
    const now = new Date('2026-07-15T00:30:00.000Z');
    const name = 'cleanup-warning';
    await prepareLoopArchiveFixture({ paths, name });
    const expectedPreflightHash = await readyLoopArchivePreflight({ paths, name, now });
    const runtimeDir = loopPreferredChangeRuntimeDir(paths, name);
    const realRm = fs.rm.bind(fs);
    const rm = vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (path.resolve(String(target)) === path.resolve(runtimeDir)) {
        throw Object.assign(new Error('Runtime directory is busy'), { code: 'EBUSY' });
      }
      return realRm(target, options);
    });
    try {
      const result = await archiveLoopChange({
        paths,
        name,
        expectedPreflightHash,
        now,
      });

      expect(result.runtimeCleanupWarning).toContain('Runtime directory is busy');
      expect(
        await readLoopChangeFile(path.join(result.archiveDir, 'owner-state.yaml')),
      ).toMatchObject({
        archived: true,
      });
      await expect(fs.access(runtimeDir)).resolves.toBeUndefined();
      expect(await readLoopTransaction(paths, result.transactionId)).toMatchObject({
        status: 'committed',
      });
    } finally {
      rm.mockRestore();
    }
  });

  it('rechecks verification freshness after spec operations and before moving the change', async () => {
    const now = new Date('2026-07-15T01:00:00.000Z');
    const specChanges: LoopSpecChange[] = [
      {
        capability: 'freshness-fence',
        operation: 'create',
        source: 'specs/freshness-fence.md',
        base_hash: null,
      },
    ];
    const { changeDir } = await prepareLoopArchiveFixture({
      paths,
      name: 'freshness-fence',
      specChanges,
      proposedSpecs: {
        'specs/freshness-fence.md': 'freshness fence spec\n',
      },
    });
    const expectedPreflightHash = await readyLoopArchivePreflight({
      paths,
      name: 'freshness-fence',
      now,
    });
    let transactionId = '';

    await expect(
      archiveLoopChange({
        paths,
        name: 'freshness-fence',
        expectedPreflightHash,
        now,
        hooks: {
          afterPrepared: (journal) => {
            transactionId = journal.id;
          },
          beforeArchiveChangeMove: () =>
            fs.writeFile(
              path.join(projectRoot, 'loop-archive-proof.txt'),
              'changed after verification\n',
            ),
        },
      }),
    ).rejects.toThrow('verification freshness changed before moving');

    await expect(fs.stat(changeDir)).resolves.toBeDefined();
    await expect(
      fs.readFile(path.join(paths.specsDir, 'freshness-fence', 'spec.md'), 'utf8'),
    ).resolves.toBe('freshness fence spec\n');
    await expect(
      fs.access(path.join(paths.archiveDir, '2026-07-15-freshness-fence')),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    await fs.writeFile(
      path.join(projectRoot, 'loop-archive-proof.txt'),
      'Loop Archive fixture evidence.\n',
    );
    await expect(
      recoverArchiveTransaction({
        paths,
        transactionId,
        strategy: 'continue',
      }),
    ).resolves.toMatchObject({ status: 'committed' });
    await expect(fs.access(changeDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.stat(path.join(paths.archiveDir, '2026-07-15-freshness-fence')),
    ).resolves.toBeDefined();
  });

  it('preserves the current selection when archiving a different Loop change', async () => {
    const now = new Date('2026-07-15T00:00:00.000Z');
    await createLoopChange({
      paths,
      name: 'selected-change',
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });
    await prepareLoopArchiveFixture({ paths, name: 'archived-change' });
    await selectLoopChange(paths, 'selected-change');
    const expectedPreflightHash = await readyLoopArchivePreflight({
      paths,
      name: 'archived-change',
      now,
    });

    await archiveLoopChange({
      paths,
      name: 'archived-change',
      expectedPreflightHash,
      now,
    });

    expect(await resolveSelectedLoopChange(paths)).toBe('selected-change');
  });

  it('refuses a transactions junction that would stage archive data outside owner', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-transactions-outside-'));
    try {
      const specChanges: LoopSpecChange[] = [
        {
          capability: 'sessions',
          operation: 'create',
          source: 'specs/sessions.md',
          base_hash: null,
        },
      ];
      const now = new Date('2026-07-17T00:00:00.000Z');
      await prepareLoopArchiveFixture({
        paths,
        name: 'unsafe-transactions',
        specChanges,
        proposedSpecs: { 'specs/sessions.md': 'session spec\n' },
      });
      const expectedPreflightHash = await readyLoopArchivePreflight({
        paths,
        name: 'unsafe-transactions',
        now,
      });
      await fs.rm(paths.transactionsDir, { recursive: true, force: true });
      await fs.symlink(
        outside,
        paths.transactionsDir,
        process.platform === 'win32' ? 'junction' : 'dir',
      );

      await expect(
        archiveLoopChange({
          paths,
          name: 'unsafe-transactions',
          expectedPreflightHash,
          now,
        }),
      ).rejects.toThrow('resolves outside the Loop root');
      expect(await fs.readdir(outside)).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('returns structured base-hash conflicts and leaves canonical specs unchanged', async () => {
    const canonical = path.join(paths.specsDir, 'authentication', 'spec.md');
    await fs.mkdir(path.dirname(canonical), { recursive: true });
    await fs.writeFile(canonical, 'expected canonical\n');
    const expectedHash = await sha256File(canonical);
    const now = new Date('2026-07-17T00:00:00.000Z');
    const { changeDir } = await prepareLoopArchiveFixture({
      paths,
      name: 'conflicting-auth',
      specChanges: [
        {
          capability: 'authentication',
          operation: 'replace',
          source: 'specs/authentication.md',
          base_hash: expectedHash,
        },
      ],
      proposedSpecs: { 'specs/authentication.md': 'proposed spec\n' },
    });
    // Preview the exact facts first, then simulate another writer changing the canonical spec.
    const expectedPreflightHash = await readyLoopArchivePreflight({
      paths,
      name: 'conflicting-auth',
      now,
    });
    await fs.writeFile(canonical, 'current canonical\n');

    let thrown: unknown;
    try {
      await archiveLoopChange({
        paths,
        name: 'conflicting-auth',
        expectedPreflightHash,
        now,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LoopArchivePreflightError);
    expect(thrown).toMatchObject({ code: 'loop-archive-preflight' });
    expect(await fs.readFile(canonical, 'utf8')).toBe('current canonical\n');
    expect(await fs.stat(changeDir)).toBeTruthy();
  });

  it('never overwrites an existing date-prefixed archive target', async () => {
    const now = new Date('2026-07-16T00:00:00.000Z');
    const { changeDir } = await prepareLoopArchiveFixture({
      paths,
      name: 'immutable-target',
    });
    const expectedPreflightHash = await readyLoopArchivePreflight({
      paths,
      name: 'immutable-target',
      now,
    });
    const target = path.join(paths.archiveDir, '2026-07-16-immutable-target');
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'sentinel.txt'), 'keep');
    await expect(
      archiveLoopChange({
        paths,
        name: 'immutable-target',
        expectedPreflightHash,
        now,
      }),
    ).rejects.toBeInstanceOf(LoopArchivePreflightError);
    expect(await fs.readFile(path.join(target, 'sentinel.txt'), 'utf8')).toBe('keep');
    expect(await fs.stat(changeDir)).toBeTruthy();
  });

  it('refuses canonical spec junctions that would write outside owner', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-spec-outside-'));
    try {
      await fs.mkdir(paths.specsDir, { recursive: true });
      await fs.symlink(
        outside,
        path.join(paths.specsDir, 'escaped-spec'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const now = new Date('2026-07-17T00:00:00.000Z');
      await prepareLoopArchiveFixture({
        paths,
        name: 'escaped-spec-change',
        specChanges: [
          {
            capability: 'escaped-spec',
            operation: 'create',
            source: 'specs/escaped-spec.md',
            base_hash: null,
          },
        ],
        proposedSpecs: { 'specs/escaped-spec.md': 'outside denied\n' },
      });

      await expect(
        readyLoopArchivePreflight({ paths, name: 'escaped-spec-change', now }),
      ).rejects.toThrow(/must be a real directory|outside the Loop root/u);
      await expect(fs.access(path.join(outside, 'spec.md'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
