import type { PipelineCommandHandler } from './pipeline-cli.js';
import { pipelineCommandProjectRoot } from './pipeline-command-context.js';
import {
  pipelineWorkspaceCommandResult,
  preparePipelineWorkspace,
  resolvePipelineWorkspace,
  type PipelineWorkspaceIsolation,
} from './pipeline-workspace.js';

function usage(): never {
  throw new Error(
    'Usage: owner pipeline workspace prepare <change-name> --isolation <current|branch|worktree> [--change-branch <branch>] [--target-branch <branch>] [--worktree-path <path>] | owner pipeline workspace resolve <change-name>',
  );
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

export const pipelineWorkspaceCommand: PipelineCommandHandler = async (args) => {
  const [action, name, ...rest] = args;
  if (!action || !name) usage();
  if (action === 'resolve') {
    if (rest.length > 0) usage();
    return pipelineWorkspaceCommandResult(
      'resolve',
      await resolvePipelineWorkspace({ projectRoot: pipelineCommandProjectRoot(), name }),
    );
  }
  if (action !== 'prepare') usage();
  const isolation = option(rest, '--isolation') as PipelineWorkspaceIsolation | undefined;
  if (!isolation || !['current', 'branch', 'worktree'].includes(isolation)) {
    throw new Error('--isolation must be current, branch, or worktree');
  }
  const changeBranch = option(rest, '--change-branch');
  const targetBranch = option(rest, '--target-branch');
  const worktreePath = option(rest, '--worktree-path');
  if (rest.length > 0) usage();
  return pipelineWorkspaceCommandResult(
    'prepare',
    await preparePipelineWorkspace({
      projectRoot: pipelineCommandProjectRoot(),
      name,
      isolation,
      ...(changeBranch ? { changeBranch } : {}),
      ...(targetBranch ? { targetBranch } : {}),
      ...(worktreePath ? { worktreePath } : {}),
    }),
  );
};
