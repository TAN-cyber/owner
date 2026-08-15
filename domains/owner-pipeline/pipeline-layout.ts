import { promises as fs } from 'fs';
import path from 'path';

import { fileExists } from '../../platform/fs/file-system.js';
import {
  parseWorkflowProjectConfigDocument,
  renderStructuredProjectConfig,
} from '../workflow-contract/project-config.js';
import {
  readWorkflowProjectConfigDocument,
  readWorkflowProjectConfigSnapshot,
  type WorkflowProjectConfigIdentity,
} from '../workflow-contract/project-config-reader.js';
import { writeWorkflowProjectConfigSource } from '../workflow-contract/project-config-writer.js';
import { inspectProtectedProjectPath } from '../workflow-contract/protected-project-path.js';
import type { PipelineArtifactLayout } from '../workflow-contract/types.js';

export type { PipelineArtifactLayout } from '../workflow-contract/types.js';

export interface PipelineLayoutPaths {
  projectRoot: string;
  artifactLayout: PipelineArtifactLayout;
  openSpecBase: string;
  openSpecRoot: string;
  changesDir: string;
  archiveDir: string;
  specsDir: string;
  superpowersRoot: string;
  superpowersSpecsDir: string;
  superpowersPlansDir: string;
  superpowersReportsDir: string;
}

export interface PipelineLayoutInspection {
  paths: PipelineLayoutPaths;
  configuredRootExists: boolean;
  alternateRoot: string;
  alternateRootExists: boolean;
  dualRoots: boolean;
}

export class PipelineLayoutUnavailableError extends Error {
  readonly code = 'pipeline-layout-unavailable';

  constructor(message = 'Pipeline artifact layout is unavailable from .owner/config.yaml') {
    super(message);
    this.name = 'PipelineLayoutUnavailableError';
  }
}

const PROJECT_CONFIG_RELATIVE_PATH = '.owner/config.yaml';

function isMissingPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function assertPipelineConfigPhysical(projectRoot: string): Promise<void> {
  await inspectProtectedProjectPath(projectRoot, PROJECT_CONFIG_RELATIVE_PATH, {
    label: PROJECT_CONFIG_RELATIVE_PATH,
    expected: 'file',
  });
}

export function pipelineLayoutPaths(
  projectRoot: string,
  artifactLayout: PipelineArtifactLayout,
): PipelineLayoutPaths {
  const root = path.resolve(projectRoot);
  const openSpecBase = artifactLayout === 'docs' ? path.join(root, 'docs') : root;
  const openSpecRoot = path.join(openSpecBase, 'openspec');
  const superpowersRoot = path.join(root, 'docs', 'superpowers');
  return {
    projectRoot: root,
    artifactLayout,
    openSpecBase,
    openSpecRoot,
    changesDir: path.join(openSpecRoot, 'changes'),
    archiveDir: path.join(openSpecRoot, 'changes', 'archive'),
    specsDir: path.join(openSpecRoot, 'specs'),
    superpowersRoot,
    superpowersSpecsDir: path.join(superpowersRoot, 'specs'),
    superpowersPlansDir: path.join(superpowersRoot, 'plans'),
    superpowersReportsDir: path.join(superpowersRoot, 'reports'),
  };
}

export async function readPipelineArtifactLayout(
  projectRoot: string,
): Promise<PipelineArtifactLayout> {
  await assertPipelineConfigPhysical(projectRoot);
  const document = await readWorkflowProjectConfigDocument(projectRoot, {
    allowPartialProject: true,
    allowMissingLoopFields: true,
  });
  if (!document?.config) {
    throw new PipelineLayoutUnavailableError();
  }
  const workflows = document.config.workflows ?? [document.config.default_workflow];
  if (!workflows.includes('pipeline')) {
    throw new PipelineLayoutUnavailableError(
      'Pipeline artifact layout is unavailable because Pipeline is not enabled',
    );
  }
  return document.pipeline?.artifact_layout ?? 'legacy';
}

export async function assertPipelineWorkflowEnabled(projectRoot: string): Promise<void> {
  await assertPipelineConfigPhysical(projectRoot);
  const config = (await readWorkflowProjectConfigDocument(projectRoot))?.config;
  if (!config) {
    throw new Error('.owner/config.yaml must use owner.project.v1 before migration');
  }
  const workflows = config.workflows ?? [config.default_workflow];
  if (!workflows.includes('pipeline')) {
    throw new Error('Pipeline root move requires the Pipeline workflow to be enabled');
  }
}

export async function writePipelineArtifactLayout(
  projectRoot: string,
  artifactLayout: PipelineArtifactLayout,
  options: {
    expectedIdentity?: WorkflowProjectConfigIdentity;
    beforeCommit?: () => void | Promise<void>;
  } = {},
): Promise<void> {
  await assertPipelineConfigPhysical(projectRoot);
  const snapshot = await readWorkflowProjectConfigSnapshot(projectRoot, {
    allowPartialProject: true,
  });
  const parsed = snapshot.document;
  if (!parsed) throw new Error('.owner/config.yaml does not exist');
  const pipeline = parsed.value.pipeline;
  if (!pipeline || typeof pipeline !== 'object' || Array.isArray(pipeline)) {
    throw new Error('pipeline must be a mapping');
  }
  const document = {
    ...parsed.value,
    pipeline: {
      ...(pipeline as Record<string, unknown>),
      artifact_layout: artifactLayout,
    },
  };
  const output = renderStructuredProjectConfig(
    document,
    parsed.pipeline?.language === 'zh-CN' || parsed.loop?.language === 'zh-CN' ? 'zh-CN' : 'en',
  );
  parseWorkflowProjectConfigDocument(output, { allowPartialProject: true });
  await writeWorkflowProjectConfigSource(projectRoot, output, {
    expectedIdentity: options.expectedIdentity ?? snapshot.identity,
    beforeCommit: options.beforeCommit,
  });
}

export async function resolvePipelineLayout(
  projectRoot: string,
  artifactLayout?: PipelineArtifactLayout,
): Promise<PipelineLayoutPaths> {
  return pipelineLayoutPaths(
    projectRoot,
    artifactLayout ?? (await readPipelineArtifactLayout(projectRoot)),
  );
}

async function inspectUntrustedAlternateRoot(alternateRoot: string): Promise<boolean> {
  try {
    await fs.lstat(alternateRoot);
    return true;
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
}

export async function inspectPipelineLayout(
  projectRoot: string,
  artifactLayout?: PipelineArtifactLayout,
): Promise<PipelineLayoutInspection> {
  const paths = await resolvePipelineLayout(projectRoot, artifactLayout);
  const alternateLayout: PipelineArtifactLayout =
    paths.artifactLayout === 'legacy' ? 'docs' : 'legacy';
  const alternateRoot = pipelineLayoutPaths(projectRoot, alternateLayout).openSpecRoot;
  const [configuredRoot, alternateRootExists] = await Promise.all([
    inspectProtectedProjectPath(
      paths.projectRoot,
      pipelineProjectRelative(paths.projectRoot, paths.openSpecRoot),
      {
        label: 'Configured Pipeline OpenSpec root',
        expected: 'directory',
      },
    ),
    inspectUntrustedAlternateRoot(alternateRoot),
  ]);
  const configuredRootExists = configuredRoot.exists;
  return {
    paths,
    configuredRootExists,
    alternateRoot,
    alternateRootExists,
    dualRoots: configuredRootExists && alternateRootExists,
  };
}

async function assertPipelineManagedRootsPhysical(paths: PipelineLayoutPaths): Promise<void> {
  const managedRoots = [
    paths.openSpecRoot,
    paths.changesDir,
    paths.archiveDir,
    paths.specsDir,
    paths.superpowersRoot,
    paths.superpowersSpecsDir,
    paths.superpowersPlansDir,
    paths.superpowersReportsDir,
  ];
  for (const target of managedRoots) {
    const relative = pipelineProjectRelative(paths.projectRoot, target);
    await inspectProtectedProjectPath(paths.projectRoot, relative, {
      label: `Pipeline managed physical path ${relative}`,
      expected: 'directory',
    });
  }
}

export async function assertPipelineLayoutReadable(
  projectRoot: string,
  artifactLayout?: PipelineArtifactLayout,
): Promise<PipelineLayoutPaths> {
  const inspection = await inspectPipelineLayout(projectRoot, artifactLayout);
  await assertPipelineManagedRootsPhysical(inspection.paths);
  // `artifact_layout` is the ownership boundary. The alternate OpenSpec root
  // may belong to a standalone OpenSpec workflow and must not block Owner from
  // reading or writing its configured root. Explicit root migration remains
  // responsible for handling a non-empty destination safely.
  if (!inspection.configuredRootExists) {
    const configured = pipelineProjectRelative(
      inspection.paths.projectRoot,
      inspection.paths.openSpecRoot,
    );
    const alternate = pipelineProjectRelative(
      inspection.paths.projectRoot,
      inspection.alternateRoot,
    );
    throw new PipelineLayoutUnavailableError(
      `Configured Pipeline OpenSpec root is missing: ${configured} (alternate ${alternate} is ${
        inspection.alternateRootExists ? 'present' : 'missing'
      })`,
    );
  }
  return inspection.paths;
}

export async function assertPipelineLayoutWritable(
  projectRoot: string,
  artifactLayout?: PipelineArtifactLayout,
): Promise<PipelineLayoutPaths> {
  const pendingMove = path.join(path.resolve(projectRoot), '.owner', 'pipeline-root-move.json');
  if (await fileExists(pendingMove)) {
    throw new Error(
      'Pipeline root move transaction is incomplete; inspect it with owner doctor and recover it explicitly before writing',
    );
  }
  const paths = await assertPipelineLayoutReadable(projectRoot, artifactLayout);
  if (!(await fileExists(paths.openSpecRoot))) {
    throw new Error(
      `Configured Pipeline OpenSpec root is missing: ${pipelineProjectRelative(
        paths.projectRoot,
        paths.openSpecRoot,
      )}`,
    );
  }
  return paths;
}

export async function discoverPipelineProject(startPath: string): Promise<string> {
  let cursor = path.resolve(startPath);
  let openSpecFallback: string | null = null;
  try {
    if (!(await fs.lstat(cursor)).isDirectory()) cursor = path.dirname(cursor);
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }
  for (;;) {
    if (path.basename(cursor) === 'openspec') {
      openSpecFallback = path.dirname(cursor);
    }
    const configFile = path.join(cursor, '.owner', 'config.yaml');
    let projectConfig = false;
    if (await fileExists(configFile)) {
      try {
        await assertPipelineConfigPhysical(cursor);
        const value = (await readWorkflowProjectConfigDocument(cursor))?.value;
        projectConfig =
          Boolean(value) &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          ((value as Record<string, unknown>).schema === 'owner.project.v1' ||
            (value as Record<string, unknown>).default_workflow !== undefined ||
            (value as Record<string, unknown>).loop !== undefined);
      } catch {
        // A malformed config next to a repository marker is still handled by
        // the caller. It is not enough by itself to turn a global ~/.owner
        // directory into a project root.
      }
    }
    if (projectConfig || (await fileExists(path.join(cursor, '.git')))) {
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return openSpecFallback ?? path.resolve(startPath);
    cursor = parent;
  }
}

export function pipelineProjectRelative(projectRoot: string, target: string): string {
  return path.relative(path.resolve(projectRoot), target).replaceAll('\\', '/');
}
