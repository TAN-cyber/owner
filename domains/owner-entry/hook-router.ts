import {
  inspectClassicHookGuard,
  listActiveClassicHookChanges,
} from '../owner-classic/classic-hook-guard.js';
import { ClassicLayoutUnavailableError } from '../owner-classic/classic-layout.js';
import { resolveCurrentChange } from '../owner-classic/classic-current-change.js';
import {
  inspectNativeHookGuard,
  listActiveNativeHookChanges,
} from '../owner-native/native-hook-guard.js';
import { memoizedHookRead } from '../../platform/process/hook-read-cache.js';
import { readWorkflowProjectConfig } from '../workflow-contract/project-config-reader.js';
import { readOwnerCurrentSelection } from './current-selection.js';
import { readCachedProjectConfig } from './entry-reads.js';
import { scopeOwnerHookTargets } from '../workflow-contract/hook-target-scope.js';
import type { OwnerHookDecision, OwnerHookRequest } from './hook-types.js';
import type { OwnerWorkflow } from './types.js';

// Wrap the hot reads so that within one Hook decision the router and the
// delegated Classic/Native Guard share a single config + selection read
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
        | 'classic-selection-invalid';
      reason: string;
    };

interface HookRouterDependencies {
  listNative: typeof listActiveNativeHookChanges;
  listClassic: typeof listActiveClassicHookChanges;
  inspectNative: typeof inspectNativeHookGuard;
  inspectClassic: typeof inspectClassicHookGuard;
  scopeTargets?: typeof scopeOwnerHookTargets;
}

const DEFAULT_DEPENDENCIES: HookRouterDependencies = {
  listNative: listActiveNativeHookChanges,
  listClassic: listActiveClassicHookChanges,
  inspectNative: inspectNativeHookGuard,
  inspectClassic: inspectClassicHookGuard,
};

function enabledWorkflows(
  config: Awaited<ReturnType<typeof readWorkflowProjectConfig>>,
): OwnerWorkflow[] {
  if (!config) return ['classic'];
  return config.workflows ?? [config.default_workflow];
}

async function listEnabledActiveChanges(
  projectRoot: string,
  enabled: OwnerWorkflow[],
  dependencies: Pick<HookRouterDependencies, 'listNative' | 'listClassic'>,
  cached?: { workflow: OwnerWorkflow; candidates: ActiveHookChange[] },
  options: { tolerateUnavailableClassic?: boolean } = {},
): Promise<ActiveHookChange[]> {
  const listClassic = async (): Promise<ActiveHookChange[]> => {
    if (!enabled.includes('classic')) return [];
    if (cached?.workflow === 'classic') return cached.candidates;
    try {
      return await dependencies.listClassic(projectRoot);
    } catch (error) {
      if (options.tolerateUnavailableClassic && error instanceof ClassicLayoutUnavailableError) {
        return [];
      }
      throw error;
    }
  };
  const [native, classic] = await Promise.all([
    enabled.includes('native')
      ? cached?.workflow === 'native'
        ? cached.candidates
        : dependencies.listNative(projectRoot)
      : [],
    listClassic(),
  ]);
  return [...native, ...classic];
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
  dependencies: Pick<HookRouterDependencies, 'listNative' | 'listClassic'> = DEFAULT_DEPENDENCIES,
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
        selection.workflow === 'native'
          ? await dependencies.listNative(projectRoot)
          : await dependencies.listClassic(projectRoot);
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
    if (selection.workflow === 'classic') {
      const resolved = await resolveCurrentChange(projectRoot);
      if (resolved.status !== 'selected') {
        return {
          status: 'stale',
          code: 'classic-selection-invalid',
          reason:
            resolved.status === 'stale'
              ? resolved.reason
              : `selected Classic change '${selection.change}' is no longer active`,
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
        tolerateUnavailableClassic: true,
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
        reason: `${resolution.reason}. Resume /owner-native or /owner-classic and select the current change before retrying`,
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
    return owner.workflow === 'native'
      ? dependencies.inspectNative(projectRoot, projectRequest, owner.name)
      : dependencies.inspectClassic(projectRoot, owner.name, projectRequest);
  } catch (error) {
    return {
      allowed: false,
      reason: `Owner Hook Router failed closed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
