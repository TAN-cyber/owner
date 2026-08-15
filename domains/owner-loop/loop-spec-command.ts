import { loopPortableContinuation } from './loop-portable-continuation.js';
import { migrateLoopLegacyChangeToPortable } from './loop-portable-migration-runtime.js';
import { isLoopPortableChange, markLoopPortableSpecRemoval } from './loop-portable-runtime.js';
import {
  assertNoArguments,
  configuredPaths,
  LoopUsageError,
  requiredPositional,
  success,
  type DispatchResult,
} from './loop-cli-shared.js';

export async function loopSpecCommand(
  args: string[],
  projectRoot: string,
): Promise<DispatchResult> {
  const subcommand = requiredPositional(args, 'spec subcommand');
  if (subcommand !== 'remove') {
    throw new LoopUsageError(`Unknown spec command: ${subcommand}`);
  }
  const name = requiredPositional(args, 'change name');
  const capability = requiredPositional(args, 'capability');
  assertNoArguments(args);

  const { paths } = await configuredPaths(projectRoot);
  if (!(await isLoopPortableChange(paths, name))) {
    await migrateLoopLegacyChangeToPortable({ paths, name });
  }
  const state = await markLoopPortableSpecRemoval({ paths, name, capability });
  return success(
    'spec remove',
    { ...state, continuation: loopPortableContinuation(state) },
    `Marked Loop capability ${capability} for removal in ${name}\n`,
  );
}
