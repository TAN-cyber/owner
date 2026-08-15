import { clearOwnerCurrentSelection, migrateLegacyClassicSelection } from './current-selection.js';
import { resolveHookWorkflowOwner } from './hook-router.js';

export interface RepairOwnerCurrentSelectionOptions {
  migrateLegacyClassic: boolean;
}

export interface RepairOwnerCurrentSelectionResult {
  migratedLegacyClassic: boolean;
  clearedStaleSelection: boolean;
}

interface RepairOwnerCurrentSelectionDependencies {
  migrateLegacyClassic: typeof migrateLegacyClassicSelection;
  resolveOwner: typeof resolveHookWorkflowOwner;
  clearSelection: typeof clearOwnerCurrentSelection;
}

const DEFAULT_DEPENDENCIES: RepairOwnerCurrentSelectionDependencies = {
  migrateLegacyClassic: migrateLegacyClassicSelection,
  resolveOwner: resolveHookWorkflowOwner,
  clearSelection: clearOwnerCurrentSelection,
};

export async function repairOwnerCurrentSelection(
  projectRoot: string,
  options: RepairOwnerCurrentSelectionOptions,
  dependencies: RepairOwnerCurrentSelectionDependencies = DEFAULT_DEPENDENCIES,
): Promise<RepairOwnerCurrentSelectionResult> {
  const migratedLegacyClassic = options.migrateLegacyClassic
    ? await dependencies.migrateLegacyClassic(projectRoot)
    : false;

  const resolution = await dependencies.resolveOwner(projectRoot);
  if (!('staleSelection' in resolution) || resolution.staleSelection?.code !== 'target-missing') {
    return { migratedLegacyClassic, clearedStaleSelection: false };
  }

  await dependencies.clearSelection(projectRoot);
  return { migratedLegacyClassic, clearedStaleSelection: true };
}
