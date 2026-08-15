import {
  defaultProjectConfig,
  mergeLoopSnapshotExcludes,
  readProjectConfig,
  writeProjectConfig,
} from './loop-config.js';
import { ensureOwnerProjectGitignore } from '../workflow-contract/project-gitignore.js';
import { ensureLoopDirectories, loopProjectPaths, normalizeArtifactRootRef } from './loop-paths.js';
import {
  assertNoArguments,
  languageOption,
  success,
  takeOption,
  type DispatchResult,
} from './loop-cli-shared.js';

export async function loopInitCommand(
  args: string[],
  projectRoot: string,
): Promise<DispatchResult> {
  const requestedRoot = takeOption(args, '--root');
  const existing = await readProjectConfig(projectRoot);
  const language = languageOption(args, existing?.loop.language ?? 'en');
  assertNoArguments(args);
  if (existing?.loop.pending_root_move) {
    throw new Error(`Loop root move ${existing.loop.pending_root_move.id} is incomplete`);
  }
  const artifactRoot = normalizeArtifactRootRef(
    requestedRoot ?? existing?.loop.artifact_root ?? 'docs',
  );
  if (existing && requestedRoot && existing.loop.artifact_root !== artifactRoot) {
    throw new Error(
      `Configured Loop artifact root is ${existing.loop.artifact_root}; refusing conflicting root ${artifactRoot}`,
    );
  }
  const config = existing
    ? {
        ...existing,
        loop: {
          ...existing.loop,
          language,
          snapshot: {
            ...existing.loop.snapshot,
            exclude: mergeLoopSnapshotExcludes(existing.loop.snapshot.exclude),
          },
        },
      }
    : defaultProjectConfig(artifactRoot, language);
  const paths = await loopProjectPaths(projectRoot, config.loop.artifact_root);
  await ensureLoopDirectories(paths);
  await ensureOwnerProjectGitignore(projectRoot);
  await writeProjectConfig(projectRoot, config);
  return success(
    'init',
    {
      projectRoot,
      artifactRoot: config.loop.artifact_root,
      loopRoot: paths.loopRoot,
      language,
    },
    `Initialized Owner Loop at ${paths.loopRoot}\n`,
  );
}
