import { discoverCachedLoopProject, readCachedProjectConfig } from './entry-reads.js';
import type { OwnerEntryResolution, OwnerWorkflow } from './types.js';

function configuredResolution(workflow: OwnerWorkflow): OwnerEntryResolution {
  return {
    workflow,
    skill: workflow === 'loop' ? 'owner-loop' : 'owner-pipeline',
    source: 'project-config',
  };
}

export async function resolveOwnerEntry(startPath: string): Promise<OwnerEntryResolution> {
  const projectRoot = await discoverCachedLoopProject(startPath);
  const config = await readCachedProjectConfig(projectRoot);
  if (!config) {
    throw new Error('Owner workflow entry is unavailable because .owner/config.yaml is missing');
  }
  return configuredResolution(config.default_workflow);
}
