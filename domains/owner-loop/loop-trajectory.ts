import type { Checkpoint, RunState, TrajectoryEvent } from '../engine/types.js';
import { sha256Text } from './loop-hash.js';
import {
  appendLoopTrajectory,
  readLoopTrajectory,
  writeLoopCheckpoint as persistLoopRunCheckpoint,
} from './loop-run-store.js';

export async function appendLoopTrajectoryEvent(options: {
  changeDir: string;
  run: RunState;
  type: TrajectoryEvent['type'];
  data: Record<string, unknown>;
  now?: Date;
}): Promise<TrajectoryEvent> {
  const trajectory = await readLoopTrajectory(options.changeDir, options.run.trajectoryRef);
  const event: TrajectoryEvent = {
    sequence: trajectory.length + 1,
    timestamp: (options.now ?? new Date()).toISOString(),
    type: options.type,
    runId: options.run.runId,
    data: options.data,
  };
  await appendLoopTrajectory(options.changeDir, options.run.trajectoryRef, event);
  return event;
}

export async function writeLoopCheckpoint(options: {
  changeDir: string;
  run: RunState;
  trajectoryOffset: number;
  evidenceHash: string;
  now?: Date;
}): Promise<Checkpoint> {
  const checkpoint: Checkpoint = {
    runId: options.run.runId,
    stateVersion: options.run.iteration,
    trajectoryOffset: options.trajectoryOffset,
    contextHash: null,
    artifactsHash: sha256Text(options.evidenceHash),
    createdAt: (options.now ?? new Date()).toISOString(),
  };
  await persistLoopRunCheckpoint(options.changeDir, options.run.checkpointRef, checkpoint);
  return checkpoint;
}
