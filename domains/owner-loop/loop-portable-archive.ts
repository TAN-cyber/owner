import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { listGitWorktreeRoots } from '../../platform/paths/git-worktree.js';

import { atomicWriteJson, atomicWriteText } from './loop-atomic-file.js';
import { readLoopBoundedTextFile } from './loop-bounded-file.js';
import { inspectLoopChangeStateDocument } from './loop-change.js';
import { readProjectConfig } from './loop-config.js';
import { withLoopMutationLock } from './loop-mutation-lock.js';
import {
  inspectLoopPortableAcceptanceDrift,
  loopPortableChangeDir,
  loopPortableStateFile,
  readLoopPortableChange,
  returnLoopPortableStateToShapeLocked,
} from './loop-portable-runtime.js';
import { compareAndSwapLoopPortableState, readLoopPortableState } from './loop-portable-state.js';
import {
  LOOP_PORTABLE_ARCHIVE_TRANSACTION_SCHEMA,
  loopPortableTransactionFile,
  readLoopPortableTransaction,
  type LoopPortableArchiveTransaction,
  type LoopPortableArchiveSpecChange,
} from './loop-portable-transactions.js';
import type { LoopPortableState } from './loop-portable-types.js';
import {
  inspectLoopVerificationReportAlignment,
  writeLoopVerificationReport,
} from './loop-verification-report-v2.js';
import { isInsidePath, loopPreferredChangeRuntimeDir, loopProjectPaths } from './loop-paths.js';
import { clearLoopSelectionIfLocked } from './loop-selection.js';
import type { LoopProjectPaths } from './loop-types.js';

export interface LoopPortableArchiveHooks {
  afterSpecApplied?: (index: number) => void | Promise<void>;
  afterFinalState?: () => void | Promise<void>;
  afterReportAligned?: () => void | Promise<void>;
  afterMove?: () => void | Promise<void>;
  afterRuntimeCleanup?: () => void | Promise<void>;
}

export interface LoopPortableArchiveResult {
  change: string;
  archiveDir: string;
  transactionId: string;
  state: LoopPortableState;
}

export class LoopPortableArchiveOrderRequiredError extends Error {
  readonly peers: string[];

  constructor(peers: readonly string[]) {
    super(
      peers.length === 0
        ? 'Loop Archive serial capability decision is stale'
        : `Loop Archive requires a serial capability decision: ${peers.join(', ')}`,
    );
    this.name = 'LoopPortableArchiveOrderRequiredError';
    this.peers = [...peers];
  }
}

function archiveRef(state: LoopPortableState): string {
  const date = (state.verification?.completed_at ?? state.created_at).slice(0, 10);
  return `${date}-${state.name}`;
}

function archiveDirectory(paths: LoopProjectPaths, ref: string): string {
  if (!/^\d{4}-\d{2}-\d{2}-[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(ref)) {
    throw new Error('Loop portable Archive ref is invalid');
  }
  const target = path.join(paths.archiveDir, ref);
  if (!isInsidePath(paths.archiveDir, target)) throw new Error('Loop Archive path escaped');
  return target;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(path.resolve(left));
  const normalizedRight = path.normalize(path.resolve(right));
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function findArchivedPortableChange(
  paths: LoopProjectPaths,
  name: string,
): Promise<{ dir: string; state: LoopPortableState } | null> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(paths.archiveDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const matches: Array<{ dir: string; state: LoopPortableState }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const dir = path.join(paths.archiveDir, entry.name);
    try {
      const state = await readLoopPortableState(path.join(dir, 'owner-state.yaml'));
      if (state.name === name) matches.push({ dir, state });
    } catch {
      // Legacy archives and unrelated invalid entries are handled by their
      // own diagnostics; they cannot authorize a portable recovery.
    }
  }
  if (matches.length > 1) {
    throw new Error(`Multiple Loop portable archives exist for ${name}`);
  }
  return matches[0] ?? null;
}

async function readTransaction(
  paths: LoopProjectPaths,
  name: string,
): Promise<LoopPortableArchiveTransaction | null> {
  const transaction = await readLoopPortableTransaction(paths, { kind: 'archive', change: name });
  return transaction?.kind === 'archive' ? transaction.journal : null;
}

export async function hasLoopPortableArchiveRecovery(
  paths: LoopProjectPaths,
  name: string,
): Promise<boolean> {
  return (
    (await readTransaction(paths, name)) !== null ||
    (await findArchivedPortableChange(paths, name)) !== null
  );
}

async function writeTransaction(
  paths: LoopProjectPaths,
  transaction: LoopPortableArchiveTransaction,
): Promise<void> {
  await fs.mkdir(paths.transactionsDir, { recursive: true });
  await atomicWriteJson(
    loopPortableTransactionFile(paths, { kind: 'archive', change: transaction.change }),
    transaction,
    {
      containedRoot: paths.runtimeDir,
    },
  );
}

async function otherPortableCapabilityOwners(options: {
  paths: LoopProjectPaths;
  state: LoopPortableState;
}): Promise<string[]> {
  const capabilities = new Set(options.state.spec_changes.map(({ capability }) => capability));
  if (capabilities.size === 0) return [];
  const roots = listGitWorktreeRoots(options.paths.projectRoot);
  if (!roots.some((root) => samePath(root, options.paths.projectRoot))) {
    roots.push(options.paths.projectRoot);
  }
  const workspacePaths: LoopProjectPaths[] = [];
  for (const root of roots) {
    const config = await readProjectConfig(root);
    if (!config) continue;
    const sourcePaths = await loopProjectPaths(root, config.loop.artifact_root);
    if (!workspacePaths.some((entry) => samePath(entry.changesDir, sourcePaths.changesDir))) {
      workspacePaths.push(sourcePaths);
    }
  }
  if (workspacePaths.length === 0) workspacePaths.push(options.paths);

  const peers = new Set<string>();
  for (const sourcePaths of workspacePaths) {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(sourcePaths.changesDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === options.state.name) {
        continue;
      }
      try {
        const peer = await readLoopPortableState(
          path.join(sourcePaths.changesDir, entry.name, 'owner-state.yaml'),
        );
        if (
          peer.status !== 'done' &&
          peer.spec_changes.some(({ capability }) => capabilities.has(capability))
        ) {
          peers.add(peer.name);
        }
      } catch {
        const legacy = await inspectLoopChangeStateDocument(sourcePaths, entry.name).catch(
          () => null,
        );
        if (
          legacy?.state &&
          legacy.state.spec_changes.some(({ capability }) => capabilities.has(capability))
        ) {
          peers.add(legacy.state.name);
        }
      }
    }
  }
  return [...peers].sort((left, right) => left.localeCompare(right, 'en'));
}

function normalizeSerialDecision(change: string | undefined): string | null {
  if (change === undefined) return null;
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(change)) {
    throw new Error('Loop Archive serial capability decision is invalid');
  }
  return change;
}

async function applySpecChange(options: {
  paths: LoopProjectPaths;
  state: LoopPortableState;
  change: LoopPortableArchiveSpecChange;
}): Promise<void> {
  const capabilityDirectory = path.join(options.paths.specsDir, options.change.capability);
  const target = path.join(capabilityDirectory, 'spec.md');
  if (!isInsidePath(options.paths.specsDir, target)) {
    throw new Error('Loop canonical spec path escaped');
  }
  if (options.change.operation === 'remove') {
    let specsRootStat: import('node:fs').Stats;
    try {
      specsRootStat = await fs.lstat(options.paths.specsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (!specsRootStat.isDirectory() || specsRootStat.isSymbolicLink()) {
      throw new Error('Loop canonical specs root is unsafe');
    }
    let capabilityStat: import('node:fs').Stats;
    try {
      capabilityStat = await fs.lstat(capabilityDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (!capabilityStat.isDirectory() || capabilityStat.isSymbolicLink()) {
      throw new Error(
        `Canonical Loop capability directory is unsafe: ${options.change.capability}`,
      );
    }
    const [realSpecsRoot, realCapabilityDirectory] = await Promise.all([
      fs.realpath(options.paths.specsDir),
      fs.realpath(capabilityDirectory),
    ]);
    if (!isInsidePath(realSpecsRoot, realCapabilityDirectory)) {
      throw new Error('Loop canonical capability path escaped');
    }
    try {
      const targetStat = await fs.lstat(target);
      if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
        throw new Error(`Canonical Loop spec is unsafe: ${options.change.capability}`);
      }
      await fs.unlink(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await fs.rmdir(capabilityDirectory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error;
    });
    return;
  }
  if (options.change.source === null || options.change.content === null) {
    throw new Error(`Loop ${options.change.operation} spec requires frozen source content`);
  }
  const sourceTarget = path.join(
    loopPortableChangeDir(options.paths, options.state.name),
    options.change.source,
  );
  await atomicWriteText(sourceTarget, options.change.content, {
    containedRoot: options.paths.loopRoot,
  });
  await fs.mkdir(capabilityDirectory, { recursive: true });
  await atomicWriteText(target, options.change.content, {
    containedRoot: options.paths.loopRoot,
  });
}

function assertArchiveReady(state: LoopPortableState): void {
  if (
    state.phase !== 'archive' ||
    state.status !== 'active' ||
    state.loop.stage !== 'archive-ready' ||
    state.verification_result !== 'pass' ||
    state.verification?.verdict !== 'pass' ||
    state.verification_report !== 'verification.md'
  ) {
    throw new Error(`Loop change ${state.name} is not archive-ready`);
  }
}

async function freezeArchiveSpecChanges(
  paths: LoopProjectPaths,
  state: LoopPortableState,
): Promise<LoopPortableArchiveSpecChange[]> {
  const changeRoot = loopPortableChangeDir(paths, state.name);
  const frozen: LoopPortableArchiveSpecChange[] = [];
  for (const change of state.spec_changes) {
    if (change.source === null) {
      frozen.push({ ...change, content: null });
      continue;
    }
    const source = await readLoopBoundedTextFile({
      root: changeRoot,
      ref: change.source,
      maxBytes: null,
      includeHash: false,
    });
    frozen.push({ ...change, content: source.text });
  }
  return frozen;
}

function assertTransactionState(
  transaction: LoopPortableArchiveTransaction,
  state: LoopPortableState,
): void {
  if (state.archived) {
    if (
      state.status !== 'done' ||
      state.loop.stage !== 'done' ||
      state.state_version !== transaction.start_state_version + 1
    ) {
      throw new Error('Loop Archive transaction no longer matches the finalized portable state');
    }
    return;
  }
  if (state.state_version !== transaction.start_state_version) {
    throw new Error('Loop Archive transaction is stale for the current portable state');
  }
  assertArchiveReady(state);
  if (transaction.status !== 'prepared' && transaction.status !== 'specs-applied') {
    throw new Error(
      `Loop Archive transaction ${transaction.status} requires a finalized portable state`,
    );
  }
}

export async function inspectLoopPortableArchive(options: {
  paths: LoopProjectPaths;
  name: string;
}): Promise<{
  ready: boolean;
  blockers: string[];
  capabilityPeers: string[];
  archiveDir: string;
  stateVersion: number;
}> {
  const state = await readLoopPortableChange(options.paths, options.name);
  const blockers: string[] = [];
  try {
    assertArchiveReady(state);
  } catch (error) {
    blockers.push((error as Error).message);
  }
  const transaction = await readTransaction(options.paths, options.name);
  if (transaction === null) {
    try {
      const drift = await inspectLoopPortableAcceptanceDrift({
        paths: options.paths,
        state,
      });
      if (drift.drifted) blockers.push(drift.reason ?? 'Loop confirmed requirements changed');
    } catch (error) {
      blockers.push((error as Error).message);
    }
  }
  const alignment =
    state.verification === null
      ? 'missing'
      : await inspectLoopVerificationReportAlignment({
          file: path.join(loopPortableChangeDir(options.paths, state.name), 'verification.md'),
          stateVersion: state.state_version,
        });
  if (alignment !== 'aligned') blockers.push(`verification.md is ${alignment}`);
  const peers = await otherPortableCapabilityOwners({ paths: options.paths, state });
  if (peers.length > 0) blockers.push(`capabilities are also declared by: ${peers.join(', ')}`);
  return {
    ready: blockers.length === 0,
    blockers,
    capabilityPeers: peers,
    archiveDir: archiveDirectory(options.paths, archiveRef(state)),
    stateVersion: state.state_version,
  };
}

export async function archiveLoopPortableChange(options: {
  paths: LoopProjectPaths;
  name: string;
  serialFirstChange?: string;
  hooks?: LoopPortableArchiveHooks;
}): Promise<LoopPortableArchiveResult> {
  return withLoopMutationLock(
    options.paths,
    `archive portable change ${options.name}`,
    async () => {
      const serialDecision = normalizeSerialDecision(options.serialFirstChange);
      if (serialDecision !== null && serialDecision !== options.name) {
        throw new Error('Loop Archive --serial-first must name the change being archived');
      }
      let transaction = await readTransaction(options.paths, options.name);
      const activeDir = loopPortableChangeDir(options.paths, options.name);
      const activeExists = await exists(activeDir);
      const archived = activeExists
        ? null
        : await findArchivedPortableChange(options.paths, options.name);
      let state: LoopPortableState;
      if (activeExists) {
        state = await readLoopPortableChange(options.paths, options.name);
      } else if (transaction) {
        state = await readLoopPortableState(
          path.join(archiveDirectory(options.paths, transaction.archive_ref), 'owner-state.yaml'),
        );
      } else if (archived) {
        state = archived.state;
      } else {
        throw new Error(`Loop active change is missing: ${options.name}`);
      }
      if (activeExists && !state.archived && transaction === null) {
        const drift = await inspectLoopPortableAcceptanceDrift({
          paths: options.paths,
          state,
        });
        if (drift.drifted) {
          const reason = drift.reason ?? 'Loop confirmed requirements changed';
          await returnLoopPortableStateToShapeLocked({
            paths: options.paths,
            state,
            reason,
          });
          throw new Error(`${reason}; Loop change returned to Shape and requires confirmation`);
        }
      }
      const target = archiveDirectory(options.paths, transaction?.archive_ref ?? archiveRef(state));
      const targetExists = await exists(target);
      if (transaction) assertTransactionState(transaction, state);
      if (activeExists && targetExists) {
        throw new Error(
          'Loop active and archive directories both exist; doctor intervention is required',
        );
      }
      if (!activeExists && !transaction && archived) {
        if (!state.archived || state.status !== 'done' || state.loop.stage !== 'done') {
          throw new Error('Loop archive exists without a completed portable state');
        }
        await clearLoopSelectionIfLocked(options.paths, state.name);
        await fs.rm(loopPreferredChangeRuntimeDir(options.paths, state.name), {
          recursive: true,
          force: true,
        });
        return {
          change: state.name,
          archiveDir: archived.dir,
          transactionId: `recovered-${state.state_version}`,
          state,
        };
      }
      if (!transaction) {
        if (!state.archived) {
          assertArchiveReady(state);
        } else if (state.status !== 'done' || state.loop.stage !== 'done') {
          throw new Error('Loop active archived state is inconsistent');
        }
        const peers = await otherPortableCapabilityOwners({ paths: options.paths, state });
        if (!state.archived && peers.length > 0 && serialDecision !== state.name) {
          throw new LoopPortableArchiveOrderRequiredError(peers);
        }
        transaction = {
          schema: LOOP_PORTABLE_ARCHIVE_TRANSACTION_SCHEMA,
          id: randomUUID(),
          change: state.name,
          start_state_version: state.archived ? state.state_version - 1 : state.state_version,
          archive_ref: archiveRef(state),
          status: state.archived ? 'state-finalized' : 'prepared',
          next_spec_index: state.archived ? state.spec_changes.length : 0,
          spec_changes: await freezeArchiveSpecChanges(options.paths, state),
          created_at: new Date().toISOString(),
        };
        await writeTransaction(options.paths, transaction);
      }

      if (!activeExists && targetExists && transaction.status === 'report-aligned') {
        transaction = { ...transaction, status: 'moved' };
        await writeTransaction(options.paths, transaction);
      } else if (!activeExists && targetExists && transaction.status !== 'moved') {
        throw new Error(
          `Loop Archive layout contradicts transaction state ${transaction.status}; doctor intervention is required`,
        );
      }

      if (transaction.status === 'prepared') {
        for (
          let index = transaction.next_spec_index;
          index < transaction.spec_changes.length;
          index += 1
        ) {
          await applySpecChange({
            paths: options.paths,
            state,
            change: transaction.spec_changes[index],
          });
          transaction = { ...transaction, next_spec_index: index + 1 };
          await writeTransaction(options.paths, transaction);
          await options.hooks?.afterSpecApplied?.(index);
        }
        transaction = { ...transaction, status: 'specs-applied' };
        await writeTransaction(options.paths, transaction);
      }

      if (transaction.status === 'specs-applied') {
        if (!state.archived) {
          const next: LoopPortableState = {
            ...state,
            phase: 'archive',
            status: 'done',
            state_version: state.state_version + 1,
            archived: true,
            blockers: [],
            loop: { ...state.loop, stage: 'done', next_action: null },
          };
          state = await compareAndSwapLoopPortableState({
            file: loopPortableStateFile(options.paths, state.name),
            expectedStateVersion: state.state_version,
            next,
            containedRoot: options.paths.loopRoot,
          });
        }
        transaction = { ...transaction, status: 'state-finalized' };
        await writeTransaction(options.paths, transaction);
        await options.hooks?.afterFinalState?.();
      }

      if (transaction.status === 'state-finalized') {
        const reportRoot = (await exists(activeDir)) ? activeDir : target;
        await writeLoopVerificationReport({
          file: path.join(reportRoot, 'verification.md'),
          state,
        });
        const alignment = await inspectLoopVerificationReportAlignment({
          file: path.join(reportRoot, 'verification.md'),
          stateVersion: state.state_version,
        });
        if (alignment !== 'aligned')
          throw new Error('Loop final verification report is not aligned');
        transaction = { ...transaction, status: 'report-aligned' };
        await writeTransaction(options.paths, transaction);
        await options.hooks?.afterReportAligned?.();
      }

      if (transaction.status === 'report-aligned') {
        await fs.mkdir(options.paths.archiveDir, { recursive: true });
        if (await exists(target)) {
          throw new Error(`Loop Archive target already exists: ${target}`);
        }
        await fs.rename(activeDir, target);
        transaction = { ...transaction, status: 'moved' };
        await writeTransaction(options.paths, transaction);
        await options.hooks?.afterMove?.();
      }

      if (transaction.status === 'moved') {
        await clearLoopSelectionIfLocked(options.paths, state.name);
        await fs.rm(loopPreferredChangeRuntimeDir(options.paths, state.name), {
          recursive: true,
          force: true,
        });
        await options.hooks?.afterRuntimeCleanup?.();
        await fs.rm(
          loopPortableTransactionFile(options.paths, {
            kind: 'archive',
            change: state.name,
          }),
          { force: true },
        );
      }

      return {
        change: state.name,
        archiveDir: target,
        transactionId: transaction.id,
        state,
      };
    },
    { allowedPortableTransaction: { kind: 'archive', change: options.name } },
  );
}
