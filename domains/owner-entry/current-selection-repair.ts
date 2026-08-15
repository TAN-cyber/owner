import { clearOwnerCurrentSelection, migrateLegacyPipelineSelection } from './current-selection.js';
import { resolveHookWorkflowOwner } from './hook-router.js';

export interface RepairOwnerCurrentSelectionOptions {
  migrateLegacyPipeline: boolean;
}

export interface RepairOwnerCurrentSelectionResult {
  migratedLegacyPipeline: boolean;
  clearedStaleSelection: boolean;
}

interface RepairOwnerCurrentSelectionDependencies {
  migrateLegacyPipeline: typeof migrateLegacyPipelineSelection;
  resolveOwner: typeof resolveHookWorkflowOwner;
  clearSelection: typeof clearOwnerCurrentSelection;
}

const DEFAULT_DEPENDENCIES: RepairOwnerCurrentSelectionDependencies = {
  migrateLegacyPipeline: migrateLegacyPipelineSelection,
  resolveOwner: resolveHookWorkflowOwner,
  clearSelection: clearOwnerCurrentSelection,
};

export async function repairOwnerCurrentSelection(
  projectRoot: string,
  options: RepairOwnerCurrentSelectionOptions,
  dependencies: RepairOwnerCurrentSelectionDependencies = DEFAULT_DEPENDENCIES,
): Promise<RepairOwnerCurrentSelectionResult> {
  const migratedLegacyPipeline = options.migrateLegacyPipeline
    ? await dependencies.migrateLegacyPipeline(projectRoot)
    : false;

  const resolution = await dependencies.resolveOwner(projectRoot);
  if (!('staleSelection' in resolution) || resolution.staleSelection?.code !== 'target-missing') {
    return { migratedLegacyPipeline, clearedStaleSelection: false };
  }

  await dependencies.clearSelection(projectRoot);
  return { migratedLegacyPipeline, clearedStaleSelection: true };
}
