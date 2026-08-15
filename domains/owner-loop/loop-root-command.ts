import { readProjectConfig } from './loop-config.js';
import { loopProjectPaths } from './loop-paths.js';
import { moveLoopRoot } from './loop-root-move.js';
import {
  assertNoArguments,
  LoopUsageError,
  requiredPositional,
  success,
  type DispatchResult,
} from './loop-cli-shared.js';

export async function loopRootCommand(
  args: string[],
  projectRoot: string,
): Promise<DispatchResult> {
  const subcommand = requiredPositional(args, 'root subcommand');
  if (subcommand === 'show') {
    assertNoArguments(args);
    const config = await readProjectConfig(projectRoot);
    if (!config) throw new Error('.owner/config.yaml was not found');
    const paths = await loopProjectPaths(projectRoot, config.loop.artifact_root);
    return success('root show', {
      projectRoot,
      artifactRoot: config.loop.artifact_root,
      language: config.loop.language,
      loopRoot: paths.loopRoot,
      pendingRootMove: config.loop.pending_root_move ?? null,
    });
  }
  if (subcommand === 'move') {
    const target = requiredPositional(args, 'artifact root');
    assertNoArguments(args);
    const result = await moveLoopRoot({ projectRoot, toArtifactRoot: target });
    return success('root move', result, `Moved Owner Loop to ${result.toLoopRoot}\n`);
  }
  throw new LoopUsageError(`Unknown root command: ${subcommand}`);
}
