import {
  clearOwnerCurrentSelection,
  clearOwnerCurrentSelectionIf,
  ownerCurrentSelectionFile,
  readOwnerCurrentSelection,
  writeOwnerCurrentSelection,
  type OwnerCurrentSelection,
} from '../owner-entry/current-selection.js';
import { memoizedHookRead } from '../../platform/process/hook-read-cache.js';
import {
  driftStaleReason,
  resolveBranchBinding,
  unboundDetachedMessage,
} from './pipeline-branch-binding.js';
import {
  assertOpenSpecChangeName,
  inspectPipelineActiveChangeDirectory,
} from './pipeline-paths.js';
import { readPipelineState } from './pipeline-store.js';
import { resolvePipelineWorkspace } from './pipeline-workspace.js';
import { PipelineLayoutUnavailableError } from './pipeline-layout.js';

// Share the current-selection read with the router layer when both execute
// inside one Hook decision. The clear/write paths below keep the raw reader
// because they are not part of the cached Hook-read scope.
const readCachedCurrentSelection = memoizedHookRead(
  'readOwnerCurrentSelection',
  (projectRoot: string) => readOwnerCurrentSelection(projectRoot),
);

export type CurrentChangeSelection = OwnerCurrentSelection;

export type CurrentChangeResolution =
  | { status: 'selected'; selection: CurrentChangeSelection }
  | { status: 'missing' }
  | { status: 'stale'; reason: string };

export function currentChangeFile(projectRoot: string): string {
  return ownerCurrentSelectionFile(projectRoot);
}

async function validateActiveChange(projectRoot: string, changeName: string): Promise<string> {
  assertOpenSpecChangeName(changeName);
  const active = await inspectPipelineActiveChangeDirectory(changeName, projectRoot);
  if (!active.stateExists) {
    throw new Error(`Cannot select current change '${changeName}': active change state not found`);
  }

  const projection = await readPipelineState(active.directory, { migrate: false });
  if (!projection.pipeline) {
    throw new Error(`Cannot select current change '${changeName}': Pipeline state is incomplete`);
  }
  if (projection.pipeline.archived) {
    throw new Error(`Cannot select current change '${changeName}': change is archived`);
  }
  return active.directory;
}

export async function selectCurrentChange(
  projectRoot: string,
  changeName: string,
): Promise<CurrentChangeSelection> {
  assertOpenSpecChangeName(changeName);
  let localInspection: Awaited<ReturnType<typeof inspectPipelineActiveChangeDirectory>> = {
    label: '',
    directory: '',
    exists: false,
    stateExists: false,
  };
  try {
    localInspection = await inspectPipelineActiveChangeDirectory(changeName, projectRoot);
  } catch (error) {
    if (!(error instanceof PipelineLayoutUnavailableError)) throw error;
  }
  let workspace: Awaited<ReturnType<typeof resolvePipelineWorkspace>>;
  try {
    workspace = await resolvePipelineWorkspace({ projectRoot, name: changeName });
  } catch (error) {
    if (!localInspection.stateExists) await validateActiveChange(projectRoot, changeName);
    throw error;
  }
  const selectedProjectRoot = workspace.projectRoot;
  const changeDir = await validateActiveChange(selectedProjectRoot, changeName);
  const outcome = await resolveBranchBinding(changeDir, {
    heal: true,
    cwd: selectedProjectRoot,
  });
  if (outcome.status === 'drift') {
    throw new Error(driftStaleReason(changeName, outcome.boundBranch, outcome.currentBranch));
  }
  if (outcome.status === 'unbound-detached') {
    throw new Error(unboundDetachedMessage(changeName));
  }
  const selection: CurrentChangeSelection = {
    schema: 'owner.selection.v2',
    workflow: 'pipeline',
    change: changeName,
    branch: outcome.currentBranch,
  };
  await writeOwnerCurrentSelection(selectedProjectRoot, selection);
  return selection;
}

export async function resolveCurrentChange(projectRoot: string): Promise<CurrentChangeResolution> {
  let current;
  try {
    current = await readCachedCurrentSelection(projectRoot);
  } catch (error) {
    return {
      status: 'stale',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (current.status === 'missing') return { status: 'missing' };
  if (current.selection.workflow !== 'pipeline') {
    return {
      status: 'stale',
      reason: `current change '${current.selection.change}' belongs to Loop, not Pipeline`,
    };
  }

  const selection = current.selection;
  let changeDir: string;
  try {
    changeDir = await validateActiveChange(projectRoot, selection.change);
  } catch (error) {
    return {
      status: 'stale',
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const outcome = await resolveBranchBinding(changeDir, {
    heal: false,
    cwd: projectRoot,
  });
  if (outcome.status === 'drift') {
    return {
      status: 'stale',
      reason: driftStaleReason(selection.change, outcome.boundBranch, outcome.currentBranch),
    };
  }
  if (outcome.status === 'unbound-detached') {
    return { status: 'stale', reason: unboundDetachedMessage(selection.change) };
  }
  if (outcome.status === 'ok') return { status: 'selected', selection };
  if (selection.branch !== null && outcome.currentBranch !== selection.branch) {
    return {
      status: 'stale',
      reason: `current change '${selection.change}' was selected on branch '${selection.branch}', current branch is '${outcome.currentBranch ?? 'detached HEAD'}'`,
    };
  }
  return { status: 'selected', selection };
}

export async function clearCurrentChange(projectRoot: string): Promise<void> {
  let current;
  try {
    current = await readOwnerCurrentSelection(projectRoot);
  } catch {
    return;
  }
  if (current.status === 'selected' && current.selection.workflow === 'pipeline') {
    await clearOwnerCurrentSelection(projectRoot);
  }
}

export async function clearCurrentChangeIf(projectRoot: string, change: string): Promise<boolean> {
  return clearOwnerCurrentSelectionIf(projectRoot, 'pipeline', change);
}
