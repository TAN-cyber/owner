import { inspectLoopChildren } from './loop-children.js';
import { loopPortableContinuation } from './loop-portable-continuation.js';
import { migrateLoopLegacyChangeToPortable } from './loop-portable-migration-runtime.js';
import { recoverLoopPortableChange } from './loop-portable-recovery.js';
import { applyLoopRunnerInput, readLoopRunnerInput } from './loop-runner-input.js';
import { LOOP_SKILL_COORDINATION } from './loop-runner-protocol.js';
import {
  completeLoopPortableParentBuild,
  confirmLoopPortableShape,
  confirmLoopPortableSkillCoordinatedPass,
  confirmLoopPortableVerifierUnavailable,
  inspectLoopPortableAcceptanceDrift,
  isLoopPortableChange,
  resolveLoopPortableVerifierBlocker,
  returnLoopPortableChangeToBuild,
  returnLoopPortableChangeToShape,
  retryLoopPortableVerifier,
} from './loop-portable-runtime.js';
import type { LoopPortableState } from './loop-portable-types.js';
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
import type { LoopProjectPaths } from './loop-types.js';

async function portableParentView(paths: LoopProjectPaths, state: LoopPortableState) {
  const children = await inspectLoopChildren({ paths, state });
  return {
    ...(children
      ? {
          children: children.children,
          readyChildren: children.readyChildren,
        }
      : {}),
    continuation: loopPortableContinuation(state, children),
  };
}

export async function loopNextCommand(
  args: string[],
  projectRoot: string,
): Promise<DispatchResult> {
  const name = requiredPositional(args, 'change name');
  const summary = takeOption(args, '--summary');
  const runnerInputFile = takeOption(args, '--runner-input');
  const confirmed = takeFlag(args, '--confirmed');
  const returnToBuild = takeFlag(args, '--return-to-build');
  const retryVerifier = takeFlag(args, '--retry-verifier');
  const resolveVerifierBlocker = takeFlag(args, '--resolve-verifier-blocker');
  if (
    [confirmed, returnToBuild, retryVerifier, resolveVerifierBlocker].filter(Boolean).length > 1
  ) {
    throw new LoopUsageError(
      '--confirmed, --return-to-build, --retry-verifier, and --resolve-verifier-blocker are mutually exclusive',
    );
  }
  // Agent-authored Build/Verify completion fields retired with Loop v4.
  // Parsing the complete public surface before migration prevents a legacy
  // invocation from silently accepting one of those old fields.
  assertNoArguments(args);

  const configured = await configuredPaths(projectRoot);
  if (!(await isLoopPortableChange(configured.paths, name))) {
    if (runnerInputFile) {
      throw new LoopUsageError('--runner-input is only valid for portable Loop changes');
    }
    if (!summary) throw new LoopUsageError('--summary is required');
    // The first mutating command on a legacy active change performs the
    // deterministic migration and stops at the resulting stable boundary.
    const state = await migrateLoopLegacyChangeToPortable({
      paths: configured.paths,
      name,
    });
    return success('next', {
      state,
      migration: { completed: true, summary },
      continuation: loopPortableContinuation(state),
    });
  }

  if (runnerInputFile) {
    if (summary || confirmed || returnToBuild || retryVerifier || resolveVerifierBlocker) {
      throw new LoopUsageError(
        '--runner-input cannot be combined with --summary or Agent transition flags',
      );
    }
    const recovery = await recoverLoopPortableChange({
      paths: configured.paths,
      name,
      preserveRunningExecution: true,
    });
    const current = recovery.state;
    if (
      recovery.action === 'await-user' ||
      recovery.action === 'done' ||
      recovery.reason !== 'available'
    ) {
      return success('next', {
        state: current,
        recovery,
        ...(await portableParentView(configured.paths, current)),
      });
    }
    if (current.phase === 'build') {
      const drift = await inspectLoopPortableAcceptanceDrift({
        paths: configured.paths,
        state: current,
      });
      if (drift.drifted) {
        const state = await returnLoopPortableChangeToShape({
          paths: configured.paths,
          name,
          reason: drift.reason ?? 'Loop confirmed requirements changed',
        });
        return success('next', {
          state,
          ...(await portableParentView(configured.paths, state)),
        });
      }
      if (await inspectLoopChildren({ paths: configured.paths, state: current })) {
        throw new LoopUsageError(
          'Loop parent Build advances child changes and does not accept a Builder handoff',
        );
      }
    }
    const input = await readLoopRunnerInput(runnerInputFile, projectRoot);
    const result = await applyLoopRunnerInput({
      paths: configured.paths,
      name,
      input,
      maxVerifyFailures: configured.config.loop.max_verify_failures,
    });
    return success('next', {
      ...result,
      ...(await portableParentView(configured.paths, result.state)),
      coordination: LOOP_SKILL_COORDINATION,
    });
  }
  const recovery = await recoverLoopPortableChange({ paths: configured.paths, name });
  const current = recovery.state;
  if (!summary) throw new LoopUsageError('--summary is required');
  let state;
  if (confirmed) {
    if (current.phase === 'shape') {
      state = await confirmLoopPortableShape({ paths: configured.paths, name });
    } else if (
      current.phase === 'verify' &&
      current.status === 'await-user' &&
      current.loop.next_action === 'confirm-skill-coordinated-pass'
    ) {
      state = await confirmLoopPortableSkillCoordinatedPass({
        paths: configured.paths,
        name,
      });
    } else if (
      current.phase === 'verify' &&
      current.status === 'await-user' &&
      current.loop.next_action === 'confirm-verifier-unavailable'
    ) {
      state = await confirmLoopPortableVerifierUnavailable({
        paths: configured.paths,
        name,
        summary,
      });
    } else {
      throw new LoopUsageError(
        '--confirmed is only valid in Shape, for an accepted Skill-coordinated pass, or for a user-accepted degraded verification fallback',
      );
    }
  } else if (returnToBuild) {
    state = await returnLoopPortableChangeToBuild({
      paths: configured.paths,
      name,
      reason: summary,
    });
  } else if (retryVerifier) {
    state = await retryLoopPortableVerifier({ paths: configured.paths, name });
  } else if (resolveVerifierBlocker) {
    state = await resolveLoopPortableVerifierBlocker({ paths: configured.paths, name });
  } else {
    if (recovery.reason !== 'available') {
      return success('next', {
        state: current,
        recovery,
        ...(await portableParentView(configured.paths, current)),
      });
    }
    if (current.phase === 'build') {
      const drift = await inspectLoopPortableAcceptanceDrift({
        paths: configured.paths,
        state: current,
      });
      if (drift.drifted) {
        state = await returnLoopPortableChangeToShape({
          paths: configured.paths,
          name,
          reason: drift.reason ?? 'Loop confirmed requirements changed',
        });
      } else {
        const children = await inspectLoopChildren({ paths: configured.paths, state: current });
        if (children) {
          if (
            children.allDone &&
            !(current.loop.stage === 'repairing' && current.verification_result === 'fail')
          ) {
            state = await completeLoopPortableParentBuild({
              paths: configured.paths,
              name,
              summary,
            });
          } else {
            return success('next', {
              state: current,
              children: children.children,
              readyChildren: children.readyChildren,
              continuation: loopPortableContinuation(current, children),
            });
          }
        }
      }
    }
    if (state) {
      return success('next', {
        state,
        ...(await portableParentView(configured.paths, state)),
      });
    }
    return {
      command: 'next',
      exitCode: 65,
      data: { state: current, continuation: loopPortableContinuation(current) },
      error: {
        code: 'invalid-data',
        message:
          'This Loop step requires the skill-coordinated --runner-input action returned by continuation; public JSON cannot supply identity, provider, execution ref, or candidate binding',
      },
    };
  }
  return success('next', {
    state,
    ...(await portableParentView(configured.paths, state)),
  });
}
