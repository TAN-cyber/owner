import { inspectLoopStatus } from './loop-diagnostics.js';
import { inspectLoopPortableStatus } from './loop-portable-status.js';
import { isLoopPortableChange } from './loop-portable-runtime.js';
import { selectLoopChange } from './loop-selection.js';
import {
  assertNoArguments,
  configuredPaths,
  requiredPositional,
  success,
  type DispatchResult,
} from './loop-cli-shared.js';

export async function loopSelectCommand(
  args: string[],
  projectRoot: string,
): Promise<DispatchResult> {
  const name = requiredPositional(args, 'change name');
  assertNoArguments(args);
  const { config, paths } = await configuredPaths(projectRoot);
  await selectLoopChange(paths, name);
  const status = (await isLoopPortableChange(paths, name))
    ? await inspectLoopPortableStatus({ paths, name })
    : await inspectLoopStatus(paths, name, {
        clarificationMode: config.loop.clarification_mode,
        maxVerifyFailures: config.loop.max_verify_failures,
      });
  return success(
    'select',
    { selected: name, continuation: status.continuation },
    `Selected Loop change ${name}\n`,
  );
}
