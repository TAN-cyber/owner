import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  finishArchivedLoopWorkspace,
  LoopWorkspaceFinishError,
} from '../../../domains/owner-loop/loop-workspace-finish.js';
import { loopProjectPaths } from '../../../domains/owner-loop/loop-paths.js';
import type { LoopChangeState } from '../../../domains/owner-loop/loop-types.js';

describe('Loop workspace finish recovery', () => {
  let projectRoot: string;
  let targetBranch: string;
  const changeBranch = 'owner/conflicting-merge';

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-workspace-finish-'));
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'loop@example.test'], { cwd: projectRoot });
    execFileSync('git', ['config', 'user.name', 'Loop Test'], { cwd: projectRoot });
    await fs.writeFile(path.join(projectRoot, 'shared.txt'), 'base\n');
    execFileSync('git', ['add', 'shared.txt'], { cwd: projectRoot, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'baseline'], { cwd: projectRoot, stdio: 'ignore' });
    targetBranch = execFileSync('git', ['branch', '--show-current'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['switch', '-c', changeBranch], { cwd: projectRoot, stdio: 'ignore' });
    await fs.writeFile(path.join(projectRoot, 'shared.txt'), 'change\n');
    execFileSync('git', ['add', 'shared.txt'], { cwd: projectRoot, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'change branch'], { cwd: projectRoot, stdio: 'ignore' });
    execFileSync('git', ['switch', targetBranch], { cwd: projectRoot, stdio: 'ignore' });
    await fs.writeFile(path.join(projectRoot, 'shared.txt'), 'target\n');
    execFileSync('git', ['add', 'shared.txt'], { cwd: projectRoot, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'target branch'], { cwd: projectRoot, stdio: 'ignore' });
    execFileSync('git', ['switch', changeBranch], { cwd: projectRoot, stdio: 'ignore' });
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('aborts a failed branch merge and restores the change branch', async () => {
    const paths = await loopProjectPaths(projectRoot, '.');
    const state = {
      name: 'conflicting-merge',
      spec_changes: [],
    } as LoopChangeState;

    await expect(
      finishArchivedLoopWorkspace({
        paths,
        state,
        name: state.name,
        archiveDir: path.join(projectRoot, 'archive'),
        transactionId: 'transaction-id',
        plan: {
          finish: 'merge',
          changeRoot: projectRoot,
          primaryRoot: projectRoot,
          changeBranch,
          targetBranch,
          targetRoot: projectRoot,
          remote: null,
          isolation: 'branch',
        },
      }),
    ).rejects.toBeInstanceOf(LoopWorkspaceFinishError);

    expect(
      execFileSync('git', ['branch', '--show-current'], {
        cwd: projectRoot,
        encoding: 'utf8',
      }).trim(),
    ).toBe(changeBranch);
    expect(() =>
      execFileSync('git', ['rev-parse', '--verify', 'MERGE_HEAD'], {
        cwd: projectRoot,
        stdio: 'ignore',
      }),
    ).toThrow();
  });
});
