import { defaultProjectConfig, readProjectConfig } from './loop-config.js';
import { ensureLoopDirectories, loopProjectPaths } from './loop-paths.js';
import { loopPortableContinuation } from './loop-portable-continuation.js';
import { createLoopPortableChange } from './loop-portable-runtime.js';
import { selectLoopChange } from './loop-selection.js';
import { prepareLoopWorkspace } from './loop-workspace-preparation.js';
import { type LoopWorkspaceIsolation } from './loop-workspace.js';
import {
  assertNoArguments,
  languageOption,
  LoopUsageError,
  requiredPositional,
  success,
  takeOption,
  type DispatchResult,
} from './loop-cli-shared.js';

export async function loopNewCommand(args: string[], projectRoot: string): Promise<DispatchResult> {
  const name = requiredPositional(args, 'change name');
  let config = await readProjectConfig(projectRoot);
  const language = languageOption(args, config?.loop.language ?? 'en');
  const isolation = (takeOption(args, '--isolation') ?? 'current') as LoopWorkspaceIsolation;
  if (isolation !== 'current' && isolation !== 'branch' && isolation !== 'worktree') {
    throw new LoopUsageError('--isolation must be current, branch, or worktree');
  }
  const changeBranch = takeOption(args, '--change-branch');
  const targetBranch = takeOption(args, '--target-branch');
  const worktreePath = takeOption(args, '--worktree-path');
  assertNoArguments(args);
  const sourceConfig = config;
  if (config?.loop.pending_root_move) {
    throw new Error(`Loop root move ${config.loop.pending_root_move.id} is incomplete`);
  }
  const prepared = await prepareLoopWorkspace({
    projectRoot,
    name,
    isolation,
    ...(changeBranch ? { changeBranch } : {}),
    ...(targetBranch ? { targetBranch } : {}),
    ...(worktreePath ? { worktreePath } : {}),
    sourceConfig,
  });
  projectRoot = prepared.projectRoot;
  config = await readProjectConfig(projectRoot);
  const initialProjectConfig = config === null ? defaultProjectConfig('docs', language) : undefined;
  if (!config) config = initialProjectConfig!;
  if (config.loop.pending_root_move) {
    throw new Error(`Loop root move ${config.loop.pending_root_move.id} is incomplete`);
  }
  const paths = await loopProjectPaths(projectRoot, config.loop.artifact_root);
  await ensureLoopDirectories(paths);
  const state = await createLoopPortableChange({
    paths,
    name,
    language,
    workspaceBinding: prepared.binding,
    ...(initialProjectConfig ? { initialProjectConfig } : {}),
  });
  await selectLoopChange(paths, state.name);
  return success(
    'new',
    {
      ...state,
      preparation: prepared.preparation,
      continuation: loopPortableContinuation(state),
    },
    `Created Loop change ${state.name}\n`,
  );
}
