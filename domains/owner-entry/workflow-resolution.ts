import type { OwnerEntryResolution } from './types.js';
import { resolveOwnerEntry } from './resolve-entry.js';

export const OWNER_WORKFLOW_RESOLUTION_SCHEMA = 'owner.workflow-resolution.v1' as const;

export interface OwnerWorkflowResolution extends OwnerEntryResolution {
  schema: typeof OWNER_WORKFLOW_RESOLUTION_SCHEMA;
}

export async function resolveOwnerWorkflowResolution(
  startPath: string,
): Promise<OwnerWorkflowResolution> {
  return {
    schema: OWNER_WORKFLOW_RESOLUTION_SCHEMA,
    ...(await resolveOwnerEntry(startPath)),
  };
}

export function formatOwnerWorkflowResolution(resolution: OwnerWorkflowResolution): string {
  return [
    `workflow: ${resolution.workflow}`,
    `skill: ${resolution.skill}`,
    `source: ${resolution.source}`,
  ].join('\n');
}
