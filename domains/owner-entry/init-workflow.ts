import { promises as fs } from 'fs';
import path from 'path';

import { fileExists } from '../../platform/fs/file-system.js';
import type { PipelineArtifactLayout } from '../owner-pipeline/pipeline-layout.js';
import {
  hasExplicitPipelineArtifactLayout,
  normalizeWorkflowArtifactRoot,
} from '../workflow-contract/project-config.js';
import {
  readWorkflowProjectConfigSnapshot,
  type WorkflowProjectConfigSnapshot,
} from '../workflow-contract/project-config-reader.js';
import {
  inspectProtectedProjectPath,
  readProtectedProjectFile,
  resolveProtectedProjectInstructionPath,
} from '../workflow-contract/protected-project-path.js';
import type { OwnerWorkflow } from './types.js';

export type InitWorkflowSource =
  | 'project-config'
  | 'explicit-option'
  | 'legacy-project'
  | 'new-project-default';

export interface InitWorkflowDecision {
  workflow: OwnerWorkflow;
  source: InitWorkflowSource;
  artifactRoot: string;
  pipelineArtifactLayout: PipelineArtifactLayout;
  writeProjectConfig: boolean;
  legacyEvidence: string[];
}

interface ResolveInitWorkflowOptions {
  workflow?: OwnerWorkflow;
  artifactRoot?: string;
}

async function containsLegacyManagedResumeBlock(
  projectRoot: string,
  relativeFile: string,
): Promise<boolean> {
  try {
    const instruction = await resolveProtectedProjectInstructionPath(projectRoot, relativeFile);
    if (!instruction.exists) return false;
    const source = (
      await readProtectedProjectFile(projectRoot, instruction.relative, 4 * 1024 * 1024, {
        label: `${instruction.relative} legacy resume evidence`,
      })
    ).bytes.toString('utf8');
    return source.includes('<owner-ambient-resume>') && !source.includes('owner.resume_probe.v2');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

async function findLegacyEvidence(
  projectRoot: string,
  projectConfigExists?: boolean,
): Promise<string[]> {
  const evidence: string[] = [];
  const legacyConfig = '.owner/config.yaml';
  if (
    projectConfigExists ??
    (await fileExists(path.join(projectRoot, ...legacyConfig.split('/'))))
  ) {
    evidence.push(legacyConfig);
  }

  const visit = async (relativeDirectory: string): Promise<void> => {
    const inspection = await inspectProtectedProjectPath(projectRoot, relativeDirectory, {
      label: 'legacy Pipeline change evidence',
      expected: 'directory',
    });
    if (!inspection.exists) return;
    const entries = await fs.readdir(inspection.target, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink()) continue;
      const relativeTarget = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) {
        await visit(relativeTarget);
      } else if (entry.isFile() && entry.name === '.owner.yaml') {
        evidence.push(relativeTarget);
      }
    }
  };
  await visit('openspec/changes');

  const inspectedResumeTargets = new Set<string>();
  for (const file of ['AGENTS.md', 'CLAUDE.md']) {
    const instruction = await resolveProtectedProjectInstructionPath(projectRoot, file);
    if (!instruction.exists || inspectedResumeTargets.has(instruction.relative)) continue;
    inspectedResumeTargets.add(instruction.relative);
    if (await containsLegacyManagedResumeBlock(projectRoot, instruction.relative)) {
      evidence.push(`${instruction.relative}#owner-ambient-resume`);
    }
  }
  return evidence;
}

export async function resolveInitWorkflow(
  projectRoot: string,
  options: ResolveInitWorkflowOptions = {},
  projectConfigSnapshot?: WorkflowProjectConfigSnapshot,
): Promise<InitWorkflowDecision> {
  if (options.workflow === 'pipeline' && options.artifactRoot !== undefined) {
    throw new Error('--root is only valid with the Loop workflow');
  }

  const requestedArtifactRoot =
    options.artifactRoot === undefined
      ? undefined
      : normalizeWorkflowArtifactRoot(options.artifactRoot);
  const requestedWorkflow = options.workflow ?? (requestedArtifactRoot ? 'loop' : undefined);
  const snapshot =
    projectConfigSnapshot ??
    (await readWorkflowProjectConfigSnapshot(projectRoot, {
      allowPartialProject: true,
      allowMissingLoopFields: true,
    }));
  const existing = snapshot.document?.config ?? null;
  if (existing) {
    if (
      requestedArtifactRoot !== undefined &&
      existing.loop !== undefined &&
      requestedArtifactRoot !== existing.loop.artifact_root
    ) {
      throw new Error(
        `The configured Loop artifact root is ${existing.loop.artifact_root}; refusing requested ${requestedArtifactRoot}`,
      );
    }
    const workflow = requestedWorkflow ?? existing.default_workflow;
    const explicit = requestedWorkflow !== undefined || requestedArtifactRoot !== undefined;
    const rawPipeline = snapshot.document?.value.pipeline;
    const hasExplicitPipelineLayout = hasExplicitPipelineArtifactLayout(rawPipeline);
    const inferredPipelineLayout: PipelineArtifactLayout = hasExplicitPipelineLayout
      ? (existing.pipeline?.artifact_layout ?? 'docs')
      : (await fileExists(path.join(projectRoot, 'openspec')))
        ? 'legacy'
        : 'docs';
    return {
      workflow,
      source: explicit ? 'explicit-option' : 'project-config',
      artifactRoot: requestedArtifactRoot ?? existing.loop?.artifact_root ?? 'docs',
      pipelineArtifactLayout: inferredPipelineLayout,
      writeProjectConfig:
        workflow !== existing.default_workflow || (workflow === 'loop' && !existing.loop),
      legacyEvidence: [],
    };
  }

  const legacyEvidence = await findLegacyEvidence(projectRoot, snapshot.identity.exists);
  const [legacyOpenSpecRootExists, docsOpenSpecRootExists] = await Promise.all([
    fileExists(path.join(projectRoot, 'openspec')),
    fileExists(path.join(projectRoot, 'docs', 'openspec')),
  ]);
  const legacyArtifactLayout =
    legacyEvidence.some((item) => item.startsWith('openspec/')) ||
    (legacyOpenSpecRootExists && !docsOpenSpecRootExists);
  if (requestedWorkflow) {
    return {
      workflow: requestedWorkflow,
      source: 'explicit-option',
      artifactRoot: requestedArtifactRoot ?? 'docs',
      pipelineArtifactLayout: legacyArtifactLayout ? 'legacy' : 'docs',
      writeProjectConfig: true,
      legacyEvidence,
    };
  }
  if (legacyEvidence.length > 0) {
    return {
      workflow: 'pipeline',
      source: 'legacy-project',
      artifactRoot: 'docs',
      pipelineArtifactLayout: legacyArtifactLayout ? 'legacy' : 'docs',
      writeProjectConfig: false,
      legacyEvidence,
    };
  }
  return {
    workflow: 'loop',
    source: 'new-project-default',
    artifactRoot: 'docs',
    pipelineArtifactLayout: 'docs',
    writeProjectConfig: true,
    legacyEvidence: [],
  };
}
