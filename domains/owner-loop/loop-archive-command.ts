import {
  archiveLoopPortableChange,
  hasLoopPortableArchiveRecovery,
  inspectLoopPortableArchive,
  LoopPortableArchiveOrderRequiredError,
} from './loop-portable-archive.js';
import { loopPortableContinuation } from './loop-portable-continuation.js';
import { migrateLoopLegacyChangeToPortable } from './loop-portable-migration-runtime.js';
import { recoverLoopPortableChange } from './loop-portable-recovery.js';
import { readLoopPortableTransaction } from './loop-portable-transactions.js';
import {
  isLoopPortableChange,
  readLoopPortableChange,
  setLoopPortableWorkspaceFinish,
} from './loop-portable-runtime.js';
import type { LoopWorkspaceFinish } from './loop-workspace.js';
import {
  finishArchivedLoopWorkspace,
  LoopWorkspaceFinishError,
  prepareLoopPortableWorkspaceFinish,
} from './loop-workspace-finish.js';
import {
  assertNoArguments,
  configuredPaths,
  LoopUsageError,
  requiredPositional,
  success,
  takeFlag,
  takeOption,
  type DispatchResult,
} from './loop-cli-shared.js';

export async function loopArchiveCommand(
  args: string[],
  projectRoot: string,
): Promise<DispatchResult> {
  const name = requiredPositional(args, 'change name');
  const dryRun = takeFlag(args, '--dry-run');
  const expectedPreflightHash = takeOption(args, '--expect-preflight');
  const confirmed = takeFlag(args, '--confirmed');
  const finishOption = takeOption(args, '--finish');
  const serialFirstOption = takeOption(args, '--serial-first');
  if (
    serialFirstOption !== undefined &&
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(serialFirstOption)
  ) {
    throw new LoopUsageError('--serial-first must be one Loop change name');
  }
  const finish = finishOption as LoopWorkspaceFinish | undefined;
  if (
    finish !== undefined &&
    finish !== 'merge' &&
    finish !== 'push' &&
    finish !== 'pull-request' &&
    finish !== 'keep'
  ) {
    throw new LoopUsageError('--finish must be merge, push, pull-request, or keep');
  }
  const configured = await configuredPaths(projectRoot);
  const portableActive = await isLoopPortableChange(configured.paths, name);
  const activeArchiveTransaction = portableActive
    ? await readLoopPortableTransaction(configured.paths, { kind: 'archive', change: name })
    : null;
  const portableRecoveryAvailable = portableActive
    ? false
    : await hasLoopPortableArchiveRecovery(configured.paths, name);
  if (portableActive || portableRecoveryAvailable) {
    if (expectedPreflightHash) {
      throw new LoopUsageError('Portable Loop Archive does not use preflight hashes');
    }
    if (dryRun && confirmed) {
      throw new LoopUsageError('--confirmed is only valid when executing Archive');
    }
    if (dryRun && serialFirstOption) {
      throw new LoopUsageError('--serial-first is only valid when executing Archive');
    }
    if (!dryRun && finish) {
      throw new LoopUsageError('--finish is only valid with --dry-run');
    }
    assertNoArguments(args);
    const recovery =
      portableActive && !dryRun && activeArchiveTransaction?.kind !== 'archive'
        ? await recoverLoopPortableChange({ paths: configured.paths, name })
        : null;
    let state =
      recovery?.state ??
      (portableActive ? await readLoopPortableChange(configured.paths, name) : null);
    if (recovery?.action === 'reverify' || recovery?.action === 'await-user') {
      return success(
        dryRun ? 'archive --dry-run' : 'archive',
        {
          archived: false,
          state: recovery.state,
          recovery,
          continuation: loopPortableContinuation(recovery.state),
        },
        `${recovery.message}\n`,
      );
    }
    if (dryRun) {
      if (!state) {
        return success(
          'archive --dry-run',
          {
            change: name,
            ready: true,
            archiveRecovery: true,
            continuation: {
              disposition: 'continue',
              reason: 'Resume the interrupted Loop Archive transaction.',
              commandArgs: ['owner', 'loop', 'archive', name, '--confirmed'],
              inputOptions: [],
              runnerAction: null,
            },
          },
          `Loop Archive recovery is ready for ${name}\n`,
        );
      }
      if (finish) {
        state = await setLoopPortableWorkspaceFinish({
          paths: configured.paths,
          name,
          finish,
        });
      } else if (state.workspace.isolation !== 'current' && state.workspace.finish === null) {
        throw new LoopUsageError(
          'Loop branch and worktree isolation require --finish with --dry-run',
        );
      }
      const preview = await inspectLoopPortableArchive({ paths: configured.paths, name });
      const baseContinuation = loopPortableContinuation(state);
      const continuation =
        preview.capabilityPeers.length > 0
          ? {
              ...baseContinuation,
              disposition: 'await-user' as const,
              action: 'none' as const,
              commandArgs: null,
              requiredInputs: ['choose-first-archive'],
              runnerAction: { ...baseContinuation.runnerAction, kind: 'none' as const },
            }
          : baseContinuation;
      return success(
        'archive --dry-run',
        {
          ...preview,
          workspaceFinish: state.workspace.finish,
          continuation,
        },
        `Loop Archive preview: ${preview.ready ? 'ready' : 'blocked'}\n`,
      );
    }
    if (configured.config.loop.archive_confirmation === 'required' && !confirmed) {
      throw new LoopUsageError(
        'archive requires --confirmed when loop.archive_confirmation is required',
      );
    }
    if (state && state.workspace.isolation !== 'current' && state.workspace.finish === null) {
      throw new LoopUsageError(
        'Loop branch and worktree isolation require a persisted --finish preview',
      );
    }
    let finishPlan = state
      ? await prepareLoopPortableWorkspaceFinish({
          paths: configured.paths,
          state,
        })
      : null;
    let result;
    try {
      result = await archiveLoopPortableChange({
        paths: configured.paths,
        name,
        ...(serialFirstOption ? { serialFirstChange: serialFirstOption } : {}),
      });
    } catch (error) {
      if (!(error instanceof LoopPortableArchiveOrderRequiredError)) throw error;
      if (!state) throw error;
      const preview = await inspectLoopPortableArchive({ paths: configured.paths, name });
      const commandArgs =
        error.peers.length > 0
          ? ['owner', 'loop', 'archive', name, '--confirmed', '--serial-first', name]
          : ['owner', 'loop', 'archive', name, '--confirmed'];
      return {
        command: 'archive',
        exitCode: 73,
        data: {
          ...preview,
          workspaceFinish: state.workspace.finish,
          workspaceFinishResult: null,
          continuation: {
            disposition: 'await-user',
            reason: error.message,
            commandArgs,
            inputOptions: error.peers.length > 0 ? ['serial-first-change'] : [],
            runnerAction: null,
          },
        },
        error: { code: 'conflict', message: error.message },
      };
    }
    state = result.state;
    if (!finishPlan && state.workspace.isolation !== 'current') {
      finishPlan = await prepareLoopPortableWorkspaceFinish({
        paths: configured.paths,
        state,
        archiveDir: result.archiveDir,
      });
    }
    let workspaceFinishResult = null;
    if (finishPlan) {
      try {
        workspaceFinishResult = await finishArchivedLoopWorkspace({
          paths: configured.paths,
          state: result.state,
          name,
          archiveDir: result.archiveDir,
          transactionId: result.transactionId,
          plan: finishPlan,
        });
      } catch (error) {
        if (!(error instanceof LoopWorkspaceFinishError)) throw error;
        return {
          command: 'archive',
          exitCode: 73,
          data: {
            ...result,
            workspaceFinish: result.state.workspace.finish,
            workspaceFinishResult: error.result,
            continuation: {
              disposition: 'blocked',
              reason: error.message,
              commandArgs: error.result.recoveryArgs,
              inputOptions: [],
              runnerAction: null,
            },
          },
          error: { code: 'conflict', message: error.message },
        };
      }
    }
    return success(
      'archive',
      {
        ...result,
        workspaceFinish: result.state.workspace.finish,
        workspaceFinishResult,
        continuation: loopPortableContinuation(result.state),
      },
      `Archived Loop change ${name} to ${result.archiveDir}\n`,
    );
  }
  if (serialFirstOption) {
    throw new LoopUsageError('--serial-first is only valid for portable Loop changes');
  }
  if (!dryRun && finish) {
    throw new LoopUsageError('--finish is only valid with --dry-run');
  }
  assertNoArguments(args);
  if (dryRun) {
    return {
      command: 'archive --dry-run',
      exitCode: 65,
      data: {
        change: name,
        migrationRequired: true,
        repairCommand: `owner loop doctor ${name} --repair`,
      },
      error: {
        code: 'invalid-data',
        message: `Loop active change ${name} must migrate before Archive preview`,
      },
    };
  }
  const state = await migrateLoopLegacyChangeToPortable({
    paths: configured.paths,
    name,
  });
  return success(
    'archive',
    {
      migration: { from: 'legacy', to: state.schema, completed: true },
      state,
      continuation: loopPortableContinuation(state),
    },
    `Migrated Loop change ${name}; follow the returned portable continuation before Archive\n`,
  );
}
