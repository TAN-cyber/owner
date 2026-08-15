import {
  inspectPipelineHookGuard,
  listActivePipelineHookChanges,
} from '../owner-pipeline/pipeline-hook-guard.js';
import { PipelineLayoutUnavailableError } from '../owner-pipeline/pipeline-layout.js';
import { resolveCurrentChange } from '../owner-pipeline/pipeline-current-change.js';
import { inspectLoopHookGuard, listActiveLoopHookChanges } from '../owner-loop/loop-hook-guard.js';
import { memoizedHookRead } from '../../platform/process/hook-read-cache.js';
import { readWorkflowProjectConfig } from '../workflow-contract/project-config-reader.js';
import { readOwnerCurrentSelection } from './current-selection.js';
import { readCachedProjectConfig } from './entry-reads.js';
import { scopeOwnerHookTargets } from '../workflow-contract/hook-target-scope.js';
import type { OwnerHookDecision, OwnerHookRequest } from './hook-types.js';
import type { OwnerWorkflow } from './types.js';

// Wrap the hot reads so that within one Hook decision the router and the
// delegated Pipeline/Loop Guard share a single config + selection read
// instead of each re-opening the same files.
const readCachedCurrentSelection = memoizedHookRead(
  'readOwnerCurrentSelection',
  (projectRoot: string) => readOwnerCurrentSelection(projectRoot),
);

export interface ActiveHookChange {
  workflow: OwnerWorkflow;
  name: string;
  phase: string;
}

interface StaleHookSelection {
  code: 'target-missing';
  reason: string;
}

export type HookWorkflowOwnerResolution =
  | { status: 'none'; staleSelection?: StaleHookSelection }
  | { status: 'owned'; owner: ActiveHookChange }
  | { status: 'inferred'; owner: ActiveHookChange; staleSelection?: StaleHookSelection }
  | {
      status: 'ambiguous';
      candidates: ActiveHookChange[];
      staleSelection?: StaleHookSelection;
    }
  | {
      status: 'stale';
      code:
        | 'selection-unreadable'
        | 'change-state-unreadable'
        | 'workflow-disabled'
        | 'pipeline-selection-invalid';
      reason: string;
    };

interface HookRouterDependencies {
  listLoop: typeof listActiveLoopHookChanges;
  listPipeline: typeof listActivePipelineHookChanges;
  inspectLoop: typeof inspectLoopHookGuard;
  inspectPipeline: typeof inspectPipelineHookGuard;
  scopeTargets?: typeof scopeOwnerHookTargets;
}

const DEFAULT_DEPENDENCIES: HookRouterDependencies = {
  listLoop: listActiveLoopHookChanges,
  listPipeline: listActivePipelineHookChanges,
  inspectLoop: inspectLoopHookGuard,
  inspectPipeline: inspectPipelineHookGuard,
};

function enabledWorkflows(
  config: Awaited<ReturnType<typeof readWorkflowProjectConfig>>,
): OwnerWorkflow[] {
  if (!config) return ['pipeline'];
  return config.workflows ?? [config.default_workflow];
}

async function listEnabledActiveChanges(
  projectRoot: string,
  enabled: OwnerWorkflow[],
  dependencies: Pick<HookRouterDependencies, 'listLoop' | 'listPipeline'>,
  cached?: { workflow: OwnerWorkflow; candidates: ActiveHookChange[] },
  options: { tolerateUnavailablePipeline?: boolean } = {},
): Promise<ActiveHookChange[]> {
  const listPipeline = async (): Promise<ActiveHookChange[]> => {
    if (!enabled.includes('pipeline')) return [];
    if (cached?.workflow === 'pipeline') return cached.candidates;
    try {
      return await dependencies.listPipeline(projectRoot);
    } catch (error) {
      if (options.tolerateUnavailablePipeline && error instanceof PipelineLayoutUnavailableError) {
        return [];
      }
      throw error;
    }
  };
  const [loop, pipeline] = await Promise.all([
    enabled.includes('loop')
      ? cached?.workflow === 'loop'
        ? cached.candidates
        : dependencies.listLoop(projectRoot)
      : [],
    listPipeline(),
  ]);
  return [...loop, ...pipeline];
}

function resolveActiveCandidates(
  candidates: ActiveHookChange[],
  staleSelection?: StaleHookSelection,
): HookWorkflowOwnerResolution {
  if (candidates.length === 0) return { status: 'none', staleSelection };
  if (candidates.length === 1) {
    return { status: 'inferred', owner: candidates[0], staleSelection };
  }
  return { status: 'ambiguous', candidates, staleSelection };
}

export async function resolveHookWorkflowOwner(
  projectRoot: string,
  dependencies: Pick<HookRouterDependencies, 'listLoop' | 'listPipeline'> = DEFAULT_DEPENDENCIES,
): Promise<HookWorkflowOwnerResolution> {
  const config = await readCachedProjectConfig(projectRoot);
  const enabled = enabledWorkflows(config);
  let current;
  try {
    current = await readCachedCurrentSelection(projectRoot);
  } catch (error) {
    return {
      status: 'stale',
      code: 'selection-unreadable',
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (current.status === 'selected') {
    const selection = current.selection;
    if (!enabled.includes(selection.workflow)) {
      return {
        status: 'stale',
        code: 'workflow-disabled',
        reason: `selected workflow '${selection.workflow}' is not enabled for this project`,
      };
    }
    let selectedCandidates: ActiveHookChange[];
    try {
      selectedCandidates =
        selection.workflow === 'loop'
          ? await dependencies.listLoop(projectRoot)
          : await dependencies.listPipeline(projectRoot);
    } catch (error) {
      return {
        status: 'stale',
        code: 'change-state-unreadable',
        reason: `cannot safely enumerate active Owner changes: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const owner = selectedCandidates.find((candidate) => candidate.name === selection.change);
    if (!owner) {
      const staleSelection: StaleHookSelection = {
        code: 'target-missing',
        reason: `selected ${selection.workflow} change '${selection.change}' is missing or archived`,
      };
      try {
        const candidates = await listEnabledActiveChanges(projectRoot, enabled, dependencies, {
          workflow: selection.workflow,
          candidates: selectedCandidates,
        });
        return resolveActiveCandidates(candidates, staleSelection);
      } catch (error) {
        return {
          status: 'stale',
          code: 'change-state-unreadable',
          reason: `cannot safely enumerate active Owner changes: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    if (selection.workflow === 'pipeline') {
      const resolved = await resolveCurrentChange(projectRoot);
      if (resolved.status !== 'selected') {
        return {
          status: 'stale',
          code: 'pipeline-selection-invalid',
          reason:
            resolved.status === 'stale'
              ? resolved.reason
              : `selected Pipeline change '${selection.change}' is no longer active`,
        };
      }
    }
    return { status: 'owned', owner };
  }

  try {
    const candidates = await listEnabledActiveChanges(
      projectRoot,
      enabled,
      dependencies,
      undefined,
      {
        tolerateUnavailablePipeline: true,
      },
    );
    return resolveActiveCandidates(candidates);
  } catch (error) {
    return {
      status: 'stale',
      code: 'change-state-unreadable',
      reason: `cannot safely enumerate active Owner changes: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function inspectOwnerHook(
  projectRoot: string,
  request: OwnerHookRequest,
  dependencies: HookRouterDependencies = DEFAULT_DEPENDENCIES,
): Promise<OwnerHookDecision> {
  if (request.intent === 'non-write') {
    return { allowed: true, reason: 'Hook event is not a write' };
  }
  if (request.intent === 'unknown' || request.targets.length === 0) {
    return { allowed: true, reason: 'Hook write target is outside Owner attribution' };
  }

  let projectRequest: OwnerHookRequest;
  try {
    const scoped = await (dependencies.scopeTargets ?? scopeOwnerHookTargets)(
      projectRoot,
      request.targets,
    );
    if (scoped.projectTargets.length === 0) {
      return { allowed: true, reason: 'Write targets are outside the guarded project' };
    }
    projectRequest = { ...request, targets: scoped.projectTargets };
  } catch (error) {
    return {
      allowed: false,
      reason: [
        'Owner Hook Router scope could not be determined safely.',
        `Reason: ${error instanceof Error ? error.message : String(error)}`,
        'Next: verify that the project root is accessible, then retry the write.',
      ].join(' '),
    };
  }

  try {
    const resolution = await resolveHookWorkflowOwner(projectRoot, dependencies);
    if (resolution.status === 'none') {
      return { allowed: true, reason: 'No active Owner change' };
    }
    if (resolution.status === 'stale') {
      return {
        allowed: false,
        reason: `${resolution.reason}. Resume /owner-loop or /owner-pipeline and select the current change before retrying`,
      };
    }
    if (resolution.status === 'ambiguous') {
      return {
        allowed: false,
        reason: `Multiple active Owner changes require one current selection: ${resolution.candidates
          .map((candidate) => `${candidate.workflow}:${candidate.name}`)
          .join(', ')}`,
      };
    }

    const owner = resolution.owner;
    return owner.workflow === 'loop'
      ? dependencies.inspectLoop(projectRoot, projectRequest, owner.name)
      : dependencies.inspectPipeline(projectRoot, owner.name, projectRequest);
  } catch (error) {
    return {
      allowed: false,
      reason: `Owner Hook Router failed closed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
