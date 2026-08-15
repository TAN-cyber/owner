import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { withPipelineCommandContext } from '../../../domains/owner-pipeline/pipeline-command-context.js';
import { selectCurrentChange } from '../../../domains/owner-pipeline/pipeline-current-change.js';
import { pipelineStateCommand } from '../../../domains/owner-pipeline/pipeline-state-command.js';
import {
  preparePipelineWorkspace,
  resolvePipelineWorkspace,
} from '../../../domains/owner-pipeline/pipeline-workspace.js';
import { listGitWorktrees } from '../../../platform/paths/git-worktree.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function seedChange(root: string, name: string, branch: string): Promise<void> {
  const directory = path.join(root, 'openspec', 'changes', name);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, '.owner.yaml'),
    [
      'workflow: full',
      'phase: build',
      'design_doc: docs/superpowers/specs/design.md',
      'plan: null',
      'build_mode: executing-plans',
      'isolation: worktree',
      'verify_mode: null',
      'verify_result: pending',
      'verified_at: null',
      `bound_branch: ${branch}`,
      'archived: false',
      '',
    ].join('\n'),
  );
}

describe('Pipeline workspace preparation and routing', () => {
  let root: string;
  const worktrees: string[] = [];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'owner-pipeline-workspace-'));
    git(root, 'init', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test User');
    await fs.mkdir(path.join(root, '.owner'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.owner', 'config.yaml'),
      [
        'schema: owner.project.v1',
        'default_workflow: pipeline',
        'workflows: [pipeline]',
        'pipeline:',
        '  artifact_layout: legacy',
        '',
      ].join('\n'),
    );
    await fs.mkdir(path.join(root, 'openspec', 'changes'), { recursive: true });
    await fs.writeFile(path.join(root, 'openspec', 'changes', '.gitkeep'), '');
    await fs.writeFile(path.join(root, 'README.md'), '# Pipeline workspace\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'initial');
  });

  afterEach(async () => {
    for (const worktree of worktrees.splice(0)) {
      try {
        git(root, 'worktree', 'remove', '--force', worktree);
      } catch {
        // Cleanup is best effort; the assertions above are the useful result.
      }
    }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('prepares, reuses, and routes a Pipeline change to its linked worktree', async () => {
    const prepared = await preparePipelineWorkspace({
      projectRoot: root,
      name: 'parallel-change',
      isolation: 'worktree',
    });
    worktrees.push(prepared.projectRoot);
    expect(prepared).toMatchObject({
      projectRoot: path.resolve(root, '.worktrees', 'parallel-change'),
      changeBranch: 'owner/parallel-change',
      createdBranch: true,
      createdWorktree: true,
      reusedWorktree: false,
    });
    await seedChange(prepared.projectRoot, 'parallel-change', 'owner/parallel-change');

    const reused = await preparePipelineWorkspace({
      projectRoot: root,
      name: 'parallel-change',
      isolation: 'worktree',
    });
    expect(reused).toMatchObject({
      projectRoot: prepared.projectRoot,
      createdWorktree: false,
      reusedWorktree: true,
    });

    const resolved = await resolvePipelineWorkspace({ projectRoot: root, name: 'parallel-change' });
    expect(resolved).toMatchObject({
      projectRoot: prepared.projectRoot,
      branch: 'owner/parallel-change',
      routed: true,
    });

    const selection = await selectCurrentChange(root, 'parallel-change');
    expect(selection.branch).toBe('owner/parallel-change');
    await expect(
      fs.access(path.join(prepared.projectRoot, '.owner', 'current-change.json')),
    ).resolves.toBeUndefined();
    await expect(fs.access(path.join(root, '.owner', 'current-change.json'))).rejects.toThrow();
  });

  it('recreates a linked worktree when its branch remains but registration is gone', async () => {
    const prepared = await preparePipelineWorkspace({
      projectRoot: root,
      name: 'recreated-change',
      isolation: 'worktree',
    });
    const branch = prepared.changeBranch!;
    const removedRoot = prepared.projectRoot;
    await fs.rm(removedRoot, { recursive: true, force: true });
    git(root, 'worktree', 'prune');
    expect(listGitWorktrees(root).some((entry) => entry.branch === branch)).toBe(false);
    await seedChange(root, 'recreated-change', branch);

    const resolved = await resolvePipelineWorkspace({
      projectRoot: root,
      name: 'recreated-change',
    });
    worktrees.push(resolved.projectRoot);
    expect(resolved).toMatchObject({
      branch,
      recreatedWorktree: true,
      routed: true,
    });
    expect(listGitWorktrees(root).find((entry) => entry.branch === branch)?.root).toBe(
      resolved.projectRoot,
    );
  });

  it('rejects traversal in the change name and worktree path', async () => {
    await expect(
      preparePipelineWorkspace({
        projectRoot: root,
        name: '../../outside',
        isolation: 'worktree',
      }),
    ).rejects.toThrow('Invalid change name');

    await expect(
      preparePipelineWorkspace({
        projectRoot: root,
        name: 'safe-change',
        isolation: 'worktree',
        worktreePath: path.resolve(root, '..', 'outside'),
      }),
    ).rejects.toThrow('must remain inside the primary worktree');
  });

  it('initializes a new Pipeline state with the prepared workspace binding', async () => {
    const result = await withPipelineCommandContext(
      { projectRoot: root, invocationCwd: root },
      () =>
        pipelineStateCommand(['init', 'serial-change', 'full', '--isolation', 'current'], {
          json: false,
          invocationCwd: root,
        }),
    );
    expect(result.exitCode).toBe(0);
    const state = await fs.readFile(
      path.join(root, 'openspec', 'changes', 'serial-change', '.owner.yaml'),
      'utf8',
    );
    expect(state).toContain('isolation: current');
    expect(state).toContain('bound_branch: main');
  });
});
