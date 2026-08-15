import {
  clearOwnerCurrentSelection,
  clearOwnerCurrentSelectionIf,
  ownerCurrentSelectionFile,
  readOwnerCurrentSelection,
  writeOwnerCurrentSelection,
  type OwnerCurrentSelection,
} from '../owner-entry/current-selection.js';
import { assertLoopName, readLoopChange } from './loop-change.js';
import { assertNoPendingLoopRootMove } from './loop-config.js';
import { withLoopMutationLock } from './loop-mutation-lock.js';
import type { LoopProjectPaths } from './loop-types.js';
import { isLoopPortableChange, readLoopPortableChange } from './loop-portable-runtime.js';

export const LOOP_SELECTION_MAX_BYTES = 16 * 1024;

export async function readLoopSelectionRecord(
  paths: LoopProjectPaths,
): Promise<OwnerCurrentSelection | null> {
  const current = await readOwnerCurrentSelection(paths.projectRoot);
  if (current.status === 'missing' || current.selection.workflow !== 'loop') return null;
  assertLoopName(current.selection.change);
  return current.selection;
}

export function loopSelectionFile(paths: LoopProjectPaths): string {
  return ownerCurrentSelectionFile(paths.projectRoot);
}

export async function selectLoopChange(paths: LoopProjectPaths, name: string): Promise<void> {
  return withLoopMutationLock(paths, `select change ${name}`, async () => {
    assertLoopName(name);
    if (await isLoopPortableChange(paths, name)) await readLoopPortableChange(paths, name);
    else await readLoopChange(paths, name);
    await writeOwnerCurrentSelection(paths.projectRoot, {
      schema: 'owner.selection.v2',
      workflow: 'loop',
      change: name,
      branch: null,
    });
  });
}

export async function resolveSelectedLoopChange(paths: LoopProjectPaths): Promise<string | null> {
  const value = await readLoopSelectionRecord(paths);
  if (!value) return null;
  if (await isLoopPortableChange(paths, value.change)) {
    await readLoopPortableChange(paths, value.change);
  } else {
    await readLoopChange(paths, value.change);
  }
  return value.change;
}

export async function clearLoopSelection(paths: LoopProjectPaths): Promise<void> {
  return withLoopMutationLock(paths, 'clear change selection', () =>
    clearLoopSelectionLocked(paths),
  );
}

export async function clearLoopSelectionLocked(paths: LoopProjectPaths): Promise<void> {
  await assertNoPendingLoopRootMove(paths.projectRoot);
  const current = await readOwnerCurrentSelection(paths.projectRoot);
  if (current.status === 'selected' && current.selection.workflow === 'loop') {
    await clearOwnerCurrentSelection(paths.projectRoot);
  }
}

export async function clearLoopSelectionIf(
  paths: LoopProjectPaths,
  name: string,
): Promise<boolean> {
  return withLoopMutationLock(paths, `clear selection for ${name}`, () =>
    clearLoopSelectionIfLocked(paths, name),
  );
}

export async function clearLoopSelectionIfLocked(
  paths: LoopProjectPaths,
  name: string,
): Promise<boolean> {
  await assertNoPendingLoopRootMove(paths.projectRoot);
  return clearOwnerCurrentSelectionIf(paths.projectRoot, 'loop', name);
}
