import { inspectLoopStatus } from './loop-diagnostics.js';
import { checkpointLoopChange } from './loop-progress-checkpoint.js';
import {
  assertNoArguments,
  configuredPaths,
  LoopUsageError,
  requiredPositional,
  revisionOption,
  success,
  takeMany,
  takeOption,
  type DispatchResult,
} from './loop-cli-shared.js';

export async function loopCheckpointCommand(
  args: string[],
  projectRoot: string,
): Promise<DispatchResult> {
  const name = requiredPositional(args, 'change name');
  const summary = takeOption(args, '--summary');
  if (!summary) throw new LoopUsageError('--summary is required');
  const nextAction = takeOption(args, '--next-action');
  if (!nextAction) throw new LoopUsageError('--next-action is required');
  const artifacts = takeMany(args, '--artifact');
  const expectedRevision = revisionOption(args);
  assertNoArguments(args);
  const { config, paths } = await configuredPaths(projectRoot);
  const result = await checkpointLoopChange({
    paths,
    name,
    summary,
    nextAction,
    artifacts,
    expectedRevision,
  });
  const status = await inspectLoopStatus(paths, name, {
    clarificationMode: config.loop.clarification_mode,
    maxVerifyFailures: config.loop.max_verify_failures,
  });
  return success('checkpoint', {
    ...result,
    continuation: status.continuation,
  });
}
