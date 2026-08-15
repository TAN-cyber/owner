import path from 'path';

export interface RunStorageLayout {
  stateRef: string;
  pendingRef: string;
  trajectoryRef: string;
  contextRef: string;
  artifactsRef: string;
  checkpointRef: string;
  snapshotsRef: string;
}

export const PIPELINE_RUN_STORAGE: Readonly<RunStorageLayout> = /* @__PURE__ */ Object.freeze({
  stateRef: '.owner/run-state.json',
  pendingRef: '.owner/pending-action.json',
  trajectoryRef: '.owner/trajectory.jsonl',
  contextRef: '.owner/context.md',
  artifactsRef: '.owner/artifacts.json',
  checkpointRef: '.owner/checkpoint.json',
  snapshotsRef: '.owner/skill-snapshots',
});

export const LOOP_RUN_STORAGE: Readonly<RunStorageLayout> = /* @__PURE__ */ Object.freeze({
  stateRef: 'runtime/run-state.json',
  pendingRef: 'runtime/pending-action.json',
  trajectoryRef: 'runtime/trajectory.jsonl',
  contextRef: 'runtime/context.md',
  artifactsRef: 'runtime/artifacts.json',
  checkpointRef: 'runtime/checkpoints/latest.json',
  snapshotsRef: 'runtime/skill-snapshots',
});

export function assertRunStorageRef(value: string): void {
  if (
    value.length === 0 ||
    path.isAbsolute(value) ||
    /^(?:[A-Za-z]:|[\\/]|~)/u.test(value) ||
    value.split(/[\\/]/u).includes('..')
  ) {
    throw new Error('Run storage ref must stay inside the Run root');
  }
}

export function assertRunStorageLayout(storage: Readonly<RunStorageLayout>): void {
  for (const value of Object.values(storage)) assertRunStorageRef(value);
}
