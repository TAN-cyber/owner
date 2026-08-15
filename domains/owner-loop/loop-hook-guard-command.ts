import { inspectLoopHookGuard, readLoopHookRequest } from './loop-hook-guard.js';
import {
  assertNoArguments,
  takeOption,
  LoopUsageError,
  type DispatchResult,
} from './loop-cli-shared.js';

export async function loopHookGuardCommand(
  args: string[],
  projectRoot: string,
): Promise<DispatchResult> {
  const hookOutput = takeOption(args, '--hook-output');
  if (hookOutput !== undefined && hookOutput !== 'copilot') {
    throw new LoopUsageError('--hook-output must be copilot');
  }
  assertNoArguments(args);
  const result = await inspectLoopHookGuard(projectRoot, await readLoopHookRequest());
  if (hookOutput === 'copilot') {
    return {
      command: 'hook-guard',
      exitCode: 0,
      data: result,
      text: result.allowed
        ? '{}\n'
        : `${JSON.stringify({
            permissionDecision: 'deny',
            permissionDecisionReason: result.reason,
          })}\n`,
    };
  }
  return result.allowed
    ? { command: 'hook-guard', exitCode: 0, data: result }
    : {
        command: 'hook-guard',
        exitCode: 2,
        data: result,
        error: { code: 'blocked', message: result.reason },
      };
}
