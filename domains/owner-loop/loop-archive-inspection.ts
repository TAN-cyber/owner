import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  buildLoopArchivePreflight,
  type LoopArchivePreflight,
  type LoopArchiveSpecFact,
} from './loop-archive-preflight.js';
import { readLoopBoundedTextFile } from './loop-bounded-file.js';
import { inspectLoopChangeConflicts } from './loop-conflict-inspection.js';
import {
  hasPendingLoopCheckpointRecovery,
  hasPendingLoopSchemaMigration,
  loopChangeDir,
  readLoopChange,
} from './loop-change.js';
import { readProjectConfig } from './loop-config.js';
import { canonicalSpecPath } from './loop-artifacts.js';
import { isInsidePath } from './loop-paths.js';
import { loopTransitionJournalFile } from './loop-transition-journal.js';
import type { LoopProjectPaths, LoopSpecChange } from './loop-types.js';
import { inspectLoopVerificationFreshness } from './loop-verification-runtime.js';
import { readLoopWorkspaceIdentity } from './loop-workspace.js';

function archiveTargetRef(name: string, now: Date): string {
  return `archive/${now.toISOString().slice(0, 10)}-${name}`;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function optionalBoundedHash(root: string, ref: string): Promise<string | null> {
  try {
    return (await readLoopBoundedTextFile({ root, ref })).hash;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function specFact(
  paths: LoopProjectPaths,
  name: string,
  change: LoopSpecChange,
): Promise<LoopArchiveSpecFact> {
  const canonical = canonicalSpecPath(paths, change.capability);
  if (!isInsidePath(paths.loopRoot, canonical)) {
    throw new Error(`Loop canonical spec escapes its root: ${change.capability}`);
  }
  const canonicalRef = path.relative(paths.loopRoot, canonical).replaceAll('\\', '/');
  const actualBaseHash = await optionalBoundedHash(paths.loopRoot, canonicalRef);
  let proposedHash: string | null = null;
  if (change.operation !== 'remove') {
    if (!change.source) throw new Error(`Loop proposed spec is missing: ${change.capability}`);
    proposedHash = (
      await readLoopBoundedTextFile({
        root: loopChangeDir(paths, name),
        ref: change.source,
      })
    ).hash;
  }
  return {
    capability: change.capability,
    operation: change.operation,
    expectedBaseHash: change.operation === 'create' ? null : change.base_hash,
    actualBaseHash,
    proposedHash,
  };
}

async function hasPendingTransition(paths: LoopProjectPaths, name: string): Promise<boolean> {
  return exists(loopTransitionJournalFile(paths, name));
}

/** Collect the single read-only Archive view reused by CLI, commit, and status. */
export async function inspectLoopArchivePreflight(options: {
  paths: LoopProjectPaths;
  name: string;
  now?: Date;
}): Promise<LoopArchivePreflight> {
  const now = options.now ?? new Date();
  const state = await readLoopChange(options.paths, options.name);
  const workspace = await readLoopWorkspaceIdentity(options.paths, options.name);
  const config = await readProjectConfig(options.paths.projectRoot);
  const targetRef = archiveTargetRef(state.name, now);
  const target = path.resolve(options.paths.loopRoot, ...targetRef.split('/'));
  if (!isInsidePath(options.paths.loopRoot, target)) {
    throw new Error('Loop archive target escapes its root');
  }
  const [
    specs,
    evidence,
    conflicts,
    pendingSchema,
    pendingCheckpoint,
    pendingTransition,
    targetExists,
  ] = await Promise.all([
    Promise.all(state.spec_changes.map((change) => specFact(options.paths, state.name, change))),
    inspectLoopVerificationFreshness({ paths: options.paths, state, now }),
    inspectLoopChangeConflicts(options.paths, state.name),
    hasPendingLoopSchemaMigration(options.paths, state.name),
    hasPendingLoopCheckpointRecovery(options.paths, state.name),
    hasPendingTransition(options.paths, state.name),
    exists(target),
  ]);
  return buildLoopArchivePreflight({
    change: state.name,
    archiveConfirmation: config?.loop.archive_confirmation ?? 'automatic',
    stateSchema: state.schema,
    revision: state.revision,
    phase: state.phase,
    archived: state.archived,
    pendingJournal: pendingSchema || pendingCheckpoint || pendingTransition,
    targetRef,
    targetExists,
    specs,
    evidence: evidence.evidence,
    workspace:
      workspace?.schema === 'owner.loop.workspace.v3'
        ? {
            schema: workspace.schema,
            isolation: workspace.isolation,
            changeBranch: workspace.changeBranch,
            targetBranch: workspace.targetBranch,
            finish: workspace.finish,
          }
        : null,
    findingCodes: [...evidence.findingCodes, ...conflicts.findingCodes],
  });
}
