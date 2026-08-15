import path from 'path';

import {
  DEFAULT_WORKFLOW_LOOP_MAX_VERIFY_FAILURES,
  DEFAULT_WORKFLOW_LOOP_SNAPSHOT_CONFIG,
  defaultWorkflowProjectConfig,
  mergeWorkflowLoopSnapshotExcludes,
  MAX_WORKFLOW_SNAPSHOT_PATTERN_LENGTH,
  MAX_WORKFLOW_SNAPSHOT_PATTERN_WILDCARDS,
  mergeWorkflowProjectConfigDocument,
  normalizeWorkflowSnapshotPattern,
  renderStructuredProjectConfig,
} from '../workflow-contract/project-config.js';
import {
  readWorkflowProjectConfigDocument,
  readWorkflowProjectConfigSnapshot,
} from '../workflow-contract/project-config-reader.js';
import { assertWorkflowProjectConfigIdentity } from '../workflow-contract/project-config-writer.js';

import { atomicWriteText } from './loop-atomic-file.js';
import {
  discoverLoopProject,
  loopProjectPaths,
  normalizeArtifactRootRef,
  PROJECT_CONFIG_FILE,
} from './loop-paths.js';
import type { OwnerProjectConfig, LoopProjectPaths, LoopSnapshotConfig } from './loop-types.js';

export const MAX_LOOP_SNAPSHOT_PATTERN_LENGTH = MAX_WORKFLOW_SNAPSHOT_PATTERN_LENGTH;
export const MAX_LOOP_SNAPSHOT_PATTERN_WILDCARDS = MAX_WORKFLOW_SNAPSHOT_PATTERN_WILDCARDS;
export const DEFAULT_LOOP_SNAPSHOT_CONFIG: LoopSnapshotConfig =
  DEFAULT_WORKFLOW_LOOP_SNAPSHOT_CONFIG;
export const DEFAULT_LOOP_MAX_VERIFY_FAILURES = DEFAULT_WORKFLOW_LOOP_MAX_VERIFY_FAILURES;
export const normalizeLoopSnapshotPattern = normalizeWorkflowSnapshotPattern;
export const mergeLoopSnapshotExcludes = mergeWorkflowLoopSnapshotExcludes;

export function defaultProjectConfig(
  artifactRoot = 'docs',
  language: 'en' | 'zh-CN' = 'en',
): OwnerProjectConfig {
  return defaultWorkflowProjectConfig(artifactRoot, language);
}

export async function readProjectConfig(projectRoot: string): Promise<OwnerProjectConfig | null> {
  const config = (await readWorkflowProjectConfigDocument(projectRoot))?.config ?? null;
  if (!config?.loop) return null;
  return config as OwnerProjectConfig;
}

export async function assertNoPendingLoopRootMove(projectRoot: string): Promise<void> {
  const config = await readProjectConfig(projectRoot);
  if (config?.loop.pending_root_move) {
    throw new Error(
      `Loop root move ${config.loop.pending_root_move.id} is incomplete; use owner loop doctor --repair`,
    );
  }
}

export async function writeProjectConfig(
  projectRoot: string,
  config: OwnerProjectConfig,
  options: { beforeCommit?: () => void | Promise<void> } = {},
): Promise<void> {
  const snapshot = await readWorkflowProjectConfigSnapshot(projectRoot, {
    allowPartialProject: true,
  });
  const document = mergeWorkflowProjectConfigDocument(snapshot.document?.value ?? {}, config);
  const canonical = path.join(projectRoot, ...PROJECT_CONFIG_FILE.split('/'));
  await atomicWriteText(
    canonical,
    renderStructuredProjectConfig(document, config.loop.language === 'zh-CN' ? 'zh-CN' : 'en'),
    {
      containedRoot: projectRoot,
      beforeCommit: async () => {
        await options.beforeCommit?.();
        await assertWorkflowProjectConfigIdentity(projectRoot, snapshot.identity);
      },
    },
  );
}

export async function resolveLoopProject(options: {
  startPath: string;
  explicitArtifactRoot?: string;
  allowMissingConfig?: boolean;
}): Promise<{ config: OwnerProjectConfig; paths: LoopProjectPaths; configured: boolean }> {
  const projectRoot = await discoverLoopProject(options.startPath);
  const existing = await readProjectConfig(projectRoot);
  if (!existing && options.allowMissingConfig === false) {
    throw new Error(`${PROJECT_CONFIG_FILE} was not found`);
  }
  if (existing?.loop.pending_root_move) {
    throw new Error(
      `Loop root move ${existing.loop.pending_root_move.id} is incomplete; use owner loop doctor --repair`,
    );
  }
  const explicit = options.explicitArtifactRoot
    ? normalizeArtifactRootRef(options.explicitArtifactRoot)
    : undefined;
  if (existing && explicit && explicit !== existing.loop.artifact_root) {
    throw new Error(
      `Configured Loop artifact root is ${existing.loop.artifact_root}; refusing conflicting root ${explicit}`,
    );
  }
  const config = existing ?? defaultProjectConfig(explicit ?? 'docs');
  const paths = await loopProjectPaths(projectRoot, config.loop.artifact_root);
  return { config, paths, configured: existing !== null };
}
