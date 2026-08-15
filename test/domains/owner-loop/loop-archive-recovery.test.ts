import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  archiveLoopChange,
  recoverArchiveTransaction,
} from '../../../domains/owner-loop/loop-archive.js';
import { createLoopChange, readLoopChangeFile } from '../../../domains/owner-loop/loop-change.js';
import { sha256File } from '../../../domains/owner-loop/loop-hash.js';
import {
  loopPreferredChangeRuntimeDir,
  loopProjectPaths,
} from '../../../domains/owner-loop/loop-paths.js';
import {
  createLoopTransaction,
  loopRootRef,
  readLoopTransaction,
  readLoopTransactionEvents,
} from '../../../domains/owner-loop/loop-transaction.js';
import {
  loopArchiveTransactionPaths,
  readLoopArchiveTransactionV2,
} from '../../../domains/owner-loop/loop-archive-transaction.js';
import type { LoopProjectPaths, LoopSpecChange } from '../../../domains/owner-loop/loop-types.js';
import {
  prepareLoopArchiveFixture,
  readyLoopArchivePreflight,
} from '../../helpers/loop-archive.js';

describe('Loop archive recovery', () => {
  let projectRoot: string;
  let paths: LoopProjectPaths;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-recovery-'));
    paths = await loopProjectPaths(projectRoot, '.');
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  async function preparedChange(name: string): Promise<{
    changeDir: string;
    canonical: string;
    specChanges: LoopSpecChange[];
  }> {
    const canonical = path.join(paths.specsDir, 'authentication', 'spec.md');
    await fs.mkdir(path.dirname(canonical), { recursive: true });
    await fs.writeFile(canonical, 'old auth\n');
    const specChanges: LoopSpecChange[] = [
      {
        capability: 'authentication',
        operation: 'replace',
        source: 'specs/authentication.md',
        base_hash: await sha256File(canonical),
      },
      { capability: 'sessions', operation: 'create', source: 'specs/sessions.md', base_hash: null },
    ];
    const { changeDir } = await prepareLoopArchiveFixture({
      paths,
      name,
      specChanges,
      proposedSpecs: {
        'specs/authentication.md': 'new auth\n',
        'specs/sessions.md': 'new sessions\n',
      },
    });
    return { changeDir, canonical, specChanges };
  }

  async function truncateLastTransactionEvent(transactionId: string): Promise<void> {
    const eventsFile = loopArchiveTransactionPaths(paths, transactionId).events;
    const lines = (await fs.readFile(eventsFile, 'utf8')).trimEnd().split('\n');
    const last = lines.pop();
    if (!last || last.length < 3) throw new Error('Expected a complete transaction event');
    await fs.writeFile(eventsFile, `${lines.join('\n')}\n${last.slice(0, -2)}`);
  }

  it('continues after all staged specs were prepared', async () => {
    const { changeDir, canonical } = await preparedChange('prepared-crash');
    const now = new Date('2026-07-17T00:00:00.000Z');
    const expectedPreflightHash = await readyLoopArchivePreflight({
      paths,
      name: 'prepared-crash',
      now,
    });
    let transactionId = '';
    await expect(
      archiveLoopChange({
        paths,
        name: 'prepared-crash',
        expectedPreflightHash,
        now,
        hooks: {
          afterPrepared(journal) {
            transactionId = journal.id;
            throw new Error('crash after prepared');
          },
        },
      }),
    ).rejects.toThrow('crash after prepared');
    expect((await readLoopTransaction(paths, transactionId)).status).toBe('prepared');
    expect(await fs.readFile(canonical, 'utf8')).toBe('old auth\n');
    expect(await fs.stat(changeDir)).toBeTruthy();
    await expect(
      createLoopChange({
        paths,
        name: 'blocked-by-recovery',
        language: 'en',
        verificationProtocol: 'legacy-v1',
      }),
    ).rejects.toThrow('transaction recovery is required');

    const recovered = await recoverArchiveTransaction({
      paths,
      transactionId,
      strategy: 'continue',
    });
    expect(recovered.status).toBe('committed');
    expect(await fs.readFile(canonical, 'utf8')).toBe('new auth\n');
  });

  it('continues after a legacy append crash truncated operation-started', async () => {
    const { canonical } = await preparedChange('partial-start-continue');
    const now = new Date('2026-07-17T00:00:00.000Z');
    const expectedPreflightHash = await readyLoopArchivePreflight({
      paths,
      name: 'partial-start-continue',
      now,
    });
    let transactionId = '';
    let firstOperationId = '';
    await expect(
      archiveLoopChange({
        paths,
        name: 'partial-start-continue',
        expectedPreflightHash,
        now,
        hooks: {
          afterPrepared(journal) {
            transactionId = journal.id;
            firstOperationId = journal.operations[0].id;
            throw new Error('crash after prepared');
          },
        },
      }),
    ).rejects.toThrow('crash after prepared');
    const partial = JSON.stringify({
      sequence: 2,
      timestamp: '2026-07-17T00:00:01.000Z',
      type: 'operation-started',
      operationId: firstOperationId,
    });
    await fs.appendFile(
      loopArchiveTransactionPaths(paths, transactionId).events,
      partial.slice(0, -2),
    );

    const recovered = await recoverArchiveTransaction({
      paths,
      transactionId,
      strategy: 'continue',
    });

    expect(recovered.status).toBe('committed');
    expect(await fs.readFile(canonical, 'utf8')).toBe('new auth\n');
    const events = await readLoopTransactionEvents(paths, transactionId);
    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: events.length }, (_value, index) => index + 1),
    );
    expect(
      events.filter(
        (event) => event.type === 'operation-started' && event.operationId === firstOperationId,
      ),
    ).toHaveLength(1);
  });

  it('fails closed when a proposed-spec parent is replaced during staging', async () => {
    const { changeDir, canonical } = await preparedChange('stage-parent-race');
    const sourceParent = path.join(changeDir, 'specs');
    const displaced = path.join(changeDir, 'specs-original');
    const now = new Date('2026-07-17T00:00:00.000Z');
    const expectedPreflightHash = await readyLoopArchivePreflight({
      paths,
      name: 'stage-parent-race',
      now,
    });
    let injected = false;

    await expect(
      archiveLoopChange({
        paths,
        name: 'stage-parent-race',
        expectedPreflightHash,
        now,
        hooks: {
          async afterProtectedCopySourceParentCaptured(kind) {
            if (kind !== 'stage' || injected) return;
            injected = true;
            await fs.rename(sourceParent, displaced);
            await fs.mkdir(sourceParent);
            await fs.writeFile(path.join(sourceParent, 'authentication.md'), 'replacement auth\n');
          },
        },
      }),
    ).rejects.toThrow(/parent changed during I\/O/u);

    expect(await fs.readFile(path.join(displaced, 'authentication.md'), 'utf8')).toBe('new auth\n');
    expect(await fs.readFile(path.join(sourceParent, 'authentication.md'), 'utf8')).toBe(
      'replacement auth\n',
    );
    expect(await fs.readFile(canonical, 'utf8')).toBe('old auth\n');
  });

  it('fails closed when a canonical parent is replaced during backup', async () => {
    const { canonical } = await preparedChange('backup-parent-race');
    const canonicalParent = path.dirname(canonical);
    const displaced = path.join(paths.specsDir, 'authentication-original');
    const now = new Date('2026-07-17T00:00:00.000Z');
    const expectedPreflightHash = await readyLoopArchivePreflight({
      paths,
      name: 'backup-parent-race',
      now,
    });
    let transactionId = '';
    let injected = false;

    await expect(
      archiveLoopChange({
        paths,
        name: 'backup-parent-race',
        expectedPreflightHash,
        now,
        hooks: {
          afterPrepared(journal) {
            transactionId = journal.id;
          },
          async afterProtectedCopySourceParentCaptured(kind) {
            if (kind !== 'backup' || injected) return;
            injected = true;
            await fs.rename(canonicalParent, displaced);
            await fs.mkdir(canonicalParent);
            await fs.writeFile(canonical, 'replacement canonical\n');
          },
        },
      }),
    ).rejects.toThrow(/parent changed during I\/O/u);

    expect(await fs.readFile(path.join(displaced, 'spec.md'), 'utf8')).toBe('old auth\n');
    expect(await fs.readFile(canonical, 'utf8')).toBe('replacement canonical\n');
    const backup = path.join(
      loopArchiveTransactionPaths(paths, transactionId).backups,
      'specs',
      'authentication',
      'spec.md',
    );
    await expect(fs.access(backup)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rolls back after one canonical spec was replaced', async () => {
    const { changeDir, canonical } = await preparedChange('replace-crash');
    const now = new Date('2026-07-17T00:00:00.000Z');
    const expectedPreflightHash = await readyLoopArchivePreflight({
      paths,
      name: 'replace-crash',
      now,
    });
    let transactionId = '';
    await expect(
      archiveLoopChange({
        paths,
        name: 'replace-crash',
        expectedPreflightHash,
        now,
        hooks: {
          afterPrepared(journal) {
            transactionId = journal.id;
          },
          afterOperation(_operation, completed) {
            if (completed === 1) throw new Error('crash after replace');
          },
        },
      }),
    ).rejects.toThrow('crash after replace');
    expect(await fs.readFile(canonical, 'utf8')).toBe('new auth\n');

    const recovered = await recoverArchiveTransaction({
      paths,
      transactionId,
      strategy: 'rollback',
    });
    expect(recovered.status).toBe('rolled-back');
    expect(await fs.readFile(canonical, 'utf8')).toBe('old auth\n');
    await expect(fs.access(path.join(paths.specsDir, 'sessions', 'spec.md'))).rejects.toMatchObject(
      { code: 'ENOENT' },
    );
    expect(await fs.stat(changeDir)).toBeTruthy();
  });

  it('rolls back after operation-completed was truncated after the operation applied', async () => {
    const { changeDir, canonical } = await preparedChange('partial-completed-rollback');
    const now = new Date('2026-07-17T00:00:00.000Z');
    const expectedPreflightHash = await readyLoopArchivePreflight({
      paths,
      name: 'partial-completed-rollback',
      now,
    });
    let transactionId = '';
    await expect(
      archiveLoopChange({
        paths,
        name: 'partial-completed-rollback',
        expectedPreflightHash,
        now,
        hooks: {
          afterPrepared(journal) {
            transactionId = journal.id;
          },
          afterOperation(_operation, completed) {
            if (completed === 1) throw new Error('crash after first operation');
          },
        },
      }),
    ).rejects.toThrow('crash after first operation');
    expect(await fs.readFile(canonical, 'utf8')).toBe('new auth\n');
    await truncateLastTransactionEvent(transactionId);
    expect((await readLoopTransactionEvents(paths, transactionId)).at(-1)?.type).toBe(
      'operation-started',
    );

    const recovered = await recoverArchiveTransaction({
      paths,
      transactionId,
      strategy: 'rollback',
    });

    expect(recovered.status).toBe('rolled-back');
    expect(await fs.readFile(canonical, 'utf8')).toBe('old auth\n');
    expect(await fs.stat(changeDir)).toBeTruthy();
    const events = await readLoopTransactionEvents(paths, transactionId);
    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: events.length }, (_value, index) => index + 1),
    );
  });

  it('continues when canonical specs are complete but the active change still exists', async () => {
    const { changeDir } = await preparedChange('specs-complete-crash');
    const now = new Date('2026-07-18T00:00:00.000Z');
    const expectedPreflightHash = await readyLoopArchivePreflight({
      paths,
      name: 'specs-complete-crash',
      now,
    });
    let transactionId = '';
    await expect(
      archiveLoopChange({
        paths,
        name: 'specs-complete-crash',
        expectedPreflightHash,
        now,
        hooks: {
          afterPrepared(journal) {
            transactionId = journal.id;
          },
          afterOperation(_operation, completed) {
            if (completed === 2) throw new Error('crash before move');
          },
        },
      }),
    ).rejects.toThrow('crash before move');
    expect(await fs.stat(changeDir)).toBeTruthy();
    expect((await readLoopTransaction(paths, transactionId)).status).toBe('applying');

    const recovered = await recoverArchiveTransaction({
      paths,
      transactionId,
      strategy: 'continue',
    });
    expect(recovered.status).toBe('committed');
    await expect(fs.access(changeDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('finalizes when the active change moved before the journal committed', async () => {
    const { changeDir } = await preparedChange('move-crash');
    const now = new Date('2026-07-19T00:00:00.000Z');
    const expectedPreflightHash = await readyLoopArchivePreflight({
      paths,
      name: 'move-crash',
      now,
    });
    let transactionId = '';
    const archiveDir = path.join(paths.archiveDir, '2026-07-19-move-crash');
    await expect(
      archiveLoopChange({
        paths,
        name: 'move-crash',
        expectedPreflightHash,
        now,
        hooks: {
          afterPrepared(journal) {
            transactionId = journal.id;
          },
          afterOperation(operation) {
            if (operation.id === 'archive-change') throw new Error('crash after move');
          },
        },
      }),
    ).rejects.toThrow('crash after move');
    await expect(fs.access(changeDir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readLoopChangeFile(path.join(archiveDir, 'owner-state.yaml'))).archived).toBe(
      false,
    );

    const recovered = await recoverArchiveTransaction({
      paths,
      transactionId,
      strategy: 'continue',
    });
    expect(recovered.status).toBe('committed');
    expect((await readLoopChangeFile(path.join(archiveDir, 'owner-state.yaml'))).archived).toBe(
      true,
    );
  });

  it('validates moved Run content before crossing the no-rollback marker', async () => {
    const { changeDir } = await preparedChange('invalid-before-finalize');
    const now = new Date('2026-07-19T12:00:00.000Z');
    const expectedPreflightHash = await readyLoopArchivePreflight({
      paths,
      name: 'invalid-before-finalize',
      now,
    });
    let transactionId = '';
    await expect(
      archiveLoopChange({
        paths,
        name: 'invalid-before-finalize',
        expectedPreflightHash,
        now,
        hooks: {
          afterPrepared(journal) {
            transactionId = journal.id;
          },
          afterOperation(operation) {
            if (operation.id === 'archive-change') throw new Error('crash after move');
          },
        },
      }),
    ).rejects.toThrow('crash after move');
    const archiveDir = path.join(paths.archiveDir, '2026-07-19-invalid-before-finalize');
    const runFile = path.join(
      loopPreferredChangeRuntimeDir(paths, 'invalid-before-finalize'),
      'run-state.json',
    );
    const originalRun = await fs.readFile(runFile);
    await fs.writeFile(runFile, '{"broken":true}\n');

    await expect(
      recoverArchiveTransaction({ paths, transactionId, strategy: 'continue' }),
    ).rejects.toThrow(/content changed|changed before finalization|Invalid Run state/u);
    expect(
      (await readLoopTransactionEvents(paths, transactionId)).some(
        (event) => event.type === 'archive-finalization-started',
      ),
    ).toBe(false);

    await fs.writeFile(runFile, originalRun);
    const rolledBack = await recoverArchiveTransaction({
      paths,
      transactionId,
      strategy: 'rollback',
    });
    expect(rolledBack.status).toBe('rolled-back');
    await expect(fs.stat(changeDir)).resolves.toBeTruthy();
  });

  it('continues idempotently after the irreversible marker is durable', async () => {
    await preparedChange('finalization-marker-crash');
    const now = new Date('2026-07-19T13:00:00.000Z');
    const expectedPreflightHash = await readyLoopArchivePreflight({
      paths,
      name: 'finalization-marker-crash',
      now,
    });
    let transactionId = '';
    await expect(
      archiveLoopChange({
        paths,
        name: 'finalization-marker-crash',
        expectedPreflightHash,
        now,
        hooks: {
          afterPrepared(journal) {
            transactionId = journal.id;
          },
          afterFinalizationStarted() {
            throw new Error('crash after finalization marker');
          },
        },
      }),
    ).rejects.toThrow('crash after finalization marker');
    expect(
      (await readLoopTransactionEvents(paths, transactionId)).filter(
        (event) => event.type === 'archive-finalization-started',
      ),
    ).toHaveLength(1);

    const recovered = await recoverArchiveTransaction({
      paths,
      transactionId,
      strategy: 'continue',
    });
    expect(recovered.status).toBe('committed');
    expect(
      (await readLoopTransactionEvents(paths, transactionId)).filter(
        (event) => event.type === 'archive-finalization-started',
      ),
    ).toHaveLength(1);
  });

  it('restarts continuation when the irreversible marker append was truncated', async () => {
    await preparedChange('partial-finalization-restart');
    const now = new Date('2026-07-19T14:00:00.000Z');
    const expectedPreflightHash = await readyLoopArchivePreflight({
      paths,
      name: 'partial-finalization-restart',
      now,
    });
    let transactionId = '';
    await expect(
      archiveLoopChange({
        paths,
        name: 'partial-finalization-restart',
        expectedPreflightHash,
        now,
        hooks: {
          afterPrepared(journal) {
            transactionId = journal.id;
          },
          afterFinalizationStarted() {
            throw new Error('crash after finalization marker');
          },
        },
      }),
    ).rejects.toThrow('crash after finalization marker');
    await truncateLastTransactionEvent(transactionId);
    expect(
      (await readLoopTransactionEvents(paths, transactionId)).some(
        (event) => event.type === 'archive-finalization-started',
      ),
    ).toBe(false);

    const recovered = await recoverArchiveTransaction({
      paths,
      transactionId,
      strategy: 'continue',
    });

    expect(recovered.status).toBe('committed');
    const events = await readLoopTransactionEvents(paths, transactionId);
    expect(events.filter((event) => event.type === 'archive-finalization-started')).toHaveLength(1);
    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: events.length }, (_value, index) => index + 1),
    );
  });

  it('fails closed when staged content changes before the first operation', async () => {
    const { canonical, changeDir } = await preparedChange('staged-drift');
    const now = new Date('2026-07-20T00:00:00.000Z');
    const expectedPreflightHash = await readyLoopArchivePreflight({
      paths,
      name: 'staged-drift',
      now,
    });
    let transactionId = '';
    await expect(
      archiveLoopChange({
        paths,
        name: 'staged-drift',
        expectedPreflightHash,
        now,
        hooks: {
          afterPrepared(journal) {
            transactionId = journal.id;
            throw new Error('crash after prepared');
          },
        },
      }),
    ).rejects.toThrow('crash after prepared');
    const journal = await readLoopArchiveTransactionV2(paths, transactionId);
    const write = journal.operations.find((operation) => operation.type === 'write');
    expect(write?.staged).toBeTruthy();
    const staged = path.resolve(
      paths.runtimeDir,
      ...write!.staged!.slice('runtime/'.length).split('/'),
    );
    await fs.writeFile(staged, 'tampered staged content\n');

    await expect(
      recoverArchiveTransaction({ paths, transactionId, strategy: 'continue' }),
    ).rejects.toThrow('staged file');
    expect(await fs.readFile(canonical, 'utf8')).toBe('old auth\n');
    expect(await fs.stat(changeDir)).toBeTruthy();
    expect((await readLoopArchiveTransactionV2(paths, transactionId)).status).toBe('applying');
  });

  it('preserves the journal and refuses rollback over externally changed canonical content', async () => {
    const { canonical } = await preparedChange('rollback-drift');
    const now = new Date('2026-07-21T00:00:00.000Z');
    const expectedPreflightHash = await readyLoopArchivePreflight({
      paths,
      name: 'rollback-drift',
      now,
    });
    let transactionId = '';
    await expect(
      archiveLoopChange({
        paths,
        name: 'rollback-drift',
        expectedPreflightHash,
        now,
        hooks: {
          afterPrepared(journal) {
            transactionId = journal.id;
          },
          afterOperation(_operation, completed) {
            if (completed === 1) throw new Error('crash after replace');
          },
        },
      }),
    ).rejects.toThrow('crash after replace');
    await fs.writeFile(canonical, 'external canonical content\n');

    await expect(
      recoverArchiveTransaction({ paths, transactionId, strategy: 'rollback' }),
    ).rejects.toThrow('content changed');
    expect(await fs.readFile(canonical, 'utf8')).toBe('external canonical content\n');
    expect((await readLoopArchiveTransactionV2(paths, transactionId)).status).toBe('rolling-back');
  });

  it('refuses to finalize an archive directory that changed after its move', async () => {
    await preparedChange('moved-content-drift');
    const now = new Date('2026-07-22T00:00:00.000Z');
    const expectedPreflightHash = await readyLoopArchivePreflight({
      paths,
      name: 'moved-content-drift',
      now,
    });
    let transactionId = '';
    await expect(
      archiveLoopChange({
        paths,
        name: 'moved-content-drift',
        expectedPreflightHash,
        now,
        hooks: {
          afterPrepared(journal) {
            transactionId = journal.id;
          },
          afterOperation(operation) {
            if (operation.id === 'archive-change') throw new Error('crash after move');
          },
        },
      }),
    ).rejects.toThrow('crash after move');
    const archiveDir = path.join(paths.archiveDir, '2026-07-22-moved-content-drift');
    await fs.writeFile(path.join(archiveDir, 'unexpected.txt'), 'external content\n');

    await expect(
      recoverArchiveTransaction({ paths, transactionId, strategy: 'continue' }),
    ).rejects.toThrow(/content changed|changed before finalization/u);
    expect(await fs.readFile(path.join(archiveDir, 'unexpected.txt'), 'utf8')).toBe(
      'external content\n',
    );
    expect((await readLoopArchiveTransactionV2(paths, transactionId)).status).toBe('applying');
    expect(loopArchiveTransactionPaths(paths, transactionId).journal).toContain(transactionId);
  });

  it('continues legacy v1 Archive journals without weakening v2 writes', async () => {
    const { changeDir } = await prepareLoopArchiveFixture({
      paths,
      name: 'legacy-v1-recovery',
    });
    const transactionId = 'a1b2c3d4-1e9ac';
    const archiveDir = path.join(paths.archiveDir, '2026-07-23-legacy-v1-recovery');
    await createLoopTransaction(paths, {
      schema: 'owner.loop.transaction.v1',
      id: transactionId,
      kind: 'archive',
      status: 'prepared',
      projectRoot: paths.projectRoot,
      loopRoot: paths.loopRoot,
      change: 'legacy-v1-recovery',
      createdAt: '2026-07-23T00:00:00.000Z',
      operations: [
        {
          id: 'archive-change',
          type: 'move',
          source: loopRootRef(paths, changeDir),
          target: loopRootRef(paths, archiveDir),
        },
      ],
    });

    const recovered = await recoverArchiveTransaction({
      paths,
      transactionId,
      strategy: 'continue',
    });

    expect(recovered).toMatchObject({
      schema: 'owner.loop.transaction.v1',
      status: 'committed',
    });
    expect((await readLoopChangeFile(path.join(archiveDir, 'owner-state.yaml'))).archived).toBe(
      true,
    );
  });
});
