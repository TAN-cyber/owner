import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { collectPipelineEvidence, type PipelineEvidence } from './pipeline-evidence.js';
import { resolvePipelineStepId } from './pipeline-resolver.js';
import { readPipelineState, writePipelineState } from './pipeline-store.js';
import {
  PIPELINE_MIGRATION_VERSION,
  type PipelineProfile,
  type PipelineState,
} from './pipeline-state.js';
import { startRun } from '../../domains/engine/loop.js';
import {
  appendTrajectory,
  writeArtifacts,
  writeCheckpoint,
  writeContext,
} from '../../domains/engine/run-store.js';
import type { Checkpoint, RunState, TrajectoryEvent } from '../../domains/engine/types.js';
import {
  createSkillSnapshot,
  hashSkillPackage,
  readSkillSnapshot,
} from '../../domains/skill/snapshot.js';
import type { SkillPackage } from '../../domains/skill/types.js';
import { discoverPipelineProject } from './pipeline-layout.js';
import { readPipelineProjectFile } from './pipeline-protected-path.js';

export interface PipelineRunContext {
  pipeline: PipelineState;
  run: RunState;
  evidence: PipelineEvidence[];
  migrated: boolean;
  snapshotDir: string;
}

export interface EnsurePipelineRunOptions {
  skillPackage: SkillPackage;
  now?: () => Date;
  runId?: () => string;
  handoffReadHooks?: {
    afterOpen?: () => void | Promise<void>;
    beforeFinalCheck?: () => void | Promise<void>;
  };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function artifactHash(artifacts: Record<string, string>): string {
  return sha256(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(artifacts).sort(([left], [right]) => left.localeCompare(right)),
      ),
    ),
  );
}

function artifactKey(code: string): string {
  return code.replaceAll('.', '_').replaceAll('-', '_');
}

async function migrationArtifacts(
  changeDir: string,
  evidence: readonly PipelineEvidence[],
): Promise<Record<string, string>> {
  const projectRoot = await discoverPipelineProject(changeDir);
  const artifacts = Object.fromEntries(
    evidence
      .filter((item) => item.satisfied && item.source)
      .map((item) => [artifactKey(item.code), item.source!]),
  );
  const progress = path.join(changeDir, 'subagent-progress.md');
  if (await pathExists(progress)) {
    artifacts.subagent_progress = path.relative(projectRoot, progress).split(path.sep).join('/');
  }
  const handoff = evidence.find((item) => item.code === 'design.handoff' && item.satisfied);
  if (handoff?.source) artifacts.handoff_context = handoff.source;
  return artifacts;
}

function migrationEvents(
  run: RunState,
  profile: PipelineProfile,
  timestamp: string,
): TrajectoryEvent[] {
  return [
    {
      sequence: 1,
      timestamp,
      type: 'run_started',
      runId: run.runId,
      data: {
        skill: run.skill,
        skillVersion: run.skillVersion,
        skillHash: run.skillHash,
      },
    },
    {
      sequence: 2,
      timestamp,
      type: 'state_migrated',
      runId: run.runId,
      data: {
        kind: 'pipeline',
        migrationVersion: PIPELINE_MIGRATION_VERSION,
        profile,
        source: 'pre-migration',
      },
    },
  ];
}

async function removeCreatedFiles(files: readonly string[]): Promise<void> {
  await Promise.all(files.map((file) => fs.rm(file, { recursive: true, force: true })));
}

export async function ensurePipelineRun(
  changeDir: string,
  options: EnsurePipelineRunOptions,
): Promise<PipelineRunContext> {
  const projection = await readPipelineState(changeDir);
  if (!projection.pipeline) {
    throw new Error('Pipeline migration requires a legacy state projection');
  }
  const pipeline = projection.pipeline;
  const profile = pipeline.pipelineProfile ?? pipeline.workflow;

  if (projection.run) {
    if (pipeline.pipelineMigration !== PIPELINE_MIGRATION_VERSION) {
      throw new Error('Pipeline Run exists without a supported pipeline_migration marker');
    }
    if (projection.run.skill !== options.skillPackage.definition.metadata.name) {
      throw new Error(
        `Pipeline Run skill mismatch: expected ${options.skillPackage.definition.metadata.name}, got ${projection.run.skill}`,
      );
    }
    const installedHash = await hashSkillPackage(options.skillPackage);
    if (installedHash !== projection.run.skillHash) {
      await readSkillSnapshot(changeDir, projection.run.skillHash);
      return {
        pipeline,
        run: projection.run,
        evidence: await collectPipelineEvidence(changeDir, projection),
        migrated: false,
        snapshotDir: path.join(changeDir, '.owner', 'skill-snapshots', projection.run.skillHash),
      };
    }

    const snapshot = await createSkillSnapshot(options.skillPackage, changeDir);
    return {
      pipeline,
      run: projection.run,
      evidence: await collectPipelineEvidence(changeDir, projection),
      migrated: false,
      snapshotDir: snapshot.snapshotDir,
    };
  }

  const evidence = await collectPipelineEvidence(changeDir, projection);
  const step = resolvePipelineStepId(pipeline, evidence);
  if (!options.skillPackage.definition.orchestration.steps?.some((item) => item.id === step)) {
    throw new Error(`Pipeline Skill package does not define resolved step: ${step}`);
  }

  const expectedHash = await hashSkillPackage(options.skillPackage);
  const expectedSnapshotDir = path.join(changeDir, '.owner', 'skill-snapshots', expectedHash);
  const snapshotExisted = await pathExists(expectedSnapshotDir);
  const createdFiles: string[] = [];

  try {
    const snapshot = await createSkillSnapshot(options.skillPackage, changeDir);
    const run = startRun(options.skillPackage, options.runId?.() ?? randomUUID(), snapshot.hash);
    run.currentStep = step;
    if (step === 'completed') run.status = 'completed';

    const migratedPipeline: PipelineState = {
      ...pipeline,
      pipelineProfile: profile,
      pipelineMigration: PIPELINE_MIGRATION_VERSION,
    };
    const artifacts = await migrationArtifacts(changeDir, evidence);
    const projectRoot = await discoverPipelineProject(changeDir);
    const handoff = evidence.find((item) => item.code === 'design.handoff' && item.satisfied);
    let context: string | null = null;
    if (handoff?.source) {
      context = await readPipelineProjectFile(
        projectRoot,
        handoff.resolvedSource ?? handoff.source,
        {
          label: 'Pipeline migration handoff context',
          hooks: options.handoffReadHooks,
        },
      );
      await writeContext(changeDir, run.contextRef, context);
      createdFiles.push(path.resolve(changeDir, run.contextRef));
    }

    await writeArtifacts(changeDir, run.artifactsRef, artifacts);
    createdFiles.push(path.resolve(changeDir, run.artifactsRef));

    const timestamp = (options.now?.() ?? new Date()).toISOString();
    const checkpoint: Checkpoint = {
      runId: run.runId,
      stateVersion: 1,
      trajectoryOffset: 2,
      contextHash: context === null ? null : sha256(context),
      artifactsHash: artifactHash(artifacts),
      createdAt: timestamp,
    };
    await writeCheckpoint(changeDir, run.checkpointRef, checkpoint);
    createdFiles.push(path.resolve(changeDir, run.checkpointRef));

    createdFiles.push(path.resolve(changeDir, run.trajectoryRef));
    for (const event of migrationEvents(run, profile, timestamp)) {
      await appendTrajectory(changeDir, run.trajectoryRef, event);
    }

    await writePipelineState(changeDir, {
      pipeline: migratedPipeline,
      run,
      unknownKeys: projection.unknownKeys,
    });

    return {
      pipeline: migratedPipeline,
      run,
      evidence,
      migrated: true,
      snapshotDir: snapshot.snapshotDir,
    };
  } catch (error) {
    await removeCreatedFiles(createdFiles);
    if (!snapshotExisted) await fs.rm(expectedSnapshotDir, { recursive: true, force: true });
    throw error;
  }
}
