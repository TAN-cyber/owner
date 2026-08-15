import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loopProjectPaths } from '../../../domains/owner-loop/loop-paths.js';
import {
  assertLoopWorkspaceBindingCurrent,
  inspectLoopWorkspaceBinding,
  inspectLoopWorkspaceAdvisory,
  inspectLoopWorkspaceIdentity,
  loopWorkspaceFile,
  projectLoopWorkspace,
  readLoopWorkspaceIdentity,
  resolveLoopWorkspaceBinding,
  setLoopWorkspaceFinish,
  writeLoopWorkspaceIdentity,
} from '../../../domains/owner-loop/loop-workspace.js';

describe('Loop workspace identity', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-workspace-'));
    await fs.mkdir(path.join(projectRoot, 'docs', 'owner', 'changes', 'example', 'runtime'), {
      recursive: true,
    });
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('stores only process-free hashes and project-relative refs', async () => {
    const paths = await loopProjectPaths(projectRoot, 'docs');
    const identity = await inspectLoopWorkspaceIdentity({
      paths,
      name: 'example',
      revision: 7,
      sessionId: 'raw-session-secret',
      now: new Date('2026-07-17T00:00:00.000Z'),
    });
    const serialized = JSON.stringify(identity);

    expect(identity).toMatchObject({
      schema: 'owner.loop.workspace.v2',
      loopRootRef: 'docs/owner',
      capturedRevision: 7,
      capturedAt: '2026-07-17T00:00:00.000Z',
      projectRootId: expect.stringMatching(/^[a-f0-9]{64}$/u),
      loopRootId: expect.stringMatching(/^[a-f0-9]{64}$/u),
      projectRootPathId: expect.stringMatching(/^[a-f0-9]{64}$/u),
      loopRootPathId: expect.stringMatching(/^[a-f0-9]{64}$/u),
      sessionHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(serialized).not.toContain(projectRoot);
    expect(serialized).not.toContain('raw-session-secret');
    expect(serialized).not.toMatch(/\b(?:git|head|branch|worktree|commonDir)\b/iu);
  });

  it('writes and reads bounded local workspace metadata atomically', async () => {
    const paths = await loopProjectPaths(projectRoot, 'docs');
    const written = await writeLoopWorkspaceIdentity({
      paths,
      name: 'example',
      revision: 1,
    });

    await expect(readLoopWorkspaceIdentity(paths, 'example')).resolves.toEqual(written);
    await expect(inspectLoopWorkspaceAdvisory({ paths, identity: written })).resolves.toEqual({
      state: 'aligned',
      findingCodes: [],
      driftComponents: [],
    });
  });

  it('persists new isolation bindings without migrating legacy identities', async () => {
    const paths = await loopProjectPaths(projectRoot, 'docs');
    const written = await writeLoopWorkspaceIdentity({
      paths,
      name: 'example',
      revision: 1,
      binding: { isolation: 'current', changeBranch: null, targetBranch: null },
    });

    expect(written).toMatchObject({
      schema: 'owner.loop.workspace.v3',
      isolation: 'current',
      changeBranch: null,
      targetBranch: null,
      finish: null,
    });
    await expect(inspectLoopWorkspaceBinding({ paths, identity: written })).resolves.toEqual({
      state: 'aligned',
      code: null,
      message: null,
    });
  });

  it('does not treat legacy target-branch provenance as a change-branch binding', async () => {
    const paths = await loopProjectPaths(projectRoot, 'docs');
    await fs.mkdir(paths.runtimeDir, { recursive: true });
    await writeLoopWorkspaceIdentity({
      paths,
      name: 'legacy-example',
      revision: 1,
      binding: { isolation: 'current', changeBranch: null, targetBranch: null },
    });
    const file = loopWorkspaceFile(paths, 'legacy-example');
    const identity = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    delete identity.schema;
    identity.schema = 'owner.loop.workspace.v2';
    delete identity.isolation;
    delete identity.changeBranch;
    delete identity.targetBranch;
    delete identity.finish;
    identity.git = {
      provider: 'git',
      baseCommit: 'a'.repeat(40),
      targetBranch: 'main',
      targetCommit: 'b'.repeat(40),
    };
    await fs.writeFile(file, JSON.stringify(identity));

    await expect(projectLoopWorkspace(paths, 'legacy-example')).resolves.toMatchObject({
      bindingState: 'legacy',
      changeBranch: null,
      targetBranch: 'main',
    });
  });

  it('persists the selected finishing action for isolated changes', async () => {
    execFileSync('git', ['init', '-b', 'main'], { cwd: projectRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'workspace@example.test'], {
      cwd: projectRoot,
    });
    execFileSync('git', ['config', 'user.name', 'Workspace Test'], { cwd: projectRoot });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'initial'], {
      cwd: projectRoot,
      stdio: 'ignore',
    });
    execFileSync('git', ['switch', '-c', 'owner/example'], {
      cwd: projectRoot,
      stdio: 'ignore',
    });
    const paths = await loopProjectPaths(projectRoot, 'docs');
    await writeLoopWorkspaceIdentity({
      paths,
      name: 'example',
      revision: 1,
      binding: {
        isolation: 'branch',
        changeBranch: 'owner/example',
        targetBranch: 'main',
      },
    });

    await expect(setLoopWorkspaceFinish(paths, 'example', 'merge')).resolves.toMatchObject({
      schema: 'owner.loop.workspace.v3',
      finish: 'merge',
    });
    await expect(readLoopWorkspaceIdentity(paths, 'example')).resolves.toMatchObject({
      finish: 'merge',
    });
  });

  it('reports a copied identity as root drift without executing VCS commands', async () => {
    const paths = await loopProjectPaths(projectRoot, 'docs');
    const identity = await inspectLoopWorkspaceIdentity({
      paths,
      name: 'example',
      revision: 1,
    });
    const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-workspace-copy-'));
    try {
      await fs.mkdir(path.join(otherRoot, 'docs', 'owner'), { recursive: true });
      const copiedPaths = await loopProjectPaths(otherRoot, 'docs');
      await expect(inspectLoopWorkspaceAdvisory({ paths: copiedPaths, identity })).resolves.toEqual(
        {
          state: 'drifted',
          findingCodes: ['workspace-root-changed'],
          driftComponents: ['project-root-path', 'loop-root-path'],
        },
      );
    } finally {
      await fs.rm(otherRoot, { recursive: true, force: true });
    }
  });

  it('identifies loop-root-ref drift separately from physical root drift', async () => {
    const originalPaths = await loopProjectPaths(projectRoot, 'docs');
    const identity = await inspectLoopWorkspaceIdentity({
      paths: originalPaths,
      name: 'example',
      revision: 1,
    });
    await fs.mkdir(path.join(projectRoot, 'other', 'owner'), { recursive: true });
    const movedPaths = await loopProjectPaths(projectRoot, 'other');

    await expect(
      inspectLoopWorkspaceAdvisory({ paths: movedPaths, identity }),
    ).resolves.toMatchObject({
      state: 'drifted',
      findingCodes: ['workspace-root-changed'],
      driftComponents: ['loop-root-ref', 'loop-root-path'],
    });
  });

  it('does not report Windows root drift from legacy physical hashes alone', async () => {
    if (process.platform !== 'win32') return;
    const paths = await loopProjectPaths(projectRoot, 'docs');
    const identity = await inspectLoopWorkspaceIdentity({
      paths,
      name: 'example',
      revision: 1,
    });
    const legacy = { ...identity } as Record<string, unknown>;
    delete legacy.projectRootPathId;
    delete legacy.loopRootPathId;
    legacy.projectRootId = 'a'.repeat(64);
    legacy.loopRootId = 'b'.repeat(64);

    await expect(
      inspectLoopWorkspaceAdvisory({ paths, identity: legacy as never }),
    ).resolves.toEqual({
      state: 'unknown',
      findingCodes: ['workspace-inspection-unavailable'],
      driftComponents: ['project-root-legacy-identity', 'loop-root-legacy-identity'],
    });
  });

  it('rejects non-portable refs and unknown fields', async () => {
    const paths = await loopProjectPaths(projectRoot, 'docs');
    const written = await writeLoopWorkspaceIdentity({
      paths,
      name: 'example',
      revision: 1,
    });
    const file = path.join(projectRoot, 'docs/owner/changes/example/runtime/workspace.json');

    await fs.writeFile(file, JSON.stringify({ ...written, loopRootRef: '../other' }));
    await expect(readLoopWorkspaceIdentity(paths, 'example')).rejects.toThrow(
      'project-relative path',
    );

    await fs.writeFile(file, JSON.stringify({ ...written, rawPath: projectRoot }));
    await expect(readLoopWorkspaceIdentity(paths, 'example')).rejects.toThrow('unknown field');
  });

  it('ignores legacy Git-backed v1 metadata as a non-blocking advisory', async () => {
    const paths = await loopProjectPaths(projectRoot, 'docs');
    const file = path.join(projectRoot, 'docs/owner/changes/example/runtime/workspace.json');
    await fs.writeFile(
      file,
      JSON.stringify({
        schema: 'owner.loop.workspace.v1',
        capturedAt: '2026-07-17T00:00:00.000Z',
        capturedRevision: 1,
        loopRootRef: 'docs/owner',
        vcs: { kind: 'git', head: 'legacy' },
      }),
    );

    await expect(readLoopWorkspaceIdentity(paths, 'example')).resolves.toBeNull();
  });

  it('rejects symlinked identity files instead of following them', async () => {
    if (process.platform === 'win32') return;
    const paths = await loopProjectPaths(projectRoot, 'docs');
    const file = path.join(projectRoot, 'docs/owner/changes/example/runtime/workspace.json');
    const outside = path.join(projectRoot, 'outside.json');
    await fs.writeFile(outside, '{}');
    await fs.symlink(outside, file);

    await expect(readLoopWorkspaceIdentity(paths, 'example')).rejects.toThrow('regular file');
  });

  it('resolves and rechecks current, branch, and worktree bindings against Git', async () => {
    expect(resolveLoopWorkspaceBinding({ projectRoot, isolation: 'current' })).toEqual({
      isolation: 'current',
      changeBranch: null,
      targetBranch: null,
    });
    await expect(() =>
      resolveLoopWorkspaceBinding({ projectRoot, isolation: 'branch', targetBranch: 'main' }),
    ).toThrow(/require a Git/u);

    execFileSync('git', ['init', '-b', 'main'], { cwd: projectRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'workspace@example.test'], { cwd: projectRoot });
    execFileSync('git', ['config', 'user.name', 'Workspace Test'], { cwd: projectRoot });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'initial'], {
      cwd: projectRoot,
      stdio: 'ignore',
    });
    execFileSync('git', ['switch', '-c', 'owner/example'], { cwd: projectRoot, stdio: 'ignore' });

    expect(resolveLoopWorkspaceBinding({ projectRoot, isolation: 'current' })).toEqual({
      isolation: 'current',
      changeBranch: 'owner/example',
      targetBranch: 'owner/example',
    });
    expect(
      resolveLoopWorkspaceBinding({ projectRoot, isolation: 'branch', targetBranch: 'main' }),
    ).toEqual({ isolation: 'branch', changeBranch: 'owner/example', targetBranch: 'main' });
    expect(() =>
      resolveLoopWorkspaceBinding({ projectRoot, isolation: 'worktree', targetBranch: 'main' }),
    ).toThrow(/linked Git worktree/u);
    expect(() =>
      resolveLoopWorkspaceBinding({
        projectRoot,
        isolation: 'branch',
        changeBranch: 'wrong-branch',
        targetBranch: 'main',
      }),
    ).toThrow(/does not match/u);
    expect(() =>
      resolveLoopWorkspaceBinding({ projectRoot, isolation: 'branch', targetBranch: 'missing' }),
    ).toThrow(/verified local branch/u);
    expect(() => resolveLoopWorkspaceBinding({ projectRoot, isolation: 'branch' })).toThrow(
      /requires --target-branch/u,
    );

    const expected = {
      isolation: 'branch' as const,
      changeBranch: 'owner/example',
      targetBranch: 'main',
    };
    expect(() => assertLoopWorkspaceBindingCurrent(projectRoot, expected)).not.toThrow();
    expect(() =>
      assertLoopWorkspaceBindingCurrent(projectRoot, { ...expected, changeBranch: 'other' }),
    ).toThrow(/does not match/u);

    execFileSync('git', ['switch', '--detach'], { cwd: projectRoot, stdio: 'ignore' });
    expect(() => resolveLoopWorkspaceBinding({ projectRoot, isolation: 'current' })).toThrow(
      /detached HEAD/u,
    );
  });

  it('rejects isolated bindings outside a Git project and invalid binding fields', async () => {
    await expect(() =>
      resolveLoopWorkspaceBinding({ projectRoot, isolation: 'branch', targetBranch: 'main' }),
    ).toThrow(/require a Git/u);
    await expect(() =>
      resolveLoopWorkspaceBinding({ projectRoot, isolation: 'current', changeBranch: 'main' }),
    ).toThrow(/require a Git/u);

    const paths = await loopProjectPaths(projectRoot, 'docs');
    const written = await writeLoopWorkspaceIdentity({
      paths,
      name: 'example',
      revision: 1,
      binding: { isolation: 'current', changeBranch: null, targetBranch: null },
    });
    const file = loopWorkspaceFile(paths, 'example');
    await fs.writeFile(file, JSON.stringify({ ...written, isolation: 'invalid' }));
    await expect(readLoopWorkspaceIdentity(paths, 'example')).rejects.toThrow(/isolation/u);
    const incompletePathIdentity = { ...written } as Record<string, unknown>;
    delete incompletePathIdentity.loopRootPathId;
    await fs.writeFile(file, JSON.stringify(incompletePathIdentity));
    await expect(readLoopWorkspaceIdentity(paths, 'example')).rejects.toThrow(/provided together/u);
  });
});
