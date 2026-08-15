import { promises as fs } from 'fs';
import path from 'path';

import { canonicalSpecPath } from './loop-artifacts.js';
import { readLoopBoundedTextFile } from './loop-bounded-file.js';
import { settleLoopChangeJournalsLocked } from './loop-change-recovery.js';
import { readLoopRunState } from './loop-run-store.js';
import {
  assertLoopName,
  compareAndSwapLoopChangeLocked,
  loopChangeDir,
  readLoopChange,
} from './loop-change.js';
import { sha256File, sha256Text } from './loop-hash.js';
import { withLoopMutationLock } from './loop-mutation-lock.js';
import { captureLoopProtectedDirectoryGuard } from './loop-protected-file.js';
import { redactLoopCredentialText } from './loop-redaction.js';
import { loopChangeRuntimeDir, resolveContainedLoopPath } from './loop-paths.js';
import {
  continueLoopTransitionLocked,
  prepareLoopTransition,
  withLoopTransitionLock,
} from './loop-transition-journal.js';
import { assertLoopTrajectoryText } from './loop-trajectory-limits.js';
import { LOOP_CONTRACT_FILE_LIMITS } from './loop-contract-files.js';
import type { LoopChangeState, LoopProjectPaths, LoopSpecChange } from './loop-types.js';

const MAX_LOOP_PROPOSED_SPEC_DIRECTORY_ENTRIES = LOOP_CONTRACT_FILE_LIMITS.maxSpecs * 4;

async function optionalHash(file: string): Promise<string | null> {
  try {
    return await sha256File(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function proposedCapabilities(paths: LoopProjectPaths, name: string): Promise<string[]> {
  const specsDir = path.join(loopChangeDir(paths, name), 'specs');
  let guard: Awaited<ReturnType<typeof captureLoopProtectedDirectoryGuard>>;
  try {
    guard = await captureLoopProtectedDirectoryGuard({
      root: paths.loopRoot,
      directory: specsDir,
      label: 'Loop proposed specs directory',
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const capabilities: string[] = [];
  let entryCount = 0;
  const directory = await fs.opendir(specsDir);
  try {
    for await (const entry of directory) {
      entryCount += 1;
      if (entryCount > MAX_LOOP_PROPOSED_SPEC_DIRECTORY_ENTRIES) {
        throw new Error(
          `Loop proposed specs directory exceeds ${MAX_LOOP_PROPOSED_SPEC_DIRECTORY_ENTRIES} entries`,
        );
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`Proposed spec capability must not be a symbolic link: ${entry.name}`);
      }
      if (!entry.isDirectory()) continue;
      assertLoopName(entry.name);
      const source = path.join(specsDir, entry.name, 'spec.md');
      await resolveContainedLoopPath(paths.loopRoot, source);
      let stat;
      try {
        stat = await fs.lstat(source);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`Proposed spec must be a regular file: ${entry.name}`);
      }
      capabilities.push(entry.name);
      if (capabilities.length > LOOP_CONTRACT_FILE_LIMITS.maxSpecs) {
        throw new Error('Loop proposed specs exceed the spec-count budget');
      }
    }
  } finally {
    await directory.close().catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ERR_DIR_CLOSED') throw error;
    });
  }
  await guard.verify();
  return capabilities.sort();
}

export async function reconcileLoopSpecChanges(
  paths: LoopProjectPaths,
  state: LoopChangeState,
): Promise<LoopSpecChange[]> {
  const previous = new Map(state.spec_changes.map((change) => [change.capability, change]));
  const proposed = await proposedCapabilities(paths, state.name);
  const changes: LoopSpecChange[] = [];
  for (const capability of proposed) {
    const existing = previous.get(capability);
    if (existing?.operation === 'remove') {
      throw new Error(`Capability ${capability} has both a proposed spec and a remove intent`);
    }
    if (existing) {
      changes.push({
        ...existing,
        source: `specs/${capability}/spec.md`,
      });
      continue;
    }
    const canonical = canonicalSpecPath(paths, capability);
    await resolveContainedLoopPath(paths.loopRoot, canonical);
    const baseHash = await optionalHash(canonical);
    changes.push({
      capability,
      operation: baseHash === null ? 'create' : 'replace',
      source: `specs/${capability}/spec.md`,
      base_hash: baseHash,
    });
  }
  for (const change of state.spec_changes) {
    if (change.operation === 'remove' && !proposed.includes(change.capability)) {
      changes.push(change);
    }
  }
  return changes.sort((left, right) => left.capability.localeCompare(right.capability));
}

async function refreshLoopSpecChanges(
  paths: LoopProjectPaths,
  state: LoopChangeState,
): Promise<LoopSpecChange[]> {
  const proposed = await proposedCapabilities(paths, state.name);
  const changes: LoopSpecChange[] = [];
  for (const capability of proposed) {
    const existing = state.spec_changes.find((change) => change.capability === capability);
    if (existing?.operation === 'remove') {
      throw new Error(`Capability ${capability} has both a proposed spec and a remove intent`);
    }
    const canonical = canonicalSpecPath(paths, capability);
    await resolveContainedLoopPath(paths.loopRoot, canonical);
    const baseHash = await optionalHash(canonical);
    changes.push({
      capability,
      operation: baseHash === null ? 'create' : 'replace',
      source: `specs/${capability}/spec.md`,
      base_hash: baseHash,
    });
  }
  for (const change of state.spec_changes) {
    if (change.operation !== 'remove' || proposed.includes(change.capability)) continue;
    const canonical = canonicalSpecPath(paths, change.capability);
    await resolveContainedLoopPath(paths.loopRoot, canonical);
    const baseHash = await optionalHash(canonical);
    if (baseHash !== null) {
      changes.push({ ...change, base_hash: baseHash });
    }
  }
  return changes.sort((left, right) => left.capability.localeCompare(right.capability));
}

export async function rebaseLoopSpecChanges(options: {
  paths: LoopProjectPaths;
  name: string;
  summary: string;
  now?: Date;
  transitionId?: () => string;
}): Promise<LoopChangeState> {
  assertLoopName(options.name);
  const summary = redactLoopCredentialText(options.summary);
  assertLoopTrajectoryText(summary, 'Spec rebase summary');
  return withLoopMutationLock(options.paths, `rebase specs for ${options.name}`, () =>
    withLoopTransitionLock(
      options.paths,
      options.name,
      `rebase specs for ${options.name}`,
      async () => {
        await settleLoopChangeJournalsLocked(options.paths, options.name);
        const state = await readLoopChange(options.paths, options.name);
        if (state.phase === 'shape') {
          throw new Error('Shape spec metadata is refreshed by the next command');
        }
        if (state.archived) throw new Error(`Loop change ${state.name} is already archived`);
        const runtimeDir = loopChangeRuntimeDir(options.paths, options.name);
        const run = await readLoopRunState(runtimeDir);
        if (!run || run.runId !== state.run_id || run.currentStep !== state.phase || run.pending) {
          throw new Error(`Loop Run state is missing or inconsistent for ${state.name}`);
        }
        const specChanges = await refreshLoopSpecChanges(options.paths, state);
        const nextState: LoopChangeState = {
          ...state,
          revision: state.revision + 1,
          phase: 'build',
          spec_changes: specChanges,
          verification_result: 'pending',
          verification_report: null,
          implementation_scope: null,
          verification_evidence: null,
          partial_allowance: null,
        };
        const nextRun = {
          ...run,
          currentStep: 'build',
          iteration: run.iteration + 1,
          pending: null,
          status: 'running' as const,
        };
        const evidenceHash = sha256Text(
          JSON.stringify({
            operation: 'spec-rebase',
            change: state.name,
            summary,
            specChanges,
          }),
        );
        await prepareLoopTransition({
          paths: options.paths,
          previousState: state,
          nextState,
          previousRun: run,
          nextRun,
          evidenceHash,
          eventData: {
            previousPhase: state.phase,
            nextPhase: 'build',
            evidenceHash,
            summary,
            artifacts: [],
            noCodeReason: null,
            verificationResult: null,
          },
          operation: 'spec-rebase',
          now: options.now,
          transitionId: options.transitionId,
        });
        const rebased = await continueLoopTransitionLocked(options.paths, options.name);
        if (!rebased) throw new Error('Loop spec rebase journal disappeared before completion');
        return rebased;
      },
    ),
  );
}

export async function markLoopSpecRemoval(
  paths: LoopProjectPaths,
  name: string,
  capability: string,
): Promise<LoopChangeState> {
  assertLoopName(name);
  assertLoopName(capability);
  return withLoopMutationLock(paths, `remove spec ${capability} from ${name}`, () =>
    withLoopTransitionLock(paths, name, `remove spec ${capability} from ${name}`, async () => {
      await settleLoopChangeJournalsLocked(paths, name);
      return markLoopSpecRemovalLocked(paths, name, capability);
    }),
  );
}

async function markLoopSpecRemovalLocked(
  paths: LoopProjectPaths,
  name: string,
  capability: string,
): Promise<LoopChangeState> {
  const state = await readLoopChange(paths, name);
  if (state.phase === 'archive' || state.archived) {
    throw new Error(`Loop change ${name} no longer accepts spec changes`);
  }
  const proposed = await proposedCapabilities(paths, name);
  if (proposed.includes(capability)) {
    throw new Error(`Capability ${capability} has both a proposed spec and a remove intent`);
  }
  const previous = state.spec_changes.find((change) => change.capability === capability);
  if (previous?.operation === 'remove') return state;
  const canonical = canonicalSpecPath(paths, capability);
  await resolveContainedLoopPath(paths.loopRoot, canonical);
  const baseHash = await optionalHash(canonical);
  if (baseHash === null) throw new Error(`Canonical spec is missing: ${capability}`);
  const updated = {
    ...state,
    spec_changes: [
      ...state.spec_changes.filter((change) => change.capability !== capability),
      { capability, operation: 'remove' as const, base_hash: baseHash },
    ].sort((left, right) => left.capability.localeCompare(right.capability)),
  };
  await compareAndSwapLoopChangeLocked(paths, updated, state.revision);
  return updated;
}

export async function readLoopProposedSpecs(
  paths: LoopProjectPaths,
  name: string,
): Promise<Record<string, string>> {
  const changeDir = loopChangeDir(paths, name);
  const result: Record<string, string> = {};
  let totalBytes = 0;
  for (const capability of await proposedCapabilities(paths, name)) {
    const source = await readLoopBoundedTextFile({
      root: changeDir,
      ref: `specs/${capability}/spec.md`,
      maxBytes: LOOP_CONTRACT_FILE_LIMITS.maxFileBytes,
    });
    totalBytes += source.size;
    if (totalBytes > LOOP_CONTRACT_FILE_LIMITS.maxTotalBytes) {
      throw new Error('Loop proposed specs exceed the total byte budget');
    }
    result[capability] = source.text;
  }
  return result;
}
