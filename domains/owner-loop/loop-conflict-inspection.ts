import { readLoopChange } from './loop-change.js';
import {
  buildLoopConflictRadar,
  LOOP_CONFLICT_RADAR_LIMITS,
  type LoopConflictRadarChangeInput,
  type LoopConflictRadarSnapshot,
} from './loop-conflict-radar.js';
import { readLoopImplementationScope } from './loop-evidence-storage.js';
import { readLoopProtectedDirectory } from './loop-protected-file.js';
import type { LoopProjectPaths } from './loop-types.js';
import { readLoopWorkspaceIdentity } from './loop-workspace.js';

const LOOP_TARGETED_CONFLICT_MAX_CHANGES = 4_096;

async function visibleChangeEntries(
  paths: LoopProjectPaths,
  maxEntries: number = LOOP_CONFLICT_RADAR_LIMITS.maxChanges,
) {
  try {
    const directory = await readLoopProtectedDirectory({
      root: paths.loopRoot,
      directory: paths.changesDir,
      label: 'Loop conflict changes directory',
      maxEntries,
    });
    await directory.verify();
    return directory.entries;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function collectConflictInput(
  paths: LoopProjectPaths,
  name: string,
): Promise<LoopConflictRadarChangeInput> {
  const state = await readLoopChange(paths, name);
  const [scope, workspace] = await Promise.all([
    state.implementation_scope
      ? readLoopImplementationScope(paths, name, state.implementation_scope)
      : null,
    // Workspace identity is advisory. A malformed advisory must not suppress deterministic
    // capability/artifact conflict facts.
    readLoopWorkspaceIdentity(paths, name).catch(() => null),
  ]);
  return {
    name: state.name,
    revision: state.revision,
    specs: state.spec_changes.map((spec) => ({
      capability: spec.capability,
      operation: spec.operation,
      baseHash: spec.base_hash,
    })),
    declaredArtifacts: scope?.declaredArtifacts ?? [],
    workspaceIdentityHash: workspace?.loopRootId ?? null,
  };
}

async function collectConflictInputs(
  paths: LoopProjectPaths,
): Promise<LoopConflictRadarChangeInput[]> {
  const entries = await visibleChangeEntries(paths);
  const names = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
  return Promise.all(names.map((name) => collectConflictInput(paths, name)));
}

export interface LoopChangeConflictInspection {
  definiteConflictCount: number;
  possibleOverlapCount: number;
  findingCodes: Array<'loop-change-conflict' | 'loop-change-overlap'>;
}

/**
 * Recompute conflicts from every currently visible change in one physical Loop root.
 *
 * Invalid state or evidence fails the whole inspection closed so Archive cannot silently omit a
 * competing change. Workspace metadata alone remains advisory and may be ignored when invalid.
 */
export async function inspectLoopConflictRadar(
  paths: LoopProjectPaths,
): Promise<LoopConflictRadarSnapshot> {
  return buildLoopConflictRadar(await collectConflictInputs(paths));
}

/** Compute every relationship for one change even when the global radar detail view is truncated. */
export async function inspectLoopChangeConflicts(
  paths: LoopProjectPaths,
  name: string,
  options: { tolerateInvalidSiblings?: boolean } = {},
): Promise<LoopChangeConflictInspection> {
  const entries = await visibleChangeEntries(paths, LOOP_TARGETED_CONFLICT_MAX_CHANGES);
  const names = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
  if (!names.includes(name)) throw new Error(`Loop conflict target is not visible: ${name}`);
  const target = await collectConflictInput(paths, name);
  let definiteConflictCount = 0;
  let possibleOverlapCount = 0;
  for (const otherName of names) {
    if (otherName === name) continue;
    const other = await collectConflictInput(paths, otherName).catch((error: unknown) => {
      if (options.tolerateInvalidSiblings) return null;
      throw error;
    });
    if (!other) continue;
    const relationship = buildLoopConflictRadar([target, other]).relationships[0];
    if (relationship.classification === 'definite-conflict') definiteConflictCount += 1;
    if (relationship.classification === 'possible-overlap') possibleOverlapCount += 1;
  }
  return {
    definiteConflictCount,
    possibleOverlapCount,
    findingCodes: [
      ...(definiteConflictCount > 0 ? (['loop-change-conflict'] as const) : []),
      ...(possibleOverlapCount > 0 ? (['loop-change-overlap'] as const) : []),
    ],
  };
}
