import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { collectPipelineEvidence } from './pipeline-evidence.js';
import { ensurePipelineRun, type PipelineRunContext } from './pipeline-migrate.js';
import { resolvePipelineStepId } from './pipeline-resolver.js';
import { readPipelineState, writePipelineState } from './pipeline-store.js';
import {
  PIPELINE_MIGRATION_VERSION,
  type PipelineState,
  type PipelineStateProjection,
} from './pipeline-state.js';
import { appendTrajectory, readTrajectory } from '../../domains/engine/run-store.js';
import type { RunState } from '../../domains/engine/types.js';
import { loadRuntimePackage, loadSkillPackage } from '../../domains/skill/load.js';
import { readSkillSnapshot } from '../../domains/skill/snapshot.js';
import type { SkillPackage } from '../../domains/skill/types.js';

async function directoryExists(directory: string): Promise<boolean> {
  try {
    return (await fs.stat(directory)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function isPipelineRuntimePackageRoot(root: string): Promise<boolean> {
  if (!(await directoryExists(root))) return false;
  if (await fileExists(path.join(root, 'skill.yaml'))) return true;
  return (
    (await fileExists(path.join(root, 'SKILL.md'))) &&
    (await fileExists(path.join(root, 'owner', 'skill.yaml')))
  );
}

function embeddedPipelineRuntimePackage(root: string): SkillPackage {
  return {
    root,
    packageKind: 'runtime',
    definition: {
      apiVersion: 'owner/v1alpha1',
      kind: 'Skill',
      metadata: {
        name: 'owner-pipeline',
        version: '1',
        description:
          'Internal compatibility orchestration for pipeline Owner full, hotfix, and tweak workflows',
      },
      goal: {
        statement:
          'Advance or restore a pipeline Owner Run without changing the user command surface',
        inputs: [
          {
            name: 'pipeline-state',
            description: 'Validated PipelineState consistent with the Run projection',
            required: true,
          },
          {
            name: 'evidence',
            description: 'Structured evidence produced by the Pipeline Evidence collector',
            required: true,
          },
        ],
        outputs: [
          {
            name: 'run-state',
            description: 'Atomically synchronized Pipeline and Run state',
            required: true,
          },
        ],
        success: [
          'Legacy fields and Run fields remain consistent',
          'Every step invokes only a declared public Owner Skill',
          'The completed state passes its completion eval',
        ],
      },
      orchestration: {
        mode: 'deterministic',
        entry: 'full.open',
        steps: [
          {
            id: 'full.open',
            action: { type: 'invoke_skill', ref: 'owner-open' },
            next: 'full.design.handoff',
          },
          {
            id: 'full.design.handoff',
            action: { type: 'invoke_skill', ref: 'owner-design' },
            next: 'full.design.document',
          },
          {
            id: 'full.design.document',
            action: { type: 'invoke_skill', ref: 'owner-design' },
            next: 'full.build.plan',
          },
          {
            id: 'full.build.plan',
            action: { type: 'invoke_skill', ref: 'owner-build' },
            next: 'full.build.plan-ready',
          },
          {
            id: 'full.build.plan-ready',
            action: { type: 'invoke_skill', ref: 'owner-build' },
            next: 'full.build.configure',
          },
          {
            id: 'full.build.configure',
            action: { type: 'invoke_skill', ref: 'owner-build' },
            next: 'full.build.execute',
          },
          {
            id: 'full.build.execute',
            action: { type: 'invoke_skill', ref: 'owner-build' },
            next: 'full.build.complete',
          },
          {
            id: 'full.build.complete',
            action: { type: 'invoke_skill', ref: 'owner-build' },
            next: 'full.verify.run',
          },
          {
            id: 'full.build.fix',
            action: { type: 'invoke_skill', ref: 'owner-build' },
            next: 'full.build.execute',
          },
          {
            id: 'full.verify.run',
            action: { type: 'invoke_skill', ref: 'owner-verify' },
            next: 'full.verify.branch',
          },
          {
            id: 'full.verify.branch',
            action: { type: 'invoke_skill', ref: 'owner-verify' },
            next: 'full.archive.confirm',
          },
          {
            id: 'full.archive.confirm',
            action: { type: 'invoke_skill', ref: 'owner-archive' },
            next: 'full.archive.execute',
          },
          {
            id: 'full.archive.execute',
            action: { type: 'invoke_skill', ref: 'owner-archive' },
            next: 'completed',
          },
          {
            id: 'hotfix.open',
            action: { type: 'invoke_skill', ref: 'owner-hotfix' },
            next: 'hotfix.build.execute',
          },
          {
            id: 'hotfix.build.execute',
            action: { type: 'invoke_skill', ref: 'owner-build' },
            next: 'hotfix.build.complete',
          },
          {
            id: 'hotfix.build.complete',
            action: { type: 'invoke_skill', ref: 'owner-build' },
            next: 'hotfix.verify.run',
          },
          {
            id: 'hotfix.verify.run',
            action: { type: 'invoke_skill', ref: 'owner-verify' },
            next: 'hotfix.verify.branch',
          },
          {
            id: 'hotfix.verify.branch',
            action: { type: 'invoke_skill', ref: 'owner-verify' },
            next: 'hotfix.archive.confirm',
          },
          {
            id: 'hotfix.archive.confirm',
            action: { type: 'invoke_skill', ref: 'owner-archive' },
            next: 'hotfix.archive.execute',
          },
          {
            id: 'hotfix.archive.execute',
            action: { type: 'invoke_skill', ref: 'owner-archive' },
            next: 'completed',
          },
          {
            id: 'tweak.open',
            action: { type: 'invoke_skill', ref: 'owner-tweak' },
            next: 'tweak.build.execute',
          },
          {
            id: 'tweak.build.execute',
            action: { type: 'invoke_skill', ref: 'owner-build' },
            next: 'tweak.build.complete',
          },
          {
            id: 'tweak.build.complete',
            action: { type: 'invoke_skill', ref: 'owner-build' },
            next: 'tweak.verify.run',
          },
          {
            id: 'tweak.verify.run',
            action: { type: 'invoke_skill', ref: 'owner-verify' },
            next: 'tweak.verify.branch',
          },
          {
            id: 'tweak.verify.branch',
            action: { type: 'invoke_skill', ref: 'owner-verify' },
            next: 'tweak.archive.confirm',
          },
          {
            id: 'tweak.archive.confirm',
            action: { type: 'invoke_skill', ref: 'owner-archive' },
            next: 'tweak.archive.execute',
          },
          {
            id: 'tweak.archive.execute',
            action: { type: 'invoke_skill', ref: 'owner-archive' },
            next: 'completed',
          },
          {
            id: 'completed',
            action: { type: 'checkpoint' },
            completionEvals: ['pipeline-completed'],
          },
        ],
      },
      skills: [
        { id: 'owner-open' },
        { id: 'owner-design' },
        { id: 'owner-build' },
        { id: 'owner-verify' },
        { id: 'owner-archive' },
        { id: 'owner-hotfix' },
        { id: 'owner-tweak' },
      ],
      agents: [],
      tools: [],
    },
    guardrails: {
      allowedSkills: [
        'owner-open',
        'owner-design',
        'owner-build',
        'owner-verify',
        'owner-archive',
        'owner-hotfix',
        'owner-tweak',
      ],
      allowedAgents: [],
      allowedTools: [],
      maxIterations: 500,
      maxRetriesPerAction: 3,
      confirmationRequiredFor: [],
    },
    evals: [
      {
        id: 'pipeline-completed',
        scope: 'completion',
        type: 'state_equals',
        field: 'status',
        equals: 'completed',
      },
    ],
  };
}

async function pipelineRuntimeRoot(): Promise<string | null> {
  const runtimeDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.OWNER_RUNTIME_PIPELINE_ROOT,
    path.resolve(runtimeDirectory, '..', 'runtime', 'pipeline'),
    path.resolve(runtimeDirectory, '..', '..', 'owner', 'runtime', 'pipeline'),
    path.resolve(runtimeDirectory, '..', '..', 'assets', 'skills', 'owner', 'runtime', 'pipeline'),
    path.resolve('assets', 'skills', 'owner', 'runtime', 'pipeline'),
    process.env.OWNER_PIPELINE_SKILL_ROOT,
    path.resolve(runtimeDirectory, '..', '..', 'owner-pipeline'),
    path.resolve(runtimeDirectory, '..', '..', 'assets', 'skills', 'owner-pipeline'),
    path.resolve('assets', 'skills', 'owner-pipeline'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (await isPipelineRuntimePackageRoot(candidate)) return candidate;
  }
  return null;
}

async function loadPipelineRuntimePackage(root: string) {
  if (await fileExists(path.join(root, 'skill.yaml'))) {
    return loadRuntimePackage(root);
  }
  return loadSkillPackage(root);
}

export async function ensurePipelineRuntimeRun(changeDir: string): Promise<PipelineRunContext> {
  const root = await pipelineRuntimeRoot();
  return ensurePipelineRun(changeDir, {
    skillPackage: root
      ? await loadPipelineRuntimePackage(root)
      : embeddedPipelineRuntimePackage(path.dirname(fileURLToPath(import.meta.url))),
  });
}

export async function ensureStrictPipelineRuntimeRun(
  changeDir: string,
): Promise<PipelineRunContext> {
  const projection = await readPipelineState(changeDir);
  const unknownKeys = Array.from(new Set(projection.unknownKeys)).sort();
  if (unknownKeys.length > 0) {
    throw new Error(`Invalid Pipeline state: unknown field(s): ${unknownKeys.join(', ')}`);
  }
  return ensurePipelineRuntimeRun(changeDir);
}

export async function validatePipelineRuntimeRun(
  changeDir: string,
  existingProjection?: PipelineStateProjection,
): Promise<PipelineRunContext> {
  const projection = existingProjection ?? (await readPipelineState(changeDir, { migrate: false }));
  const unknownKeys = Array.from(new Set(projection.unknownKeys)).sort();
  if (unknownKeys.length > 0) {
    throw new Error(`Invalid Pipeline state: unknown field(s): ${unknownKeys.join(', ')}`);
  }
  if (!projection.pipeline || !projection.run) {
    throw new Error(
      'Pipeline runtime validation requires synchronized Pipeline and Run projections',
    );
  }
  if (projection.pipeline.pipelineMigration !== PIPELINE_MIGRATION_VERSION) {
    throw new Error('Pipeline Run exists without a supported pipeline_migration marker');
  }

  const root = await pipelineRuntimeRoot();
  const skillPackage = root
    ? await loadPipelineRuntimePackage(root)
    : embeddedPipelineRuntimePackage(path.dirname(fileURLToPath(import.meta.url)));
  if (projection.run.skill !== skillPackage.definition.metadata.name) {
    throw new Error(
      `Pipeline Run skill mismatch: expected ${skillPackage.definition.metadata.name}, got ${projection.run.skill}`,
    );
  }

  const snapshot = await readSkillSnapshot(changeDir, projection.run.skillHash);
  if (snapshot.definition.metadata.name !== projection.run.skill) {
    throw new Error(
      `Pipeline Run snapshot skill mismatch: expected ${projection.run.skill}, got ${snapshot.definition.metadata.name}`,
    );
  }
  const evidence = await collectPipelineEvidence(changeDir, projection);
  const currentStep = resolvePipelineStepId(projection.pipeline, evidence);
  if (projection.run.currentStep !== currentStep) {
    throw new Error(
      `Pipeline Run step mismatch: expected ${currentStep}, got ${projection.run.currentStep}`,
    );
  }
  return {
    pipeline: projection.pipeline,
    run: projection.run,
    evidence,
    migrated: false,
    snapshotDir: path.join(changeDir, '.owner', 'skill-snapshots', projection.run.skillHash),
  };
}

export async function transitionPipelineRuntimeRun(
  changeDir: string,
  pipeline: PipelineState,
  run: RunState,
  data: Record<string, unknown>,
): Promise<RunState> {
  const projection = await readPipelineState(changeDir);
  if (!projection.pipeline || !projection.run) {
    throw new Error('Pipeline transition requires synchronized Pipeline and Run projections');
  }

  const evidence = await collectPipelineEvidence(changeDir, {
    pipeline,
    run,
    unknownKeys: projection.unknownKeys,
  });
  const currentStep = resolvePipelineStepId(pipeline, evidence);
  const nextRun: RunState = {
    ...run,
    currentStep,
    iteration: run.iteration + 1,
    status: currentStep === 'completed' ? 'completed' : 'running',
  };

  await writePipelineState(changeDir, {
    pipeline,
    run: nextRun,
    unknownKeys: projection.unknownKeys,
  });

  const trajectory = await readTrajectory(changeDir, nextRun.trajectoryRef);
  await appendTrajectory(changeDir, nextRun.trajectoryRef, {
    sequence: trajectory.length + 1,
    timestamp: new Date().toISOString(),
    type: 'state_transitioned',
    runId: nextRun.runId,
    data: {
      kind: 'pipeline',
      fromStep: run.currentStep,
      toStep: currentStep,
      ...data,
    },
  });
  return nextRun;
}
