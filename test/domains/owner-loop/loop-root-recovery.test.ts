import { promises as fs } from 'fs';
import { execFileSync } from 'node:child_process';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_LOOP_SNAPSHOT_CONFIG,
  readProjectConfig,
  resolveLoopProject,
  writeProjectConfig,
} from '../../../domains/owner-loop/loop-config.js';
import { createLoopChange } from '../../../domains/owner-loop/loop-change.js';
import { loopProjectPaths } from '../../../domains/owner-loop/loop-paths.js';
import { moveLoopRoot, recoverLoopRootMove } from '../../../domains/owner-loop/loop-root-move.js';
import { readLoopTransaction } from '../../../domains/owner-loop/loop-transaction.js';
import {
  inspectLoopWorkspaceAdvisory,
  readLoopWorkspaceIdentity,
} from '../../../domains/owner-loop/loop-workspace.js';
import { seedLoopRoot } from '../../helpers/loop-root.js';

describe('Loop artifact root recovery', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-root-recovery-'));
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'ignore' });
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  async function enableBatchClarification(): Promise<void> {
    const config = await readProjectConfig(projectRoot);
    if (!config) throw new Error('Expected seeded Loop project config');
    config.loop.clarification_mode = 'batch';
    await writeProjectConfig(projectRoot, config);
  }

  it('continues an interruption in the copying stage and blocks normal discovery meanwhile', async () => {
    const source = await seedLoopRoot(projectRoot, '.');
    await enableBatchClarification();
    await createLoopChange({
      paths: await loopProjectPaths(projectRoot, '.'),
      verificationProtocol: 'legacy-v1',
      name: 'identity-change',
      language: 'en',
    });
    await expect(
      moveLoopRoot({
        projectRoot,
        toArtifactRoot: 'docs',
        hooks: {
          afterRootMoveStage(stage) {
            if (stage === 'copying') throw new Error('crash while copying');
          },
        },
      }),
    ).rejects.toThrow('crash while copying');
    expect((await readProjectConfig(projectRoot))?.loop.pending_root_move?.stage).toBe('copying');
    await expect(resolveLoopProject({ startPath: projectRoot })).rejects.toThrow(
      /root move .* incomplete/u,
    );
    await expect(
      createLoopChange({
        paths: await loopProjectPaths(projectRoot, '.'),
        verificationProtocol: 'legacy-v1',
        name: 'must-not-start',
        language: 'en',
      }),
    ).rejects.toThrow(/root move .* incomplete/u);

    const recovered = await recoverLoopRootMove({ projectRoot, strategy: 'continue' });
    expect(recovered.activeLoopRoot).toBe(path.join(projectRoot, 'docs', 'owner'));
    expect(recovered.config.loop).toEqual({
      artifact_root: 'docs',
      language: 'en',
      clarification_mode: 'batch',
      archive_confirmation: 'automatic',
      max_verify_failures: 5,
      snapshot: DEFAULT_LOOP_SNAPSHOT_CONFIG,
    });
    await expect(fs.access(source)).rejects.toMatchObject({ code: 'ENOENT' });
    const destinationPaths = await loopProjectPaths(projectRoot, 'docs');
    const workspace = await readLoopWorkspaceIdentity(destinationPaths, 'identity-change');
    await expect(
      inspectLoopWorkspaceAdvisory({ paths: destinationPaths, identity: workspace! }),
    ).resolves.toEqual({ state: 'aligned', findingCodes: [], driftComponents: [] });
  });

  it('rolls back an interruption in the ready stage', async () => {
    const source = await seedLoopRoot(projectRoot, '.');
    await enableBatchClarification();
    const sourcePaths = await loopProjectPaths(projectRoot, '.');
    await createLoopChange({
      paths: sourcePaths,
      name: 'identity-change',
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });
    let transactionId = '';
    await expect(
      moveLoopRoot({
        projectRoot,
        toArtifactRoot: 'docs',
        hooks: {
          afterRootMoveStage(stage, journal) {
            transactionId = journal.id;
            if (stage === 'ready') throw new Error('crash while ready');
          },
        },
      }),
    ).rejects.toThrow('crash while ready');

    const recovered = await recoverLoopRootMove({ projectRoot, strategy: 'rollback' });
    expect(recovered.activeLoopRoot).toBe(source);
    expect(recovered.config.loop).toEqual({
      artifact_root: '.',
      language: 'en',
      clarification_mode: 'batch',
      archive_confirmation: 'automatic',
      max_verify_failures: 5,
      snapshot: DEFAULT_LOOP_SNAPSHOT_CONFIG,
    });
    expect(
      (await readLoopTransaction(await loopProjectPaths(projectRoot, '.'), transactionId)).status,
    ).toBe('rolled-back');
    await expect(fs.access(path.join(projectRoot, 'docs', 'owner'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const workspace = await readLoopWorkspaceIdentity(sourcePaths, 'identity-change');
    await expect(
      inspectLoopWorkspaceAdvisory({ paths: sourcePaths, identity: workspace! }),
    ).resolves.toEqual({ state: 'aligned', findingCodes: [], driftComponents: [] });
  });

  it('continues an interruption after the config switched', async () => {
    await seedLoopRoot(projectRoot, '.');
    await createLoopChange({
      paths: await loopProjectPaths(projectRoot, '.'),
      verificationProtocol: 'legacy-v1',
      name: 'identity-change',
      language: 'en',
    });
    let transactionId = '';
    await expect(
      moveLoopRoot({
        projectRoot,
        toArtifactRoot: 'docs',
        hooks: {
          afterRootMoveStage(stage, journal) {
            transactionId = journal.id;
            if (stage === 'switched') throw new Error('crash after switch');
          },
        },
      }),
    ).rejects.toThrow('crash after switch');
    expect(await readProjectConfig(projectRoot)).toMatchObject({
      loop: { artifact_root: 'docs', pending_root_move: { stage: 'switched' } },
    });

    const recovered = await recoverLoopRootMove({ projectRoot, strategy: 'continue' });
    const destinationPaths = await loopProjectPaths(projectRoot, 'docs');
    expect(recovered.activeLoopRoot).toBe(destinationPaths.loopRoot);
    expect((await readLoopTransaction(destinationPaths, transactionId)).status).toBe('committed');
    const workspace = await readLoopWorkspaceIdentity(destinationPaths, 'identity-change');
    await expect(
      inspectLoopWorkspaceAdvisory({ paths: destinationPaths, identity: workspace! }),
    ).resolves.toEqual({ state: 'aligned', findingCodes: [], driftComponents: [] });
  });

  it('continues a transaction-bound source quarantine after a removal crash', async () => {
    const source = await seedLoopRoot(projectRoot, '.');
    let quarantine = '';
    await expect(
      moveLoopRoot({
        projectRoot,
        toArtifactRoot: 'docs',
        hooks: {
          afterRootMoveSourceQuarantined(target) {
            quarantine = target;
            throw new Error('crash after source quarantine');
          },
        },
      }),
    ).rejects.toThrow('crash after source quarantine');

    expect(path.basename(quarantine)).toMatch(/^\.owner-loop-source-.+\.removing$/u);
    await expect(fs.access(source)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(quarantine, 'specs', 'word-count', 'spec.md'), 'utf8')).toBe(
      'count words\n',
    );
    expect((await readProjectConfig(projectRoot))?.loop.pending_root_move?.stage).toBe('switched');

    const recovered = await recoverLoopRootMove({ projectRoot, strategy: 'continue' });
    expect(recovered.activeLoopRoot).toBe(path.join(projectRoot, 'docs', 'owner'));
    await expect(fs.access(quarantine)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(recovered.config.loop).toEqual({
      artifact_root: 'docs',
      language: 'en',
      clarification_mode: 'batch',
      archive_confirmation: 'automatic',
      max_verify_failures: 5,
      snapshot: DEFAULT_LOOP_SNAPSHOT_CONFIG,
    });
  });

  it('continues deletion when a quarantined source is only a valid manifest subset', async () => {
    const source = await seedLoopRoot(projectRoot, '.');
    await expect(
      moveLoopRoot({
        projectRoot,
        toArtifactRoot: 'docs',
        hooks: {
          afterRootMoveCleanupEntryRemoved(kind, _ref, removedCount) {
            if (kind === 'forward-source' && removedCount === 2) {
              throw new Error('crash during source cleanup');
            }
          },
        },
      }),
    ).rejects.toThrow('crash during source cleanup');

    const pending = (await readProjectConfig(projectRoot))?.loop.pending_root_move;
    expect(pending?.cleanup).toMatchObject({ kind: 'forward-source', state: 'deleting' });
    const quarantine = path.join(projectRoot, `.owner-loop-source-${pending!.id}.removing`);
    await expect(fs.access(source)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.readdir(quarantine, { recursive: true })).length).toBeGreaterThan(0);

    const recovered = await recoverLoopRootMove({ projectRoot, strategy: 'continue' });
    expect(recovered.config.loop).toEqual({
      artifact_root: 'docs',
      language: 'en',
      clarification_mode: 'batch',
      archive_confirmation: 'automatic',
      max_verify_failures: 5,
      snapshot: DEFAULT_LOOP_SNAPSHOT_CONFIG,
    });
    await expect(fs.access(quarantine)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    [
      'extra content',
      async (quarantine: string) => {
        await fs.writeFile(path.join(quarantine, 'unexpected.txt'), 'unexpected\n');
      },
    ],
    [
      'tampered content',
      async (quarantine: string) => {
        await fs.writeFile(path.join(quarantine, 'specs', 'word-count', 'spec.md'), 'tampered\n');
      },
    ],
  ])('fails closed when a source quarantine has %s', async (_label, mutate) => {
    await seedLoopRoot(projectRoot, '.');
    let quarantine = '';
    await expect(
      moveLoopRoot({
        projectRoot,
        toArtifactRoot: 'docs',
        hooks: {
          afterRootMoveSourceQuarantined(target) {
            quarantine = target;
            throw new Error('crash before quarantine validation');
          },
        },
      }),
    ).rejects.toThrow('crash before quarantine validation');
    await mutate(quarantine);

    await expect(recoverLoopRootMove({ projectRoot, strategy: 'continue' })).rejects.toThrow(
      /cleanup quarantine differs from its bound manifest/u,
    );
    expect((await readProjectConfig(projectRoot))?.loop.pending_root_move?.cleanup).toMatchObject({
      kind: 'forward-source',
      state: 'prepared',
    });
    expect(await fs.stat(quarantine)).toBeTruthy();
  });

  it('resumes a partially deleted rollback quarantine with the same manifest rules', async () => {
    const source = await seedLoopRoot(projectRoot, '.');
    await expect(
      moveLoopRoot({
        projectRoot,
        toArtifactRoot: 'docs',
        hooks: {
          afterRootMoveStage(stage) {
            if (stage === 'switched') throw new Error('crash before source cleanup');
          },
        },
      }),
    ).rejects.toThrow('crash before source cleanup');

    await expect(
      recoverLoopRootMove({
        projectRoot,
        strategy: 'rollback',
        hooks: {
          afterRootMoveCleanupEntryRemoved(kind, _ref, removedCount) {
            if (kind === 'rollback-destination' && removedCount === 2) {
              throw new Error('crash during rollback cleanup');
            }
          },
        },
      }),
    ).rejects.toThrow('crash during rollback cleanup');

    const pending = (await readProjectConfig(projectRoot))?.loop.pending_root_move;
    expect(pending?.cleanup).toMatchObject({ kind: 'rollback-destination', state: 'deleting' });
    const destination = path.join(projectRoot, 'docs', 'owner');
    const quarantine = path.join(projectRoot, 'docs', `.owner.${pending!.id}.rollback-removing`);
    await expect(fs.access(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.readdir(quarantine, { recursive: true })).length).toBeGreaterThan(0);

    const recovered = await recoverLoopRootMove({ projectRoot, strategy: 'rollback' });
    expect(recovered.activeLoopRoot).toBe(source);
    expect(recovered.config.loop).toEqual({
      artifact_root: '.',
      language: 'en',
      clarification_mode: 'batch',
      archive_confirmation: 'automatic',
      max_verify_failures: 5,
      snapshot: DEFAULT_LOOP_SNAPSHOT_CONFIG,
    });
    await expect(fs.access(quarantine)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('stops without deleting either tree when staged hashes changed', async () => {
    const source = await seedLoopRoot(projectRoot, '.');
    let transactionId = '';
    await expect(
      moveLoopRoot({
        projectRoot,
        toArtifactRoot: 'docs',
        hooks: {
          afterRootMoveStage(stage, journal) {
            transactionId = journal.id;
            if (stage === 'ready') throw new Error('crash while ready');
          },
        },
      }),
    ).rejects.toThrow('crash while ready');
    const staging = path.join(projectRoot, 'docs', `.owner-loop-move-${transactionId}`);
    await fs.writeFile(path.join(staging, 'specs', 'word-count', 'spec.md'), 'tampered\n');

    await expect(recoverLoopRootMove({ projectRoot, strategy: 'continue' })).rejects.toThrow(
      /preserve both trees/u,
    );
    expect(await fs.stat(source)).toBeTruthy();
    expect(await fs.stat(staging)).toBeTruthy();
    expect((await readProjectConfig(projectRoot))?.loop.pending_root_move?.stage).toBe('ready');
  });

  it('bounds the project-local root-move journal before parsing it', async () => {
    const source = await seedLoopRoot(projectRoot, '.');
    let transactionId = '';
    await expect(
      moveLoopRoot({
        projectRoot,
        toArtifactRoot: 'docs',
        hooks: {
          afterRootMoveStage(stage, journal) {
            transactionId = journal.id;
            if (stage === 'ready') throw new Error('crash before journal fallback');
          },
        },
      }),
    ).rejects.toThrow('crash before journal fallback');
    const staging = path.join(projectRoot, 'docs', `.owner-loop-move-${transactionId}`);
    const runtimePaths = await loopProjectPaths(projectRoot, '.');
    const sourceJournal = path.join(
      runtimePaths.transactionsDir,
      transactionId,
      'transaction.json',
    );
    await fs.writeFile(sourceJournal, 'x'.repeat(256 * 1024 + 1));

    await expect(recoverLoopRootMove({ projectRoot, strategy: 'continue' })).rejects.toThrow(
      /exceeds 262144 bytes/u,
    );
    expect(await fs.stat(source)).toBeTruthy();
    expect(await fs.stat(staging)).toBeTruthy();
  });

  it('rejects a junction in the project-local journal parent chain', async () => {
    const source = await seedLoopRoot(projectRoot, '.');
    let transactionId = '';
    await expect(
      moveLoopRoot({
        projectRoot,
        toArtifactRoot: 'docs',
        hooks: {
          afterRootMoveStage(stage, journal) {
            transactionId = journal.id;
            if (stage === 'ready') throw new Error('crash before junction fallback');
          },
        },
      }),
    ).rejects.toThrow('crash before junction fallback');
    const runtimePaths = await loopProjectPaths(projectRoot, '.');
    const stagedTransaction = path.join(runtimePaths.transactionsDir, transactionId);
    const sourceJournal = path.join(stagedTransaction, 'transaction.json');
    const external = path.join(projectRoot, 'external-journal');
    const journal = await fs.readFile(sourceJournal);
    await fs.mkdir(external);
    await fs.writeFile(path.join(external, 'transaction.json'), journal);
    await fs.rm(stagedTransaction, { recursive: true });
    await fs.symlink(
      external,
      stagedTransaction,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await expect(recoverLoopRootMove({ projectRoot, strategy: 'continue' })).rejects.toThrow(
      /outside the Loop root|parent must be a real directory/u,
    );
    expect(await fs.readFile(path.join(external, 'transaction.json'))).toEqual(journal);
    expect(await fs.stat(source)).toBeTruthy();
  });
});
