import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  assertValidGitBranchName,
  gitWorktreeIsClean,
  runGitCommand,
} from '../../platform/process/git.js';
import {
  inspectGitWorktree,
  isLocalGitBranch,
  listGitWorktrees,
  listGitWorktreeRoots,
} from '../../platform/paths/git-worktree.js';

import { readProjectConfig, writeProjectConfig } from './loop-config.js';
import { withLoopLockRecovery } from './loop-lock.js';
import { loopProjectPaths } from './loop-paths.js';
import type { OwnerProjectConfig } from './loop-types.js';
import type { LoopWorkspaceBinding, LoopWorkspaceIsolation } from './loop-workspace.js';

export interface LoopWorkspacePreparation {
  isolation: LoopWorkspaceIsolation;
  projectRoot: string;
  changeBranch: string | null;
  targetBranch: string | null;
  worktreePath: string | null;
  createdBranch: boolean;
  createdWorktree: boolean;
  gitExcludeUpdated: boolean;
  configInitialized: boolean;
}

export interface PreparedLoopWorkspace {
  projectRoot: string;
  binding: LoopWorkspaceBinding;
  preparation: LoopWorkspacePreparation;
}

export class LoopWorkspacePreparationError extends Error {
  constructor(
    message: string,
    readonly preparation: LoopWorkspacePreparation,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'LoopWorkspacePreparationError';
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isInside(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

function loopConfigIdentity(config: OwnerProjectConfig): string {
  return JSON.stringify(config.loop);
}

async function ensureConfig(
  targetRoot: string,
  sourceConfig: OwnerProjectConfig | null,
): Promise<boolean> {
  const targetConfig = await readProjectConfig(targetRoot);
  if (targetConfig && sourceConfig) {
    if (loopConfigIdentity(targetConfig) !== loopConfigIdentity(sourceConfig)) {
      throw new Error(
        `Loop worktree configuration differs from the source project: ${path.join(targetRoot, '.owner', 'config.yaml')}`,
      );
    }
    return false;
  }
  if (!targetConfig && sourceConfig) {
    await writeProjectConfig(targetRoot, sourceConfig);
    return true;
  }
  return false;
}

async function appendLocalExclude(projectRoot: string, worktreePath: string): Promise<boolean> {
  if (!isInside(projectRoot, worktreePath)) return false;
  const relative = path.relative(projectRoot, worktreePath).replaceAll('\\', '/');
  const pattern = `/${relative.replace(/\/+$/u, '')}/`;
  const rawCommonDir = runGitCommand(projectRoot, ['rev-parse', '--git-common-dir']);
  const commonDir = path.resolve(projectRoot, rawCommonDir);
  const excludeFile = path.join(commonDir, 'info', 'exclude');
  let existing = '';
  try {
    existing = await fs.readFile(excludeFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (existing.split(/\r?\n/u).includes(pattern)) return false;
  await fs.mkdir(path.dirname(excludeFile), { recursive: true });
  const prefix = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  await fs.appendFile(excludeFile, `${prefix}${pattern}\n`, 'utf8');
  return true;
}

function resolveWorktreePath(
  primaryRoot: string,
  name: string,
  requested: string | undefined,
): string {
  const target = path.resolve(primaryRoot, requested ?? path.join('.worktrees', name));
  const commonDir = path.resolve(
    primaryRoot,
    runGitCommand(primaryRoot, ['rev-parse', '--git-common-dir']),
  );
  if (isInside(commonDir, target)) {
    throw new Error('Loop worktree path cannot be inside the Git common directory');
  }
  if (listGitWorktreeRoots(primaryRoot).some((root) => samePath(root, target))) {
    throw new Error(`Loop worktree path is already registered: ${target}`);
  }
  return target;
}

async function assertPathAbsent(target: string): Promise<void> {
  try {
    await fs.lstat(target);
    throw new Error(`Loop worktree path already exists: ${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function prepareLoopWorkspace(options: {
  projectRoot: string;
  name: string;
  isolation: LoopWorkspaceIsolation;
  changeBranch?: string;
  targetBranch?: string;
  worktreePath?: string;
  sourceConfig: OwnerProjectConfig | null;
}): Promise<PreparedLoopWorkspace> {
  const initialRoot = path.resolve(options.projectRoot);
  if (options.isolation === 'current') {
    if (options.changeBranch || options.targetBranch || options.worktreePath) {
      throw new Error(
        'Loop current isolation does not accept --change-branch, --target-branch, or --worktree-path',
      );
    }
    const context = inspectGitWorktree(initialRoot);
    if (context.isGitWorktree && context.currentBranch === null) {
      throw new Error('Loop workspace binding requires a branch; detached HEAD is not supported');
    }
    return {
      projectRoot: initialRoot,
      binding: {
        isolation: 'current',
        changeBranch: context.currentBranch,
        targetBranch: context.currentBranch,
      },
      preparation: {
        isolation: 'current',
        projectRoot: initialRoot,
        changeBranch: context.currentBranch,
        targetBranch: context.currentBranch,
        worktreePath: null,
        createdBranch: false,
        createdWorktree: false,
        gitExcludeUpdated: false,
        configInitialized: false,
      },
    };
  }

  const loopPaths = await loopProjectPaths(
    initialRoot,
    options.sourceConfig?.loop.artifact_root ?? 'docs',
  );
  return withLoopLockRecovery(
    [{ runtimeDir: loopPaths.runtimeDir, locksDir: loopPaths.locksDir }],
    `prepare Loop ${options.isolation} workspace`,
    async () => {
      const context = inspectGitWorktree(initialRoot);
      if (
        !context.isGitWorktree ||
        context.currentBranch === null ||
        context.primaryWorktreeRoot === null ||
        context.currentWorktreeRoot === null
      ) {
        throw new Error('Loop branch and worktree isolation require an attached Git branch');
      }
      const changeBranch = options.changeBranch ?? `owner/${options.name}`;
      assertValidGitBranchName(initialRoot, changeBranch);
      const alreadyPrepared = context.currentBranch === changeBranch;
      const targetBranch =
        options.targetBranch ?? (alreadyPrepared ? undefined : context.currentBranch);
      if (!targetBranch) {
        throw new Error(
          'Loop isolated workspace already on its change branch requires --target-branch',
        );
      }
      assertValidGitBranchName(initialRoot, targetBranch);
      if (!isLocalGitBranch(initialRoot, targetBranch)) {
        throw new Error(`Loop target branch is not a verified local branch: ${targetBranch}`);
      }

      if (options.isolation === 'branch') {
        if (options.worktreePath) {
          throw new Error('--worktree-path is only valid with --isolation worktree');
        }
        let createdBranch = false;
        if (!alreadyPrepared) {
          if (!gitWorktreeIsClean(initialRoot)) {
            throw new Error('Loop branch isolation requires a clean current working directory');
          }
          if (isLocalGitBranch(initialRoot, changeBranch)) {
            throw new Error(`Loop change branch already exists: ${changeBranch}`);
          }
          runGitCommand(initialRoot, ['switch', '-c', changeBranch, targetBranch]);
          createdBranch = true;
        }
        let configInitialized: boolean;
        try {
          configInitialized = await ensureConfig(initialRoot, options.sourceConfig);
        } catch (error) {
          throw new LoopWorkspacePreparationError(
            `Loop branch preparation is incomplete: ${(error as Error).message}`,
            {
              isolation: 'branch',
              projectRoot: initialRoot,
              changeBranch,
              targetBranch,
              worktreePath: null,
              createdBranch,
              createdWorktree: false,
              gitExcludeUpdated: false,
              configInitialized: false,
            },
            { cause: error },
          );
        }
        return {
          projectRoot: initialRoot,
          binding: { isolation: 'branch', changeBranch, targetBranch },
          preparation: {
            isolation: 'branch',
            projectRoot: initialRoot,
            changeBranch,
            targetBranch,
            worktreePath: null,
            createdBranch,
            createdWorktree: false,
            gitExcludeUpdated: false,
            configInitialized,
          },
        };
      }

      if (alreadyPrepared) {
        if (!context.isSecondaryWorktree) {
          throw new Error('Loop worktree isolation must use a linked Git worktree');
        }
        const requestedWorktreePath = options.worktreePath
          ? path.resolve(context.primaryWorktreeRoot, options.worktreePath)
          : undefined;
        if (
          requestedWorktreePath &&
          !samePath(requestedWorktreePath, context.currentWorktreeRoot)
        ) {
          throw new Error(
            `Loop worktree path ${requestedWorktreePath} does not match the current worktree ${context.currentWorktreeRoot}`,
          );
        }
        let configInitialized: boolean;
        try {
          configInitialized = await ensureConfig(initialRoot, options.sourceConfig);
        } catch (error) {
          throw new LoopWorkspacePreparationError(
            `Loop worktree preparation is incomplete: ${(error as Error).message}`,
            {
              isolation: 'worktree',
              projectRoot: initialRoot,
              changeBranch,
              targetBranch,
              worktreePath: initialRoot,
              createdBranch: false,
              createdWorktree: false,
              gitExcludeUpdated: false,
              configInitialized: false,
            },
            { cause: error },
          );
        }
        return {
          projectRoot: initialRoot,
          binding: { isolation: 'worktree', changeBranch, targetBranch },
          preparation: {
            isolation: 'worktree',
            projectRoot: initialRoot,
            changeBranch,
            targetBranch,
            worktreePath: initialRoot,
            createdBranch: false,
            createdWorktree: false,
            gitExcludeUpdated: false,
            configInitialized,
          },
        };
      }
      let entries = listGitWorktrees(context.primaryWorktreeRoot);
      const existing = entries.find((entry) => entry.branch === changeBranch);
      if (existing && (await pathExists(existing.root))) {
        const requestedWorktreePath = options.worktreePath
          ? path.resolve(context.primaryWorktreeRoot, options.worktreePath)
          : undefined;
        if (requestedWorktreePath && !samePath(requestedWorktreePath, existing.root)) {
          throw new Error(
            `Loop worktree branch ${changeBranch} is already checked out at ${existing.root}`,
          );
        }
        let configInitialized: boolean;
        try {
          configInitialized = await ensureConfig(existing.root, options.sourceConfig);
        } catch (error) {
          throw new LoopWorkspacePreparationError(
            `Loop worktree preparation is incomplete: ${(error as Error).message}`,
            {
              isolation: 'worktree',
              projectRoot: existing.root,
              changeBranch,
              targetBranch,
              worktreePath: existing.root,
              createdBranch: false,
              createdWorktree: false,
              gitExcludeUpdated: false,
              configInitialized: false,
            },
            { cause: error },
          );
        }
        return {
          projectRoot: existing.root,
          binding: { isolation: 'worktree', changeBranch, targetBranch },
          preparation: {
            isolation: 'worktree',
            projectRoot: existing.root,
            changeBranch,
            targetBranch,
            worktreePath: existing.root,
            createdBranch: false,
            createdWorktree: false,
            gitExcludeUpdated: false,
            configInitialized,
          },
        };
      }
      if (existing && !(await pathExists(existing.root))) {
        runGitCommand(context.primaryWorktreeRoot, ['worktree', 'prune']);
        entries = listGitWorktrees(context.primaryWorktreeRoot);
      }
      const branchExists = isLocalGitBranch(initialRoot, changeBranch);
      if (entries.some((entry) => entry.branch === changeBranch)) {
        throw new Error(`Loop change branch ${changeBranch} is already registered to a worktree`);
      }
      const worktreePath = resolveWorktreePath(
        context.primaryWorktreeRoot,
        options.name,
        options.worktreePath,
      );
      await assertPathAbsent(worktreePath);
      const gitExcludeUpdated = await appendLocalExclude(context.primaryWorktreeRoot, worktreePath);
      const preparation: LoopWorkspacePreparation = {
        isolation: 'worktree',
        projectRoot: worktreePath,
        changeBranch,
        targetBranch,
        worktreePath,
        createdBranch: false,
        createdWorktree: false,
        gitExcludeUpdated,
        configInitialized: false,
      };
      try {
        runGitCommand(
          context.primaryWorktreeRoot,
          branchExists
            ? ['worktree', 'add', worktreePath, changeBranch]
            : ['worktree', 'add', '-b', changeBranch, worktreePath, targetBranch],
        );
        preparation.createdBranch = !branchExists;
        preparation.createdWorktree = true;
        preparation.configInitialized = await ensureConfig(worktreePath, options.sourceConfig);
      } catch (error) {
        throw new LoopWorkspacePreparationError(
          `Loop worktree preparation is incomplete: ${(error as Error).message}`,
          preparation,
          { cause: error },
        );
      }
      return {
        projectRoot: worktreePath,
        binding: { isolation: 'worktree', changeBranch, targetBranch },
        preparation,
      };
    },
  );
}
