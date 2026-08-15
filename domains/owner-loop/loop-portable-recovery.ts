import { promises as fs } from 'node:fs';
import path from 'node:path';

import { inspectGitWorktree } from '../../platform/paths/git-worktree.js';

import {
  readLoopLocalExecution,
  rebuildLoopLocalExecution,
  writeLoopLocalExecution,
} from './loop-local-execution.js';
import { withLoopMutationLock } from './loop-mutation-lock.js';
import {
  loopLocalExecutionFile,
  loopPortableStateFile,
  ensureLoopPortableReport,
  readLoopPortableChange,
} from './loop-portable-runtime.js';
import {
  appendLoopPortableHistory,
  compareAndSwapLoopPortableState,
  parseLoopPortableState,
} from './loop-portable-state.js';
import { returnLoopCandidateToBuild } from './loop-loop-runtime.js';
import { toLoopPortableText } from './loop-portable-text.js';
import type { LoopLocalExecutionState, LoopPortableState } from './loop-portable-types.js';
import type { LoopProjectPaths } from './loop-types.js';

export interface LoopPortableRecoveryResult {
  state: LoopPortableState;
  local: LoopLocalExecutionState | null;
  action: 'resume-stable-boundary' | 'reverify' | 'await-user' | 'done';
  reason:
    | 'available'
    | 'missing'
    | 'invalid'
    | 'stale'
    | 'interrupted'
    | 'workspace-mismatch'
    | 'done';
  message: string;
}

function workspaceMismatch(paths: LoopProjectPaths, state: LoopPortableState): string | null {
  const context = inspectGitWorktree(paths.projectRoot);
  if (state.workspace.change_branch !== null) {
    if (!context.isGitWorktree) return 'The portable change requires a Git branch/worktree';
    if (context.currentBranch !== state.workspace.change_branch) {
      return `Expected Loop change branch ${state.workspace.change_branch}, current branch is ${context.currentBranch ?? '(detached)'}`;
    }
  }
  if (state.workspace.isolation === 'current') return null;
  if (!context.isGitWorktree) return 'The portable change requires a Git branch/worktree';
  if (state.workspace.isolation === 'worktree' && !context.isSecondaryWorktree) {
    return 'The portable change requires its linked worktree';
  }
  return null;
}

function resetAcceptance(state: LoopPortableState): LoopPortableState['acceptance'] {
  return state.acceptance.map((entry) => ({ ...entry, result: 'pending', reason: null }));
}

function reverifyAfterMissingRuntime(state: LoopPortableState, reason: string): LoopPortableState {
  const completedAt = new Date().toISOString();
  const historical =
    state.verification === null
      ? state
      : appendLoopPortableHistory(state, {
          goal_cycle: state.loop.goal_cycle,
          iteration: state.loop.iteration,
          attempt: state.loop.attempt,
          outcome: 'recovery',
          unresolved_ids: [],
          summary: toLoopPortableText(reason),
          completed_at: completedAt,
        });
  return parseLoopPortableState({
    ...historical,
    phase: 'verify',
    status: 'active',
    state_version: state.state_version + 1,
    acceptance: resetAcceptance(state),
    verification: null,
    verification_result: 'pending',
    verification_report: null,
    blockers: [],
    loop: {
      ...state.loop,
      stage: 'verify-ready',
      next_action: 'run-required-checks-and-dispatch-verifier',
    },
  });
}

async function inspectLocal(file: string): Promise<{
  local: LoopLocalExecutionState | null;
  reason: 'available' | 'missing' | 'invalid' | 'stale';
}> {
  try {
    const local = await readLoopLocalExecution(file);
    return local === null ? { local: null, reason: 'missing' } : { local, reason: 'available' };
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code &&
      (error as NodeJS.ErrnoException).code !== 'ENOENT'
    ) {
      throw error;
    }
    return { local: null, reason: 'invalid' };
  }
}

export async function recoverLoopPortableChange(options: {
  paths: LoopProjectPaths;
  name: string;
  preserveRunningExecution?: boolean;
}): Promise<LoopPortableRecoveryResult> {
  return withLoopMutationLock(
    options.paths,
    `recover portable change ${options.name}`,
    async () => {
      let state = await readLoopPortableChange(options.paths, options.name);
      if (state.status === 'done') {
        await ensureLoopPortableReport({ paths: options.paths, state });
        return {
          state,
          local: null,
          action: 'done',
          reason: 'done',
          message: 'Archived Loop changes do not require a local execution overlay.',
        };
      }
      const mismatch = workspaceMismatch(options.paths, state);
      if (mismatch) {
        return {
          state,
          local: null,
          action: 'await-user',
          reason: 'workspace-mismatch',
          message: mismatch,
        };
      }

      const file = loopLocalExecutionFile(options.paths, options.name);
      const inspected = await inspectLocal(file);
      let reason: LoopPortableRecoveryResult['reason'] =
        inspected.reason === 'available' &&
        (inspected.local?.change !== state.name ||
          inspected.local?.basedOnStateVersion !== state.state_version)
          ? 'stale'
          : inspected.reason;
      const operationWasInterrupted =
        reason === 'available' &&
        !options.preserveRunningExecution &&
        inspected.local?.execution !== null &&
        inspected.local?.execution?.status !== 'completed';
      if (operationWasInterrupted && inspected.local) {
        reason = 'interrupted';
        if (inspected.local.execution?.status === 'running') {
          inspected.local = {
            ...inspected.local,
            execution: { ...inspected.local.execution, status: 'interrupted' },
            checks: inspected.local.checks.map((check) =>
              check.status === 'planned' || check.status === 'running'
                ? { ...check, status: 'interrupted' }
                : check,
            ),
          };
          await writeLoopLocalExecution(file, inspected.local, {
            containedRoot: options.paths.runtimeDir,
          });
        }
      }
      if (reason === 'available') {
        await ensureLoopPortableReport({ paths: options.paths, state });
        return {
          state,
          local: inspected.local,
          action: 'resume-stable-boundary',
          reason,
          message: 'Loop local execution overlay matches the portable state.',
        };
      }

      const unsafeInterruptedCheck =
        reason === 'interrupted'
          ? inspected.local?.checks.find(
              (check) => check.status === 'interrupted' && !check.repeatable,
            )
          : undefined;
      if (unsafeInterruptedCheck) {
        const next = returnLoopCandidateToBuild({
          state,
          reason: `Check ${unsafeInterruptedCheck.id} was interrupted and is not declared repeatable; a new Builder candidate is required before retrying.`,
        });
        state = await compareAndSwapLoopPortableState({
          file: loopPortableStateFile(options.paths, state.name),
          expectedStateVersion: state.state_version,
          next,
          containedRoot: options.paths.loopRoot,
        });
        await fs.rm(path.join(options.paths.changesDir, options.name, 'verification.md'), {
          force: true,
        });
        const local = rebuildLoopLocalExecution({
          portableState: state,
          projectRoot: options.paths.projectRoot,
          branch: state.workspace.change_branch,
        });
        await writeLoopLocalExecution(file, local, {
          containedRoot: options.paths.runtimeDir,
        });
        return {
          state,
          local,
          action: 'resume-stable-boundary',
          reason,
          message: `Loop check ${unsafeInterruptedCheck.id} was not repeatable; the change returned to Build for a new candidate.`,
        };
      }

      const lostVerifier =
        state.phase === 'verify' && state.loop.next_action === 'await-verifier-result';
      const lostArchivePass =
        state.phase === 'archive' &&
        state.loop.stage === 'archive-ready' &&
        state.verification_result === 'pass';
      const mustReverify = lostVerifier || lostArchivePass;
      if (mustReverify) {
        const next = reverifyAfterMissingRuntime(
          state,
          lostArchivePass
            ? 'Local Runtime was unavailable at Archive ready; the synchronized implementation must be verified again.'
            : 'The previous Verifier execution was unavailable; dispatch a new attempt from the stable Verify boundary.',
        );
        state = await compareAndSwapLoopPortableState({
          file: loopPortableStateFile(options.paths, state.name),
          expectedStateVersion: state.state_version,
          next,
          containedRoot: options.paths.loopRoot,
        });
      }
      const local = rebuildLoopLocalExecution({
        portableState: state,
        projectRoot: options.paths.projectRoot,
        branch: inspectGitWorktree(options.paths.projectRoot).currentBranch,
      });
      await fs.mkdir(path.dirname(loopLocalExecutionFile(options.paths, state.name)), {
        recursive: true,
      });
      await writeLoopLocalExecution(file, local, { containedRoot: options.paths.runtimeDir });
      await ensureLoopPortableReport({ paths: options.paths, state });
      return {
        state,
        local,
        action: mustReverify ? 'reverify' : 'resume-stable-boundary',
        reason,
        message: mustReverify
          ? 'Rebuilt local execution from the portable boundary; previous pass/execution was not reused.'
          : `Rebuilt local execution from the portable ${state.phase}/${state.loop.stage} boundary.`,
      };
    },
  );
}
