import path from 'path';

import {
  OWNER_WORKFLOW_RESOLUTION_SCHEMA,
  formatOwnerWorkflowResolution,
  resolveOwnerWorkflowResolution,
} from '../../domains/owner-entry/workflow-resolution.js';
import { resolveOrActivateOwnerEntry } from '../../domains/owner-entry/project-activation.js';

interface WorkflowResolveOptions {
  json?: boolean;
  activate?: boolean;
}

export async function workflowResolveCommand(
  targetPath: string,
  options: WorkflowResolveOptions = {},
): Promise<void> {
  const absoluteTarget = path.resolve(targetPath);
  const resolution = options.activate
    ? {
        schema: OWNER_WORKFLOW_RESOLUTION_SCHEMA,
        ...(await resolveOrActivateOwnerEntry(absoluteTarget)),
      }
    : await resolveOwnerWorkflowResolution(absoluteTarget);
  if (options.json) {
    console.log(JSON.stringify(resolution, null, 2));
    return;
  }
  console.log(formatOwnerWorkflowResolution(resolution));
}
