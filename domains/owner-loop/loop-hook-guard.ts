import { promises as fs } from 'fs';
import path from 'path';

import { memoizedHookRead } from '../../platform/process/hook-read-cache.js';
import { parseOwnerHookRequest, readOwnerHookRequest } from '../owner-entry/hook-adapter.js';
import type {
  OwnerHookDecision,
  OwnerHookIntent,
  OwnerHookRequest,
} from '../owner-entry/hook-types.js';
import { readLoopChange } from './loop-change.js';
import { readProjectConfig } from './loop-config.js';
import { loopProjectPaths } from './loop-paths.js';
import { configuredHookWritePath } from '../workflow-contract/hook-write-policy.js';
import { resolveSelectedLoopChange } from './loop-selection.js';
import type { LoopChangeState, LoopProjectPaths } from './loop-types.js';
import {
  isLoopPortableChange,
  loopPortableChangeDir,
  readLoopPortableChange,
  returnLoopPortableChangeToBuild,
  returnLoopPortableChangeToShape,
} from './loop-portable-runtime.js';
import type { LoopPortableState } from './loop-portable-types.js';

export type LoopHookIntent = OwnerHookIntent;
export interface LoopHookRequest extends Omit<OwnerHookRequest, 'toolName'> {
  toolName?: string | null;
}

export type LoopHookGuardResult = OwnerHookDecision;

export interface ActiveLoopHookChange {
  workflow: 'loop';
  name: string;
  phase: LoopChangeState['phase'];
}

interface ActiveLoopContext {
  paths: LoopProjectPaths;
  changes: Array<
    { kind: 'legacy'; state: LoopChangeState } | { kind: 'portable'; state: LoopPortableState }
  >;
}

async function inspectPortableWriteTargets(options: {
  projectRoot: string;
  paths: LoopProjectPaths;
  state: LoopPortableState;
  request: LoopHookRequest;
}): Promise<LoopHookGuardResult> {
  const { projectRoot, paths, state, request } = options;
  const changeDir = loopPortableChangeDir(paths, state.name);
  const formalTargets: string[] = [];
  const implementationTargets: string[] = [];
  let configuredTarget = false;
  let controlTarget = false;
  let externalTarget = false;

  for (const targetPath of request.targets) {
    const target = path.resolve(projectRoot, targetPath);
    if (!isWithin(projectRoot, target)) {
      externalTarget = true;
      continue;
    }
    const relative = path.relative(projectRoot, target).replaceAll('\\', '/');
    if (relative === '.owner/config.yaml') {
      controlTarget = true;
      continue;
    }
    if (!isWithin(paths.loopRoot, target)) {
      if (
        await configuredHookWritePath(projectRoot, target, [
          path.join(projectRoot, '.owner'),
          paths.loopRoot,
        ])
      ) {
        configuredTarget = true;
        continue;
      }
      implementationTargets.push(relative);
      continue;
    }
    if (!isWithin(changeDir, target)) {
      return {
        allowed: false,
        reason: 'Portable Loop control state is Runtime-owned',
        workflow: 'loop',
        phase: state.phase,
        change: state.name,
      };
    }
    const changeRelative = path.relative(changeDir, target).replaceAll('\\', '/');
    if (
      changeRelative === 'brief.md' ||
      changeRelative === 'children.yaml' ||
      changeRelative.startsWith('specs/')
    ) {
      formalTargets.push(changeRelative);
      continue;
    }
    return {
      allowed: false,
      reason: `${changeRelative || 'change directory'} is Runtime-owned and cannot be edited by the Agent`,
      workflow: 'loop',
      phase: state.phase,
      change: state.name,
    };
  }

  if (formalTargets.length > 0 && implementationTargets.length > 0) {
    return {
      allowed: false,
      reason:
        'Formal Loop requirements and implementation files must be edited in separate actions',
      workflow: 'loop',
      phase: state.phase,
      change: state.name,
    };
  }
  if (formalTargets.length > 0) {
    if (state.phase !== 'shape') {
      const returned = await returnLoopPortableChangeToShape({
        paths,
        name: state.name,
        reason: `Formal requirement write requested for ${formalTargets.join(', ')}`,
      });
      return {
        allowed: true,
        reason: `Loop requirements changed; returned to Shape goal cycle ${returned.loop.goal_cycle}`,
        workflow: 'loop',
        phase: 'shape',
        change: state.name,
      };
    }
    return {
      allowed: true,
      reason: 'Loop control artifact write',
      workflow: 'loop',
      phase: state.phase,
      change: state.name,
    };
  }
  if (implementationTargets.length > 0) {
    if (state.children_contract_hash) {
      return {
        allowed: false,
        reason: 'Loop parent Build advances child changes instead of editing implementation',
        workflow: 'loop',
        phase: state.phase,
        change: state.name,
      };
    }
    if (state.phase === 'build') {
      return {
        allowed: true,
        reason: 'Loop change is in Build',
        workflow: 'loop',
        phase: state.phase,
        change: state.name,
      };
    }
    if (state.phase === 'verify' || state.phase === 'archive') {
      const returned = await returnLoopPortableChangeToBuild({
        paths,
        name: state.name,
        reason: `Observed implementation write before ${implementationTargets.join(', ')}`,
      });
      return {
        allowed: true,
        reason: `Loop candidate was invalidated and returned to Build iteration ${returned.loop.iteration}`,
        workflow: 'loop',
        phase: 'build',
        change: state.name,
      };
    }
    return {
      allowed: false,
      reason: `Loop change ${state.name} is in ${state.phase}; implementation writes are only allowed in Build`,
      workflow: 'loop',
      phase: state.phase,
      change: state.name,
    };
  }
  if (configuredTarget) {
    return {
      allowed: true,
      reason: 'Loop configured Hook allow path',
      workflow: 'loop',
      phase: state.phase,
      change: state.name,
    };
  }
  return {
    allowed: true,
    reason: controlTarget
      ? 'Loop control artifact write'
      : externalTarget
        ? 'Write target is outside the guarded project'
        : 'No guarded write target was provided',
    workflow: 'loop',
    phase: state.phase,
    change: state.name,
  };
}

function isWithin(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function requestTargetsAreControlOnly(
  projectRoot: string,
  loopRoot: string,
  request: LoopHookRequest,
): boolean {
  return (
    request.targets.length > 0 &&
    request.targets.every((targetPath) => {
      const target = path.resolve(projectRoot, targetPath);
      if (!isWithin(projectRoot, target)) return true;
      const relative = path.relative(projectRoot, target).replaceAll('\\', '/');
      return relative === '.owner/config.yaml' || isWithin(loopRoot, target);
    })
  );
}

async function activeLoopContextImpl(projectRoot: string): Promise<ActiveLoopContext | null> {
  const config = await readProjectConfig(projectRoot);
  if (!config || !(config.workflows ?? [config.default_workflow]).includes('loop')) return null;

  const paths = await loopProjectPaths(projectRoot, config.loop.artifact_root);
  let entries;
  try {
    entries = await fs.readdir(paths.changesDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { paths, changes: [] };
    throw error;
  }

  const changes: ActiveLoopContext['changes'] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (await isLoopPortableChange(paths, entry.name)) {
      const state = await readLoopPortableChange(paths, entry.name);
      if (!state.archived) changes.push({ kind: 'portable', state });
    } else {
      const state = await readLoopChange(paths, entry.name);
      if (!state.archived) changes.push({ kind: 'legacy', state });
    }
  }
  return { paths, changes };
}

// `activeLoopContext` is invoked once by `listActiveLoopHookChanges`
// (router) and again by `inspectLoopHookGuard`. Within a single Hook
// decision the changes directory is immutable, so memoize the enumeration to
// avoid a second readdir + per-change state read.
const activeLoopContext = memoizedHookRead('loopActiveContext', (projectRoot: string) =>
  activeLoopContextImpl(projectRoot),
);

export async function listActiveLoopHookChanges(
  projectRoot: string,
): Promise<ActiveLoopHookChange[]> {
  const context = await activeLoopContext(projectRoot);
  return (context?.changes ?? []).map((change) => ({
    workflow: 'loop',
    name: change.state.name,
    phase: change.state.phase,
  }));
}

export function parseLoopHookRequest(source: string): LoopHookRequest {
  const { intent, targets } = parseOwnerHookRequest(source);
  return { intent, targets };
}

export async function readLoopHookRequest(): Promise<LoopHookRequest> {
  const { intent, targets } = await readOwnerHookRequest();
  return { intent, targets };
}

export async function inspectLoopHookGuard(
  projectRoot: string,
  request: LoopHookRequest,
  selectedChangeName?: string,
): Promise<LoopHookGuardResult> {
  const context = await activeLoopContext(projectRoot);
  if (!context) return { allowed: true, reason: 'Loop workflow is not enabled' };
  if (request.intent === 'non-write') {
    return { allowed: true, reason: 'Hook event is not a write' };
  }
  if (context.changes.length === 0) {
    return {
      allowed: true,
      reason: requestTargetsAreControlOnly(projectRoot, context.paths.loopRoot, request)
        ? 'Loop control artifact write'
        : 'No Loop changes exist',
    };
  }

  let change: ActiveLoopContext['changes'][number] | undefined;
  if (selectedChangeName) {
    change = context.changes.find((candidate) => candidate.state.name === selectedChangeName);
    if (!change) {
      return {
        allowed: false,
        reason: `Selected Loop change ${selectedChangeName} is missing or archived; resume /owner-loop before retrying`,
        workflow: 'loop',
        change: selectedChangeName,
      };
    }
  } else if (context.changes.length === 1) {
    change = context.changes[0];
  } else {
    const selectedName = await resolveSelectedLoopChange(context.paths);
    change = context.changes.find((candidate) => candidate.state.name === selectedName);
    if (!change) {
      return {
        allowed: false,
        reason: 'Multiple Loop changes are active; select the change to resume before writing code',
        workflow: 'loop',
      };
    }
  }

  const state = change.state;
  if (change.kind === 'legacy' && state.phase === 'build') {
    return {
      allowed: true,
      reason: 'Loop change is in Build',
      workflow: 'loop',
      phase: state.phase,
      change: state.name,
    };
  }
  if (request.intent === 'unknown' || request.targets.length === 0) {
    return {
      allowed: true,
      reason: 'Hook write target was not attributed to the guarded project',
      workflow: 'loop',
      phase: state.phase,
      change: state.name,
    };
  }
  if (change.kind === 'portable') {
    return inspectPortableWriteTargets({
      projectRoot,
      paths: context.paths,
      state: change.state,
      request,
    });
  }

  let controlTarget = false;
  let externalTarget = false;
  let configuredTarget = false;
  for (const targetPath of request.targets) {
    const target = path.resolve(projectRoot, targetPath);
    if (!isWithin(projectRoot, target)) {
      externalTarget = true;
      continue;
    }
    const relative = path.relative(projectRoot, target).replaceAll('\\', '/');
    if (relative === '.owner/config.yaml') {
      controlTarget = true;
      continue;
    }
    if (isWithin(context.paths.loopRoot, target)) {
      controlTarget = true;
      continue;
    }
    if (
      await configuredHookWritePath(projectRoot, target, [
        path.join(projectRoot, '.owner'),
        context.paths.loopRoot,
      ])
    ) {
      configuredTarget = true;
      continue;
    }
    return {
      allowed: false,
      reason: `Loop change ${state.name} is in ${state.phase}; implementation writes are only allowed in build. If this belongs to the current change, confirm the scope and run owner loop next ${state.name} --summary "<reason>" --return-to-build; otherwise create or select a separate Loop change`,
      workflow: 'loop',
      phase: state.phase,
      change: state.name,
    };
  }

  return {
    allowed: true,
    reason: controlTarget
      ? 'Loop control artifact write'
      : externalTarget
        ? 'Write target is outside the guarded project'
        : configuredTarget
          ? 'Loop configured Hook allow path'
          : 'No guarded write target was provided',
    workflow: 'loop',
    phase: state.phase,
    change: state.name,
  };
}
