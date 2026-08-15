import {
  inspectDiscoveredLoopStatus,
  listDiscoveredLoopStatusPage,
} from './loop-status-discovery.js';
import {
  assertNoArguments,
  LoopUsageError,
  success,
  takeFlag,
  takeOption,
  type DispatchResult,
} from './loop-cli-shared.js';

export async function loopStatusCommand(
  args: string[],
  projectRoot: string,
): Promise<DispatchResult> {
  const details = takeFlag(args, '--details');
  const cursor = takeOption(args, '--cursor');
  const name = args[0]?.startsWith('--') ? undefined : args.shift();
  if (details && !name) throw new LoopUsageError('status --details requires a change name');
  if (cursor && name) throw new LoopUsageError('--cursor is only valid for status lists');
  if (cursor && details) throw new LoopUsageError('--cursor cannot be combined with --details');
  assertNoArguments(args);
  const data = name
    ? await inspectDiscoveredLoopStatus({
        projectRoot,
        name,
        details,
      })
    : await listDiscoveredLoopStatusPage({
        projectRoot,
        ...(cursor ? { cursor } : {}),
      });
  return success('status', data);
}
