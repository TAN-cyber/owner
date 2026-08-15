import { LOOP_RUN_STORAGE } from '../engine/storage-layout.js';
import { loopChangeRuntimeDir, loopRuntimeRefFile } from './loop-paths.js';
import { readLoopCheckpoint, readLoopRunState, readLoopTrajectory } from './loop-run-store.js';
import { inspectLoopTrajectoryTail } from './loop-trajectory-recovery.js';
import type { LoopChangeState, LoopFinding, LoopProjectPaths } from './loop-types.js';

export async function inspectLoopRunConsistency(
  paths: LoopProjectPaths,
  state: LoopChangeState,
): Promise<LoopFinding[]> {
  const findings: LoopFinding[] = [];
  const runtimeDir = loopChangeRuntimeDir(paths, state.name);
  const stateFile = loopRuntimeRefFile(runtimeDir, LOOP_RUN_STORAGE.stateRef);
  let run;
  try {
    run = await readLoopRunState(runtimeDir);
  } catch (error) {
    return [
      {
        code: 'run-state-invalid',
        message: `Loop Run state is invalid: ${(error as Error).message}`,
        path: stateFile,
      },
    ];
  }
  if (!run) {
    if (state.run_id !== null || state.phase !== 'shape') {
      findings.push({
        code: 'run-state-missing',
        message: 'Loop change references a missing Run state',
        path: stateFile,
      });
    }
    return findings;
  }
  if (state.run_id === null) {
    return [
      {
        code: 'run-state-unexpected',
        message: 'Loop change has a Run state but no run_id',
        path: stateFile,
      },
    ];
  }
  if (run.runId !== state.run_id) {
    findings.push({
      code: 'run-id-mismatch',
      message: `Loop Run id ${run.runId} does not match change run_id ${state.run_id}`,
      path: stateFile,
    });
  }
  if (run.pending || run.status === 'waiting') {
    findings.push({
      code: 'run-action-pending',
      message: 'Loop Run has an unresolved pending action',
      path: stateFile,
    });
  }
  if (run.currentStep !== state.phase) {
    findings.push({
      code: 'run-phase-mismatch',
      message: `Loop Run step ${run.currentStep ?? '(none)'} does not match phase ${state.phase}`,
      path: stateFile,
    });
  }

  const trajectoryFile = loopRuntimeRefFile(runtimeDir, run.trajectoryRef);
  const tailInspection = await inspectLoopTrajectoryTail(paths, state.name);
  if (tailInspection.status === 'repairable') {
    findings.push({
      code: 'trajectory-tail-incomplete',
      message: `Loop trajectory final line is incomplete at line ${tailInspection.line}; doctor repair can discard ${tailInspection.discardedBytes} incomplete byte(s)`,
      path: trajectoryFile,
    });
    return findings;
  }
  if (tailInspection.status === 'invalid') {
    findings.push({
      code: 'trajectory-invalid',
      message: `Loop trajectory is invalid at line ${tailInspection.line}: ${tailInspection.message}`,
      path: trajectoryFile,
    });
    return findings;
  }
  let trajectory;
  try {
    trajectory = await readLoopTrajectory(runtimeDir, run.trajectoryRef);
    if (
      trajectory.length === 0 ||
      trajectory.some(
        (event, index) =>
          !event ||
          typeof event !== 'object' ||
          event.sequence !== index + 1 ||
          event.runId !== run.runId ||
          typeof event.type !== 'string' ||
          !event.data ||
          typeof event.data !== 'object' ||
          Array.isArray(event.data),
      )
    ) {
      throw new Error('trajectory events are missing or inconsistent');
    }
  } catch (error) {
    findings.push({
      code: 'trajectory-invalid',
      message: `Loop trajectory is invalid: ${(error as Error).message}`,
      path: trajectoryFile,
    });
    return findings;
  }

  const checkpointFile = loopRuntimeRefFile(runtimeDir, run.checkpointRef);
  try {
    const checkpoint = await readLoopCheckpoint(runtimeDir, run.checkpointRef);
    if (!checkpoint) {
      findings.push({
        code: 'checkpoint-missing',
        message: 'Loop Run checkpoint is missing',
        path: checkpointFile,
      });
    } else if (
      checkpoint.runId !== run.runId ||
      checkpoint.stateVersion !== run.iteration ||
      checkpoint.trajectoryOffset !== trajectory.length
    ) {
      findings.push({
        code: 'checkpoint-mismatch',
        message: 'Loop Run checkpoint does not match Run state and trajectory',
        path: checkpointFile,
      });
    }
  } catch (error) {
    findings.push({
      code: 'checkpoint-invalid',
      message: `Loop Run checkpoint is invalid: ${(error as Error).message}`,
      path: checkpointFile,
    });
  }
  return findings;
}
