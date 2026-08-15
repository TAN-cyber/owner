import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runLoopCli } from '../../../domains/owner-loop/loop-cli.js';
import { createLoopChange } from '../../../domains/owner-loop/loop-change.js';
import {
  defaultProjectConfig,
  writeProjectConfig,
} from '../../../domains/owner-loop/loop-config.js';
import { ensureLoopDirectories, loopProjectPaths } from '../../../domains/owner-loop/loop-paths.js';
import { createLoopPortableChange } from '../../../domains/owner-loop/loop-portable-runtime.js';
import { listDiscoveredLoopStatusPage } from '../../../domains/owner-loop/loop-status-discovery.js';

interface RepositoryFixture {
  root: string;
  targetBranch: string;
}

function git(root: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

async function createRepository(): Promise<RepositoryFixture> {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), 'owner-loop-v4-discovery-'),
  );
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  git(root, ['config', 'user.email', 'loop-status@example.test']);
  git(root, ['config', 'user.name', 'Loop Status Test']);
  await writeProjectConfig(root, defaultProjectConfig('docs', 'en'));
  await fs.writeFile(path.join(root, 'README.md'), '# Loop status fixture\n');
  git(root, ['add', '.owner/config.yaml', 'README.md']);
  git(root, ['commit', '-m', 'seed Loop status fixture']);
  return { root, targetBranch: git(root, ['branch', '--show-current']) };
}

function addWorktree(repository: RepositoryFixture, directoryName: string, branch: string): string {
  const worktreeRoot = path.join(repository.root, '.worktrees', directoryName);
  git(repository.root, ['worktree', 'add', '-b', branch, worktreeRoot, repository.targetBranch]);
  return worktreeRoot;
}

function json(result: Awaited<ReturnType<typeof runLoopCli>>): Record<string, unknown> {
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBeTruthy();
  return JSON.parse(result.stdout!) as Record<string, unknown>;
}

describe('Loop v4 registered-worktree status discovery', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it('uses the portable adapter for named and list status from another registered worktree', async () => {
    const repository = await createRepository();
    roots.push(repository.root);
    const worktreeRoot = addWorktree(repository, 'portable-side', 'owner/portable-side');
    const paths = await loopProjectPaths(worktreeRoot, 'docs');
    await ensureLoopDirectories(paths);
    await createLoopPortableChange({
      paths,
      name: 'portable-side',
      language: 'en',
      workspaceBinding: {
        isolation: 'worktree',
        changeBranch: 'owner/portable-side',
        targetBranch: repository.targetBranch,
      },
    });

    const named = json(
      await runLoopCli([
        'status',
        'portable-side',
        '--details',
        '--json',
        '--project-root',
        repository.root,
      ]),
    );
    expect(named.data).toMatchObject({
      schema: 'owner.loop.status.v2',
      name: 'portable-side',
      phase: 'shape',
      workspace: {
        projectRoot: path.resolve(worktreeRoot),
        bindingState: 'aligned',
      },
      continuation: {
        disposition: 'continue',
        action: 'confirm-shape',
      },
    });

    const listed = json(await runLoopCli(['status', '--json', '--project-root', repository.root]));
    expect(listed.data).toMatchObject({
      schema: 'owner.loop.status-page.v2',
      total: 1,
      items: [
        expect.objectContaining({
          schema: 'owner.loop.status.v2',
          name: 'portable-side',
          workspace: expect.objectContaining({
            projectRoot: path.resolve(worktreeRoot),
            bindingState: 'aligned',
          }),
        }),
      ],
    });
  });

  it('merges portable and legacy changes instead of returning early on the current v4', async () => {
    const repository = await createRepository();
    roots.push(repository.root);
    const legacyRoot = addWorktree(repository, 'legacy-side', 'owner/legacy-side');
    const legacyPaths = await loopProjectPaths(legacyRoot, 'docs');
    await ensureLoopDirectories(legacyPaths);
    await createLoopChange({ paths: legacyPaths, name: 'legacy-side', language: 'en' });

    const portablePaths = await loopProjectPaths(repository.root, 'docs');
    await ensureLoopDirectories(portablePaths);
    await createLoopPortableChange({
      paths: portablePaths,
      name: 'portable-main',
      language: 'en',
    });

    const page = await listDiscoveredLoopStatusPage({ projectRoot: repository.root });
    expect(page).toMatchObject({
      schema: 'owner.loop.status-page.v2',
      total: 2,
      offset: 0,
      nextCursor: null,
    });
    expect(page.items.map(({ name }) => name)).toEqual(['legacy-side', 'portable-main']);
    expect(page.items.find(({ name }) => name === 'legacy-side')).toMatchObject({
      migrationRequired: true,
      workspace: { projectRoot: path.resolve(legacyRoot) },
    });
    expect(page.items.find(({ name }) => name === 'portable-main')).toMatchObject({
      schema: 'owner.loop.status.v2',
      workspace: {
        projectRoot: path.resolve(repository.root),
        bindingState: 'aligned',
      },
      continuation: { action: 'confirm-shape' },
    });
  });
});
