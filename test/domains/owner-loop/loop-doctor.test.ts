import { promises as fs } from 'fs';
import { execFileSync } from 'node:child_process';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLoopChange, loopChangeDir } from '../../../domains/owner-loop/loop-change.js';
import {
  defaultProjectConfig,
  readProjectConfig,
  writeProjectConfig,
} from '../../../domains/owner-loop/loop-config.js';
import { doctorLoopProject } from '../../../domains/owner-loop/loop-doctor.js';
import { acquireLoopLock, releaseLoopLock } from '../../../domains/owner-loop/loop-lock.js';
import { loopChangeRuntimeDir, loopProjectPaths } from '../../../domains/owner-loop/loop-paths.js';
import { moveLoopRoot } from '../../../domains/owner-loop/loop-root-move.js';
import { loopSelectionFile } from '../../../domains/owner-loop/loop-selection.js';
import { createLoopTransaction } from '../../../domains/owner-loop/loop-transaction.js';
import type { LoopProjectPaths } from '../../../domains/owner-loop/loop-types.js';
import {
  loopWorkspaceFile,
  readLoopWorkspaceIdentity,
} from '../../../domains/owner-loop/loop-workspace.js';
import { advanceLoopChange } from '../../helpers/loop-confirmed-transition.js';

const validBrief = `# Outcome
Ship the feature.
# Scope
One capability.
# Non-goals
No migration.
# Acceptance examples
- The feature works.
# Constraints and invariants
Keep compatibility.
# Decisions
Use existing APIs.
# Open questions

# Verification expectations
Run focused tests.
`;

describe('Loop doctor', () => {
  let projectRoot: string;
  let paths: LoopProjectPaths;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-doctor-'));
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'ignore' });
    paths = await loopProjectPaths(projectRoot, '.');
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('is read-only by default and can explicitly clear a stale selection', async () => {
    const selection = loopSelectionFile(paths);
    await fs.mkdir(path.dirname(selection), { recursive: true });
    const source = JSON.stringify({
      schema: 'owner.selection.v2',
      workflow: 'loop',
      change: 'missing-change',
      branch: null,
    });
    await fs.writeFile(selection, source);

    const inspected = await doctorLoopProject({ paths });
    expect(inspected).toMatchObject({ healthy: false });
    expect(inspected.findings).toContainEqual(
      expect.objectContaining({ code: 'selection-stale', severity: 'warning' }),
    );
    expect(await fs.readFile(selection, 'utf8')).toBe(source);

    const repaired = await doctorLoopProject({ paths, repair: true });
    expect(repaired.findings).toContainEqual(
      expect.objectContaining({ code: 'selection-cleared', severity: 'info' }),
    );
    await expect(fs.access(selection)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports an oversized selection without reading it unboundedly', async () => {
    const selection = loopSelectionFile(paths);
    await fs.mkdir(path.dirname(selection), { recursive: true });
    await fs.writeFile(selection, Buffer.alloc(16 * 1024 + 1, 0x61));

    const result = await doctorLoopProject({ paths });

    expect(result.healthy).toBe(false);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        code: 'selection-invalid',
        message: expect.stringContaining('exceeds 16384 bytes'),
      }),
    );
    await expect(fs.stat(selection)).resolves.toMatchObject({ size: 16 * 1024 + 1 });
  });

  it('reports malformed user-authored state and artifacts without modifying them', async () => {
    const state = await createLoopChange({
      paths,
      name: 'incomplete-change',
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });
    const briefFile = path.join(loopChangeDir(paths, state.name), 'brief.md');
    const briefBefore = await fs.readFile(briefFile, 'utf8');
    const result = await doctorLoopProject({ paths, repair: true });

    expect(result.healthy).toBe(false);
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: 'brief-section-empty', severity: 'error' }),
    );
    expect(await fs.readFile(briefFile, 'utf8')).toBe(briefBefore);
  });

  it('migrates legacy Git-backed workspace metadata to process-free v2 identities', async () => {
    const state = await createLoopChange({
      paths,
      name: 'legacy-workspace',
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });
    const file = loopWorkspaceFile(paths, state.name);
    await fs.writeFile(
      file,
      JSON.stringify({
        schema: 'owner.loop.workspace.v1',
        capturedAt: '2026-07-17T00:00:00.000Z',
        capturedRevision: state.revision,
        loopRootRef: 'owner',
        vcs: { kind: 'git', head: 'legacy' },
      }),
    );

    const inspected = await doctorLoopProject({ paths, name: state.name });
    expect(inspected.findings).toContainEqual(
      expect.objectContaining({
        code: 'workspace-identity-migration-required',
        severity: 'warning',
      }),
    );
    await expect(readLoopWorkspaceIdentity(paths, state.name)).resolves.toBeNull();

    const repaired = await doctorLoopProject({ paths, name: state.name, repair: true });
    expect(repaired.findings).toContainEqual(
      expect.objectContaining({ code: 'workspace-identity-migrated', severity: 'info' }),
    );
    await expect(readLoopWorkspaceIdentity(paths, state.name)).resolves.toMatchObject({
      schema: 'owner.loop.workspace.v2',
      capturedRevision: state.revision,
    });
    expect(
      (await doctorLoopProject({ paths, name: state.name })).findings.some(
        (finding) => finding.code === 'workspace-identity-migration-required',
      ),
    ).toBe(false);
  });

  it('upgrades hash-only v2 workspace metadata to stable path identities', async () => {
    const state = await createLoopChange({
      paths,
      name: 'hash-only-workspace',
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });
    const file = loopWorkspaceFile(paths, state.name);
    const identity = (await readLoopWorkspaceIdentity(paths, state.name))!;
    const hashOnly = { ...identity } as Record<string, unknown>;
    delete hashOnly.projectRootPathId;
    delete hashOnly.loopRootPathId;
    await fs.writeFile(file, JSON.stringify(hashOnly));

    const inspected = await doctorLoopProject({ paths, name: state.name });
    expect(inspected.findings).toContainEqual(
      expect.objectContaining({
        code: 'workspace-identity-migration-required',
        severity: 'warning',
      }),
    );

    const repaired = await doctorLoopProject({ paths, name: state.name, repair: true });
    expect(repaired.findings).toContainEqual(
      expect.objectContaining({ code: 'workspace-identity-migrated', severity: 'info' }),
    );
    await expect(readLoopWorkspaceIdentity(paths, state.name)).resolves.toMatchObject({
      projectRootPathId: expect.stringMatching(/^[a-f0-9]{64}$/u),
      loopRootPathId: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it('reports an interrupted phase transition and only continues it explicitly', async () => {
    const state = await createLoopChange({
      paths,
      name: 'pending-transition',
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });
    await fs.writeFile(
      path.join(loopChangeDir(paths, state.name), 'brief.md'),
      `# Outcome
Ship the feature.
# Scope
One capability.
# Non-goals
No migration.
# Acceptance examples
- The feature works.
# Constraints and invariants
Keep compatibility.
# Decisions
Use existing APIs.
# Open questions

# Verification expectations
Run focused tests.
`,
    );
    await expect(
      advanceLoopChange({
        paths,
        name: state.name,
        evidence: { summary: 'shape is ready' },
        hooks: {
          afterPrepared: () => {
            throw new Error('interrupt transition');
          },
        },
      }),
    ).rejects.toThrow('interrupt transition');

    const inspected = await doctorLoopProject({ paths });
    expect(inspected.findings).toContainEqual(
      expect.objectContaining({ code: 'transition-incomplete', severity: 'error' }),
    );

    const repaired = await doctorLoopProject({
      paths,
      repair: true,
      recoveryStrategy: 'continue',
    });
    expect(repaired.findings).toContainEqual(
      expect.objectContaining({ code: 'transition-recovered', severity: 'info' }),
    );
  });

  it('reports malformed Run trajectory data with its path', async () => {
    const state = await createLoopChange({
      paths,
      name: 'broken-trajectory',
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });
    const changeDir = loopChangeDir(paths, state.name);
    await fs.writeFile(path.join(changeDir, 'brief.md'), validBrief);
    await advanceLoopChange({
      paths,
      name: state.name,
      evidence: { summary: 'shape is ready' },
    });
    const trajectory = path.join(loopChangeRuntimeDir(paths, state.name), 'trajectory.jsonl');
    await fs.appendFile(trajectory, '{not-json}\n');

    const inspected = await doctorLoopProject({ paths });
    expect(inspected).toMatchObject({ healthy: false });
    expect(inspected.findings).toContainEqual(
      expect.objectContaining({
        code: 'trajectory-invalid',
        severity: 'error',
        path: trajectory,
      }),
    );
  });

  it('migrates an explicit legacy change-local Runtime into project-local storage', async () => {
    const state = await createLoopChange({
      paths,
      name: 'legacy-layout',
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });
    const preferred = loopChangeRuntimeDir(paths, state.name);
    const legacy = path.join(loopChangeDir(paths, state.name), 'runtime');
    await fs.rename(preferred, legacy);

    const inspected = await doctorLoopProject({ paths, name: state.name });
    expect(inspected.findings).toContainEqual(
      expect.objectContaining({ code: 'runtime-layout-legacy', repair: 'migrate' }),
    );

    const repaired = await doctorLoopProject({ paths, name: state.name, repair: true });
    expect(repaired.findings).toContainEqual(
      expect.objectContaining({ code: 'runtime-layout-migrated', severity: 'info' }),
    );
    await expect(fs.stat(preferred)).resolves.toBeDefined();
    await expect(fs.access(legacy)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('diagnoses live and stale locks and only removes a proven stale lock', async () => {
    const live = await acquireLoopLock(paths, 'archive', 'archive live-change');
    try {
      expect((await doctorLoopProject({ paths })).findings).toContainEqual(
        expect.objectContaining({ code: 'lock-active', severity: 'warning' }),
      );
    } finally {
      await releaseLoopLock(live);
    }

    const staleFile = path.join(paths.locksDir, 'archive.lock');
    await fs.mkdir(paths.locksDir, { recursive: true });
    await fs.writeFile(
      staleFile,
      JSON.stringify({
        id: 'stale-lock',
        pid: 2_147_483_647,
        hostname: os.hostname(),
        createdAt: '2026-07-14T00:00:00.000Z',
        operation: 'archive stale-change',
      }),
    );
    const repaired = await doctorLoopProject({ paths, repair: true });
    expect(repaired.findings).toContainEqual(
      expect.objectContaining({ code: 'stale-lock-removed', severity: 'info' }),
    );
    await expect(fs.access(staleFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports incomplete archive journals and requires an explicit strategy to repair', async () => {
    await createLoopTransaction(paths, {
      schema: 'owner.loop.transaction.v1',
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      kind: 'archive',
      status: 'prepared',
      projectRoot,
      loopRoot: paths.loopRoot,
      change: 'example-change',
      createdAt: '2026-07-14T00:00:00.000Z',
      operations: [],
    });
    const result = await doctorLoopProject({ paths, repair: true });
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        code: 'archive-transaction-incomplete',
        severity: 'error',
      }),
    );
  });

  it('inspects and repairs a pending root move using the requested strategy', async () => {
    await writeProjectConfig(projectRoot, defaultProjectConfig('.'));
    await fs.mkdir(path.join(paths.specsDir, 'example'), { recursive: true });
    await fs.writeFile(path.join(paths.specsDir, 'example', 'spec.md'), 'example\n');
    await expect(
      moveLoopRoot({
        projectRoot,
        toArtifactRoot: 'docs',
        hooks: {
          afterRootMoveStage(stage) {
            if (stage === 'ready') throw new Error('stop at ready');
          },
        },
      }),
    ).rejects.toThrow('stop at ready');
    await fs.writeFile(
      path.join(paths.locksDir, 'root-move.lock'),
      JSON.stringify({
        id: 'stale-root-move',
        pid: 2_147_483_647,
        hostname: os.hostname(),
        createdAt: '2026-07-14T00:00:00.000Z',
        operation: 'move root to docs',
      }),
    );

    const inspected = await doctorLoopProject({ paths });
    expect(inspected.findings).toContainEqual(
      expect.objectContaining({ code: 'root-move-incomplete', severity: 'error' }),
    );
    expect((await readProjectConfig(projectRoot))?.loop.pending_root_move).toBeTruthy();

    const repaired = await doctorLoopProject({
      paths,
      repair: true,
      recoveryStrategy: 'rollback',
    });
    expect(repaired.findings).toContainEqual(
      expect.objectContaining({ code: 'root-move-recovered', severity: 'info' }),
    );
    expect(repaired.findings).toContainEqual(
      expect.objectContaining({ code: 'stale-recovery-lock-removed', severity: 'info' }),
    );
    expect(await readProjectConfig(projectRoot)).toEqual({
      ...defaultProjectConfig('.'),
      workflows: ['loop'],
    });
  });

  it('fails closed on malformed config and preserves its exact bytes', async () => {
    const configFile = path.join(projectRoot, '.owner', 'config.yaml');
    await fs.mkdir(path.dirname(configFile), { recursive: true });
    const malformed = 'schema: owner.project.v1\nloop: [broken\n';
    await fs.writeFile(configFile, malformed);
    const result = await doctorLoopProject({ paths, repair: true });
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'config-invalid' }));
    expect(await fs.readFile(configFile, 'utf8')).toBe(malformed);
  });

  it('fails closed when a managed Loop directory escapes through a symlink', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-doctor-outside-'));
    try {
      await fs.mkdir(paths.loopRoot, { recursive: true });
      await fs.mkdir(path.dirname(paths.runtimeDir), { recursive: true });
      await fs.symlink(
        outside,
        paths.runtimeDir,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const result = await doctorLoopProject({ paths, repair: true });

      expect(result.healthy).toBe(false);
      expect(result.findings).toContainEqual(
        expect.objectContaining({ code: 'loop-path-unsafe', severity: 'error' }),
      );
      expect(await fs.readdir(outside)).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
