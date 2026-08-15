import { promises as fs } from 'node:fs';

import { inspectGitWorktree } from '../../platform/paths/git-worktree.js';

import { inspectLoopChildren, type LoopChildStatusProjection } from './loop-children.js';
import { loopPortableContinuation } from './loop-portable-continuation.js';
import { loopPortableChangeDir, readLoopPortableRuntime } from './loop-portable-runtime.js';
import type { LoopLocalExecutionState, LoopPortableState } from './loop-portable-types.js';
import type { LoopProjectPaths } from './loop-types.js';

export interface LoopPortableAcceptanceCounts {
  total: number;
  passed: number;
  failed: number;
  blocked: number;
  pending: number;
}

export interface LoopPortableStatusProjection {
  schema: 'owner.loop.status.v2';
  name: string;
  phase: LoopPortableState['phase'];
  status: LoopPortableState['status'];
  stateVersion: number;
  loop: LoopPortableState['loop'];
  acceptance: LoopPortableAcceptanceCounts;
  verificationResult: LoopPortableState['verification_result'];
  blockers: LoopPortableState['blockers'];
  builderHandoff: LoopPortableState['builder_handoff'];
  verification: LoopPortableState['verification'];
  history: LoopPortableState['history'];
  historyOverflow: LoopPortableState['history_overflow'];
  workspace: {
    projectRoot: string;
    isolation: LoopPortableState['workspace']['isolation'];
    bindingState: 'aligned' | 'mismatch';
    changeBranch: string | null;
    targetBranch: string | null;
    finish: LoopPortableState['workspace']['finish'];
    message: string | null;
  };
  localExecution: {
    status: 'available' | 'missing' | 'invalid' | 'stale' | 'not-expected';
    operation: LoopLocalExecutionState['execution'];
  };
  children?: LoopChildStatusProjection[];
  readyChildren?: string[];
  continuation: ReturnType<typeof loopPortableContinuation>;
  details?: {
    acceptance: LoopPortableState['acceptance'];
    specChanges: LoopPortableState['spec_changes'];
    workspace: LoopPortableState['workspace'];
    verificationReport: LoopPortableState['verification_report'];
  };
}

function counts(state: LoopPortableState): LoopPortableAcceptanceCounts {
  return state.acceptance.reduce<LoopPortableAcceptanceCounts>(
    (result, entry) => ({ ...result, [entry.result]: result[entry.result] + 1 }),
    { total: state.acceptance.length, passed: 0, failed: 0, blocked: 0, pending: 0 },
  );
}

function workspaceProjection(paths: LoopProjectPaths, state: LoopPortableState) {
  const context = inspectGitWorktree(paths.projectRoot);
  let message: string | null = null;
  if (state.workspace.change_branch !== null) {
    if (!context.isGitWorktree) {
      message = 'The Loop change requires a registered Git worktree.';
    } else if (context.currentBranch !== state.workspace.change_branch) {
      message = `Expected branch ${state.workspace.change_branch}, current branch is ${context.currentBranch ?? '(detached)'}.`;
    }
  }
  if (
    message === null &&
    state.workspace.isolation === 'worktree' &&
    !context.isSecondaryWorktree
  ) {
    message = 'The Loop change requires its linked worktree.';
  }
  return {
    projectRoot: paths.projectRoot,
    isolation: state.workspace.isolation,
    bindingState: message === null ? ('aligned' as const) : ('mismatch' as const),
    changeBranch: state.workspace.change_branch,
    targetBranch: state.workspace.target_branch,
    finish: state.workspace.finish,
    message,
  };
}

export async function inspectLoopPortableStatus(options: {
  paths: LoopProjectPaths;
  name: string;
  details?: boolean;
}): Promise<LoopPortableStatusProjection> {
  const runtime = await readLoopPortableRuntime(options);
  const localExpected = runtime.state.status === 'active' && runtime.state.loop.stage !== 'done';
  const workspace = workspaceProjection(options.paths, runtime.state);
  const children = await inspectLoopChildren({ paths: options.paths, state: runtime.state });
  const continuation = loopPortableContinuation(runtime.state, children);
  const effectiveContinuation =
    workspace.bindingState === 'mismatch'
      ? {
          ...continuation,
          disposition: 'await-user' as const,
          action: 'none' as const,
          commandArgs: null,
          requiredInputs: ['return-to-bound-workspace'],
          runnerAction: {
            ...continuation.runnerAction,
            kind: 'none' as const,
          },
        }
      : continuation;
  return {
    schema: 'owner.loop.status.v2',
    name: runtime.state.name,
    phase: runtime.state.phase,
    status: runtime.state.status,
    stateVersion: runtime.state.state_version,
    loop: runtime.state.loop,
    acceptance: counts(runtime.state),
    verificationResult: runtime.state.verification_result,
    blockers: runtime.state.blockers,
    builderHandoff: runtime.state.builder_handoff,
    verification: runtime.state.verification,
    history: runtime.state.history,
    historyOverflow: runtime.state.history_overflow,
    workspace,
    localExecution: {
      status: localExpected ? runtime.localStatus : 'not-expected',
      operation: runtime.localStatus === 'available' ? (runtime.local?.execution ?? null) : null,
    },
    ...(children
      ? {
          children: children.children,
          readyChildren: children.readyChildren,
        }
      : {}),
    continuation: effectiveContinuation,
    ...(options.details
      ? {
          details: {
            acceptance: runtime.state.acceptance,
            specChanges: runtime.state.spec_changes,
            workspace: runtime.state.workspace,
            verificationReport: runtime.state.verification_report,
          },
        }
      : {}),
  };
}

export async function listLoopPortableChangeNames(paths: LoopProjectPaths): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(paths.changesDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    try {
      const source = await fs.readFile(
        `${loopPortableChangeDir(paths, entry.name)}/owner-state.yaml`,
        'utf8',
      );
      if (/^schema:\s*owner\.loop\.v4\s*$/mu.test(source)) names.push(entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return names.sort((left, right) => left.localeCompare(right, 'en'));
}

export async function listLoopPortableStatus(options: {
  paths: LoopProjectPaths;
  offset?: number;
  limit?: number;
}): Promise<{
  schema: 'owner.loop.status-page.v2';
  items: LoopPortableStatusProjection[];
  total: number;
  nextOffset: number | null;
}> {
  const names = await listLoopPortableChangeNames(options.paths);
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 32;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('Loop status page bounds are invalid');
  }
  const selected = names.slice(offset, offset + limit);
  return {
    schema: 'owner.loop.status-page.v2',
    items: await Promise.all(
      selected.map((name) => inspectLoopPortableStatus({ paths: options.paths, name })),
    ),
    total: names.length,
    nextOffset: offset + selected.length < names.length ? offset + selected.length : null,
  };
}
