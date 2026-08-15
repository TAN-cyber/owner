import os from 'os';

import {
  assertPipelineLayoutInitializationSafe,
  beginPipelineLayoutInitialization,
  checkpointPipelineLayoutInitialization,
  completePipelineLayoutInitialization,
  type PipelineLayoutInitializationPermit,
} from '../owner-pipeline/pipeline-layout-initialization.js';
import { pipelineLayoutPaths, pipelineProjectRelative } from '../owner-pipeline/pipeline-layout.js';
import { assertPipelineOpenSpecRootHealthy } from '../owner-pipeline/pipeline-openspec-root.js';
import {
  discoverLoopProject,
  ensureLoopDirectories,
  loopProjectPaths,
} from '../owner-loop/loop-paths.js';
import { installOpenSpec } from '../integrations/openspec.js';
import { projectOwnerHooksFromInstalledScope } from '../skill/project-hook-projection.js';
import {
  defaultWorkflowProjectConfig,
  ensureOwnerProjectGitignore,
  readWorkflowGlobalConfig,
  readWorkflowProjectConfig,
  workflowProjectConfigFromGlobalConfig,
  writeWorkflowProjectConfig,
  type WorkflowProjectConfig,
} from '../workflow-contract/index.js';
import { ensureProtectedProjectDirectory } from '../workflow-contract/protected-project-path.js';

import type { OwnerEntryResolution, OwnerEntryResolutionSource } from './types.js';
import { resolveInitWorkflow } from './init-workflow.js';

export interface ProjectActivationOptions {
  homeDir?: string;
}

export interface ProjectActivationResult {
  config: WorkflowProjectConfig;
  source: Extract<
    OwnerEntryResolutionSource,
    'global-config' | 'built-in-default' | 'legacy-project'
  >;
}

async function ensureWorkflowDirectories(
  projectRoot: string,
  config: WorkflowProjectConfig,
): Promise<PipelineLayoutInitializationPermit | undefined> {
  const workflows = config.workflows ?? [config.default_workflow];
  if (workflows.includes('loop')) {
    if (!config.loop) {
      throw new Error('Global Owner config enables Loop without a loop configuration');
    }
    await ensureLoopDirectories(await loopProjectPaths(projectRoot, config.loop.artifact_root));
  }
  if (!workflows.includes('pipeline')) return undefined;

  const artifactLayout = config.pipeline?.artifact_layout ?? 'docs';
  let initialization = await assertPipelineLayoutInitializationSafe(projectRoot, artifactLayout);
  initialization = await beginPipelineLayoutInitialization(projectRoot, initialization);
  const permit = initialization.initializationPermit;
  const mutationGuard = async () => {
    await assertPipelineLayoutInitializationSafe(projectRoot, artifactLayout, permit);
  };
  const status = await installOpenSpec(
    projectRoot,
    [],
    'project',
    false,
    artifactLayout,
    mutationGuard,
  );
  if (status !== 'installed') {
    throw new Error(
      'Pipeline project activation requires a compatible globally installed OpenSpec CLI',
    );
  }

  const layout = pipelineLayoutPaths(projectRoot, artifactLayout);
  await assertPipelineOpenSpecRootHealthy(projectRoot, layout);
  for (const directory of [
    layout.archiveDir,
    layout.specsDir,
    layout.superpowersSpecsDir,
    layout.superpowersPlansDir,
    layout.superpowersReportsDir,
  ]) {
    const relative = pipelineProjectRelative(projectRoot, directory);
    await ensureProtectedProjectDirectory(projectRoot, relative, {
      label: `Pipeline working directory ${relative}`,
    });
  }
  await ensureProtectedProjectDirectory(projectRoot, '.owner', {
    label: 'Owner project state directory',
  });
  await checkpointPipelineLayoutInitialization(projectRoot, permit);
  return permit;
}

export async function activateOwnerProject(
  projectRoot: string,
  options: ProjectActivationOptions = {},
): Promise<ProjectActivationResult> {
  const globalConfig = await readWorkflowGlobalConfig(options.homeDir ?? os.homedir());
  let config = globalConfig
    ? workflowProjectConfigFromGlobalConfig(globalConfig)
    : defaultWorkflowProjectConfig('docs');
  let source: ProjectActivationResult['source'] = globalConfig
    ? 'global-config'
    : 'built-in-default';
  const projectDecision = await resolveInitWorkflow(projectRoot);
  if (projectDecision.source === 'legacy-project') {
    config = {
      schema: 'owner.project.v1',
      default_workflow: 'pipeline',
      workflows: ['pipeline'],
      ambient_resume: config.ambient_resume,
      pipeline: {
        artifact_layout: projectDecision.pipelineArtifactLayout,
        language: config.pipeline?.language ?? config.loop?.language ?? 'en',
        context_compression: config.pipeline?.context_compression ?? 'off',
        review_mode: config.pipeline?.review_mode ?? 'standard',
        auto_transition: config.pipeline?.auto_transition ?? true,
      },
    };
    source = 'legacy-project';
  }

  // Materialize project-owned artifact directories before publishing the
  // project config. A failed activation therefore never leaves a configured
  // project pointing at an incomplete artifact root.
  const pipelinePermit = await ensureWorkflowDirectories(projectRoot, config);
  const workflows = config.workflows ?? [config.default_workflow];
  const workflowSelection =
    workflows.includes('loop') && workflows.includes('pipeline') ? 'both' : config.default_workflow;
  const hookProjection = await projectOwnerHooksFromInstalledScope(
    projectRoot,
    options.homeDir ?? os.homedir(),
    'global',
    workflowSelection,
    { globalBaseDir: options.homeDir ?? os.homedir() },
  );
  if (hookProjection.failures.length > 0) {
    const details = hookProjection.failures
      .map(({ platform, reason }) => `${platform}: ${reason}`)
      .join('; ');
    throw new Error(`Owner project Hook activation failed: ${details}`);
  }
  await ensureOwnerProjectGitignore(projectRoot);
  await writeWorkflowProjectConfig(projectRoot, config);
  if (pipelinePermit) {
    await completePipelineLayoutInitialization(projectRoot, pipelinePermit);
  }
  return { config, source };
}

export async function resolveOrActivateOwnerEntry(
  startPath: string,
  options: ProjectActivationOptions = {},
): Promise<OwnerEntryResolution> {
  const projectRoot = await discoverLoopProject(startPath);
  const existing = await readWorkflowProjectConfig(projectRoot);
  const activated = existing ? null : await activateOwnerProject(projectRoot, options);
  const config = existing ?? activated!.config;
  return {
    workflow: config.default_workflow,
    skill: config.default_workflow === 'loop' ? 'owner-loop' : 'owner-pipeline',
    source: activated?.source ?? 'project-config',
  };
}
