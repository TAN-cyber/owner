import { promises as fs } from 'fs';
import path from 'path';

import { latestCommandCheck } from '../owner-pipeline/pipeline-command-checks.js';
import { inspectPipelineChangeReadOnly } from '../owner-pipeline/pipeline-diagnostics.js';
import { assertPipelineLayoutReadable } from '../owner-pipeline/pipeline-layout.js';
import {
  inspectPipelineActiveChangeDirectory,
  openSpecChangeNameError,
} from '../owner-pipeline/pipeline-paths.js';
import {
  inspectPipelineProjectTarget,
  readPipelineProjectFile,
} from '../owner-pipeline/pipeline-protected-path.js';
import { readPipelineState } from '../owner-pipeline/pipeline-store.js';
import { assertNoPendingLoopRootMove } from '../owner-loop/loop-config.js';
import { listLoopStatus } from '../owner-loop/loop-diagnostics.js';
import { discoverLoopProject, loopProjectPaths } from '../owner-loop/loop-paths.js';
import { readWorkflowProjectConfig } from '../workflow-contract/project-config-reader.js';
import { resolveOwnerEntry } from './resolve-entry.js';
import type { ChangeStatus, OwnerEntryResolution, OwnerProjectStatus } from './types.js';

async function countTasks(
  projectRoot: string,
  tasksPath: string,
): Promise<{ done: number; total: number }> {
  let content: string;
  try {
    content = await readPipelineProjectFile(projectRoot, tasksPath, {
      label: 'Pipeline tasks artifact',
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { done: 0, total: 0 };
    throw error;
  }
  const lines = content.split('\n');
  return {
    done: lines.filter((line) => /^\s*- \[x\]/iu.test(line)).length,
    total: lines.filter((line) => /^\s*- \[[ x]\]/iu.test(line)).length,
  };
}

function unmanagedChange(name: string, done: number, total: number): ChangeStatus {
  return {
    name,
    ownerManaged: false,
    archiveReady: total > 0 && done === total,
    recommendedArchiveCommand: `owner pipeline openspec -- archive ${name} -y`,
    workflow: null,
    phase: null,
    buildMode: null,
    isolation: null,
    boundBranch: null,
    verifyMode: null,
    verifyResult: null,
    designDoc: null,
    plan: null,
    tasksCompleted: done,
    tasksTotal: total,
    nextCommand: null,
    currentStep: null,
    runtimeMode: null,
    runtimeEval: null,
    commandChecks: null,
  };
}

function invalidPipelineChange(name: string, error: unknown, done = 0, total = 0): ChangeStatus {
  return {
    name,
    ownerManaged: true,
    archiveReady: false,
    recommendedArchiveCommand: `owner archive ${name}`,
    workflow: 'unknown',
    phase: 'invalid',
    buildMode: null,
    isolation: null,
    boundBranch: null,
    verifyMode: null,
    verifyResult: 'pending',
    designDoc: null,
    plan: null,
    tasksCompleted: done,
    tasksTotal: total,
    nextCommand: null,
    currentStep: null,
    runtimeMode: 'invalid',
    runtimeEval: null,
    commandChecks: null,
    error: error instanceof Error ? error.message : String(error),
  };
}

async function inspectOpenSpecChanges(
  projectRoot: string,
): Promise<{ pipeline: ChangeStatus[]; unmanaged: ChangeStatus[]; error?: string }> {
  let changesDir: string;
  try {
    changesDir = (await assertPipelineLayoutReadable(projectRoot)).changesDir;
    const inspection = await inspectPipelineProjectTarget(projectRoot, changesDir, {
      label: 'Pipeline changes root',
      expected: 'directory',
    });
    if (!inspection.exists) return { pipeline: [], unmanaged: [] };
  } catch (error) {
    return {
      pipeline: [],
      unmanaged: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const pipeline: ChangeStatus[] = [];
  const unmanaged: ChangeStatus[] = [];
  const names = (await fs.readdir(changesDir)).sort();
  await inspectPipelineProjectTarget(projectRoot, changesDir, {
    label: 'Pipeline changes root',
    expected: 'directory',
  });
  for (const name of names) {
    if (name === 'archive') continue;
    if (openSpecChangeNameError(name)) continue;
    let change;
    try {
      change = await inspectPipelineActiveChangeDirectory(name, projectRoot);
    } catch (error) {
      pipeline.push(invalidPipelineChange(name, error));
      continue;
    }
    if (!change.exists) continue;
    const changeDir = change.directory;
    let done: number;
    let total: number;
    try {
      ({ done, total } = await countTasks(projectRoot, path.join(changeDir, 'tasks.md')));
    } catch (error) {
      pipeline.push(invalidPipelineChange(name, error));
      continue;
    }
    if (!change.stateExists) {
      unmanaged.push(unmanagedChange(name, done, total));
      continue;
    }

    try {
      await inspectPipelineProjectTarget(projectRoot, path.join(changeDir, '.owner'), {
        label: `Pipeline runtime directory for ${name}`,
        expected: 'directory',
      });
      const projection = await readPipelineState(changeDir, { migrate: false });
      const unknownKeys = Array.from(new Set(projection.unknownKeys)).sort();
      if (unknownKeys.length > 0) {
        pipeline.push({
          name,
          ownerManaged: true,
          archiveReady: false,
          recommendedArchiveCommand: `owner archive ${name}`,
          workflow: 'unknown',
          phase: 'invalid',
          buildMode: projection.pipeline?.buildMode ?? null,
          isolation: projection.pipeline?.isolation ?? null,
          boundBranch: projection.pipeline?.boundBranch ?? null,
          verifyMode: projection.pipeline?.verifyMode ?? null,
          verifyResult: projection.pipeline?.verifyResult ?? 'pending',
          designDoc: projection.pipeline?.designDoc ?? null,
          plan: projection.pipeline?.plan ?? null,
          tasksCompleted: done,
          tasksTotal: total,
          nextCommand: null,
          currentStep: null,
          runtimeMode: 'invalid',
          runtimeEval: null,
          commandChecks: null,
          error: `Invalid Pipeline state: unknown field(s): ${unknownKeys.join(', ')}`,
        });
        continue;
      }

      const diagnostic = await inspectPipelineChangeReadOnly(changeDir, name);
      if (diagnostic.valid && projection.pipeline) {
        if (projection.pipeline.archived) continue;
        const run = projection.run;
        pipeline.push({
          name,
          ownerManaged: true,
          archiveReady:
            projection.pipeline.phase === 'archive' &&
            projection.pipeline.verifyResult === 'pass' &&
            !projection.pipeline.archived,
          recommendedArchiveCommand: `owner archive ${name}`,
          workflow: diagnostic.workflow,
          phase: diagnostic.phase,
          buildMode: projection.pipeline.buildMode,
          isolation: projection.pipeline.isolation,
          boundBranch: projection.pipeline.boundBranch,
          verifyMode: projection.pipeline.verifyMode,
          verifyResult: projection.pipeline.verifyResult,
          designDoc: projection.pipeline.designDoc,
          plan: projection.pipeline.plan,
          tasksCompleted: done,
          tasksTotal: total,
          nextCommand: diagnostic.nextCommand,
          currentStep: diagnostic.currentStep,
          runtimeMode: diagnostic.runtimeMode,
          runtimeEval: diagnostic.runtimeEval,
          commandChecks: run
            ? {
                build: await latestCommandCheck(projectRoot, changeDir, run, 'build'),
                verify: await latestCommandCheck(projectRoot, changeDir, run, 'verify'),
              }
            : null,
        });
        continue;
      }

      pipeline.push({
        name,
        ownerManaged: true,
        archiveReady: false,
        recommendedArchiveCommand: `owner archive ${name}`,
        workflow: diagnostic.workflow,
        phase: diagnostic.phase,
        buildMode: projection.pipeline?.buildMode ?? null,
        isolation: projection.pipeline?.isolation ?? null,
        boundBranch: projection.pipeline?.boundBranch ?? null,
        verifyMode: projection.pipeline?.verifyMode ?? null,
        verifyResult: projection.pipeline?.verifyResult ?? 'pending',
        designDoc: projection.pipeline?.designDoc ?? null,
        plan: projection.pipeline?.plan ?? null,
        tasksCompleted: done,
        tasksTotal: total,
        nextCommand: diagnostic.nextCommand,
        currentStep: diagnostic.currentStep,
        runtimeMode: diagnostic.runtimeMode,
        runtimeEval: diagnostic.runtimeEval,
        commandChecks: null,
        error: diagnostic.error,
      });
    } catch (error) {
      pipeline.push(invalidPipelineChange(name, error, done, total));
    }
  }
  return { pipeline, unmanaged };
}

export async function inspectOwnerProjectStatus(startPath: string): Promise<OwnerProjectStatus> {
  const projectRoot = await discoverLoopProject(startPath);
  let defaultEntry: OwnerEntryResolution | { error: string };
  let configError: string | null = null;
  let config = null;
  try {
    config = await readWorkflowProjectConfig(projectRoot);
    defaultEntry = await resolveOwnerEntry(projectRoot);
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error);
    defaultEntry = { error: configError };
  }
  const configuredWorkflows =
    config?.workflows ?? (config ? [config.default_workflow] : ['pipeline']);
  const pipelineEnabled = configuredWorkflows.includes('pipeline');
  const loopEnabled = configuredWorkflows.includes('loop');
  const openSpec = configError
    ? { pipeline: [], unmanaged: [], error: configError }
    : pipelineEnabled
      ? await inspectOpenSpecChanges(projectRoot)
      : { pipeline: [], unmanaged: [] };

  let loop: OwnerProjectStatus['workflows']['loop'];
  if (configError) {
    loop = { changes: [], error: configError };
  } else if (loopEnabled && config?.loop) {
    try {
      await assertNoPendingLoopRootMove(projectRoot);
      const paths = await loopProjectPaths(projectRoot, config.loop.artifact_root);
      loop = {
        changes: await listLoopStatus(paths, {
          clarificationMode: config.loop.clarification_mode,
          maxVerifyFailures: config.loop.max_verify_failures,
        }),
      };
    } catch (error) {
      loop = { changes: [], error: error instanceof Error ? error.message : String(error) };
    }
  } else {
    loop = { changes: [] };
  }

  return {
    schema: 'owner.status.v2',
    defaultEntry,
    workflows: {
      loop,
      pipeline: {
        changes: openSpec.pipeline,
        ...(openSpec.error ? { error: openSpec.error } : {}),
      },
    },
    unmanagedOpenSpec: openSpec.unmanaged,
  };
}
