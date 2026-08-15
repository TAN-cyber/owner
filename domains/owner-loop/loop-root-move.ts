import { createHash, randomUUID } from 'crypto';
import { promises as fs, type Dirent } from 'fs';
import path from 'path';

import { atomicWriteText } from './loop-atomic-file.js';
import { defaultProjectConfig, readProjectConfig, writeProjectConfig } from './loop-config.js';
import { acquireLoopLock, releaseLoopLock } from './loop-lock.js';
import { isInsidePath, loopProjectPaths, normalizeArtifactRootRef } from './loop-paths.js';
import {
  copyLoopProtectedFile,
  ensureLoopProtectedDirectory,
  quarantineLoopProtectedDirectory,
  readLoopProtectedDirectory,
  readLoopProtectedFile,
  removeLoopProtectedEmptyDirectory,
  removeLoopProtectedFile,
} from './loop-protected-file.js';
import {
  createLoopTransaction,
  finalizeLoopTransaction,
  loopTransactionPaths,
  readLoopTransaction,
  rollbackLoopTransaction,
} from './loop-transaction.js';
import {
  inspectLoopWorkspaceAdvisory,
  inspectLoopWorkspaceBinding,
  readLoopWorkspaceIdentity,
  writeLoopWorkspaceIdentity,
} from './loop-workspace.js';
import type {
  OwnerProjectConfig,
  LoopPendingRootMove,
  LoopProjectPaths,
  LoopRootMoveCleanup,
  LoopRootMoveCleanupKind,
  LoopTransactionHooks,
  LoopTransactionJournal,
} from './loop-types.js';

interface TreeDirectory {
  ref: string;
  type: 'directory';
}

interface TreeFile {
  ref: string;
  type: 'file';
  size: number;
  hash: string;
}

type TreeEntry = TreeDirectory | TreeFile;

interface RootMoveCleanupManifest {
  schema: 'owner.loop.root-move-cleanup.v1';
  transactionId: string;
  kind: LoopRootMoveCleanupKind;
  entries: TreeEntry[];
}

const LOOP_ROOT_MOVE_MAX_FILE_BYTES = 64 * 1024 * 1024;
const LOOP_ROOT_MOVE_MAX_JOURNAL_BYTES = 256 * 1024;
const LOOP_ROOT_MOVE_MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function assertNoUnfinishedTransactions(paths: LoopProjectPaths): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(paths.transactionsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    let journal: LoopTransactionJournal;
    try {
      journal = await readLoopTransaction(paths, entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Loop transaction ${entry.name} has no journal; run doctor before moving`, {
          cause: error,
        });
      }
      throw error;
    }
    if (journal.status !== 'committed' && journal.status !== 'rolled-back') {
      throw new Error(`Loop transaction ${journal.id} is unfinished; recover it before moving`);
    }
  }
}

async function assertNoOtherLocks(paths: LoopProjectPaths, ownedLock: string): Promise<void> {
  for (const entry of await fs.readdir(paths.locksDir, { withFileTypes: true })) {
    const file = path.join(paths.locksDir, entry.name);
    if (path.resolve(file) === path.resolve(ownedLock)) continue;
    if (entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Loop lock must be diagnosed before moving the root: ${file}`);
    }
  }
}

async function refreshLoopWorkspaceIdentities(paths: LoopProjectPaths): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(paths.changesDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const previousWorkspace = await readLoopWorkspaceIdentity(paths, entry.name);
    if (previousWorkspace) {
      await writeLoopWorkspaceIdentity({
        paths,
        name: entry.name,
        revision: previousWorkspace.capturedRevision,
        ...(previousWorkspace.schema === 'owner.loop.workspace.v3'
          ? {
              binding: {
                isolation: previousWorkspace.isolation,
                changeBranch: previousWorkspace.changeBranch,
                targetBranch: previousWorkspace.targetBranch,
              },
              ...(previousWorkspace.finish ? { finish: previousWorkspace.finish } : {}),
            }
          : {}),
      });
      continue;
    }
    // A document-root move must not materialize missing machine state. The next explicit
    // continuation rebuilds Runtime when this worktree has no local identity yet.
  }
}

async function validateLoopWorkspaceIdentitiesForRootMove(paths: LoopProjectPaths): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(paths.changesDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    try {
      const identity = await readLoopWorkspaceIdentity(paths, entry.name);
      if (identity?.schema === 'owner.loop.workspace.v3') {
        const binding = await inspectLoopWorkspaceBinding({ paths, identity });
        if (binding.state !== 'aligned') {
          throw new Error(binding.message ?? 'workspace binding is not aligned');
        }
      } else if (identity) {
        const advisory = await inspectLoopWorkspaceAdvisory({ paths, identity });
        if (advisory.state !== 'aligned') {
          throw new Error(`legacy workspace ownership is ${advisory.state}`);
        }
      }
    } catch (error) {
      throw new Error(
        `Loop workspace identity for ${entry.name} must be aligned and repaired before moving the root`,
        { cause: error },
      );
    }
  }
}

async function walkTree(
  root: string,
  options: { rejectSymlinks: boolean; excludedFiles?: ReadonlySet<string> },
): Promise<TreeEntry[]> {
  const treeEntries: TreeEntry[] = [];
  async function visit(directory: string): Promise<void> {
    const protectedDirectory = await readLoopProtectedDirectory({
      root,
      directory,
      label: 'Loop root tree',
    });
    const entries: Dirent[] = protectedDirectory.entries;
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      await protectedDirectory.verify();
      const target = path.join(directory, entry.name);
      if (options.excludedFiles?.has(path.resolve(target))) {
        await protectedDirectory.verify();
        continue;
      }
      const stat = await fs.lstat(target);
      if (entry.isSymbolicLink() || stat.isSymbolicLink()) {
        if (options.rejectSymlinks) throw new Error(`Loop root contains a symlink: ${target}`);
        await protectedDirectory.verify();
        continue;
      }
      if (entry.isDirectory() && stat.isDirectory()) {
        treeEntries.push({
          ref: path.relative(root, target).split(path.sep).join('/'),
          type: 'directory',
        });
        await visit(target);
      } else if (entry.isFile() && stat.isFile()) {
        const snapshot = await readLoopProtectedFile({
          root,
          file: target,
          maxBytes: LOOP_ROOT_MOVE_MAX_FILE_BYTES,
          label: `Loop root file ${path.relative(root, target)}`,
        });
        treeEntries.push({
          ref: path.relative(root, target).split(path.sep).join('/'),
          type: 'file',
          size: snapshot.size,
          hash: snapshot.hash,
        });
      } else {
        throw new Error(`Loop root contains an unsupported file type: ${target}`);
      }
      await protectedDirectory.verify();
    }
  }
  await visit(root);
  return treeEntries.sort((left, right) => left.ref.localeCompare(right.ref));
}

async function copyTree(
  source: string,
  target: string,
  excludedFile: string,
  targetRoot: string,
): Promise<void> {
  await ensureLoopProtectedDirectory({
    root: targetRoot,
    directory: target,
    label: 'Loop root move staging directory',
  });
  async function copyDirectory(from: string, to: string): Promise<void> {
    const protectedDirectory = await readLoopProtectedDirectory({
      root: source,
      directory: from,
      label: 'Loop root move source directory',
    });
    const entries = protectedDirectory.entries;
    for (const entry of entries) {
      await protectedDirectory.verify();
      const sourceEntry = path.join(from, entry.name);
      if (path.resolve(sourceEntry) === path.resolve(excludedFile)) {
        await protectedDirectory.verify();
        continue;
      }
      const stat = await fs.lstat(sourceEntry);
      if (entry.isSymbolicLink() || stat.isSymbolicLink()) {
        throw new Error(`Loop root contains a symlink: ${sourceEntry}`);
      }
      const targetEntry = path.join(to, entry.name);
      if (entry.isDirectory() && stat.isDirectory()) {
        await ensureLoopProtectedDirectory({
          root: targetRoot,
          directory: targetEntry,
          label: 'Loop root move staging directory',
        });
        await copyDirectory(sourceEntry, targetEntry);
      } else if (entry.isFile() && stat.isFile()) {
        await copyLoopProtectedFile({
          sourceRoot: source,
          source: sourceEntry,
          targetRoot,
          target: targetEntry,
          maxBytes: LOOP_ROOT_MOVE_MAX_FILE_BYTES,
          label: `Loop root move file ${path.relative(source, sourceEntry)}`,
          exclusive: true,
          expectedTargetHash: null,
        });
      } else {
        throw new Error(`Loop root contains an unsupported file type: ${sourceEntry}`);
      }
      await protectedDirectory.verify();
    }
  }
  await copyDirectory(source, target);
}

async function assertEquivalentTrees(
  source: string,
  target: string,
  excludedSourceLock?: string,
  excludedTargetLock?: string,
): Promise<void> {
  const sourceFiles = await walkTree(source, {
    rejectSymlinks: true,
    excludedFiles: excludedSourceLock ? new Set([path.resolve(excludedSourceLock)]) : undefined,
  });
  const targetFiles = await walkTree(target, {
    rejectSymlinks: true,
    excludedFiles: excludedTargetLock ? new Set([path.resolve(excludedTargetLock)]) : undefined,
  });
  if (JSON.stringify(sourceFiles) !== JSON.stringify(targetFiles)) {
    throw new Error(
      `Loop root copies differ; preserve both trees for manual recovery: ${source} and ${target}`,
    );
  }
}

function stagingDirectory(targetPaths: LoopProjectPaths, id: string): string {
  return path.join(targetPaths.artifactRoot, `.owner-loop-move-${id}`);
}

function sourceRemovalDirectory(sourcePaths: LoopProjectPaths, id: string): string {
  return path.join(sourcePaths.artifactRoot, `.owner-loop-source-${id}.removing`);
}

function stagingRemovalDirectory(staging: string): string {
  return `${staging}.removing`;
}

function rollbackRemovalDirectory(target: string, id: string): string {
  return path.join(path.dirname(target), `.${path.basename(target)}.${id}.rollback-removing`);
}

function cleanupManifestFile(
  paths: LoopProjectPaths,
  id: string,
  kind: LoopRootMoveCleanupKind,
): string {
  return path.join(loopTransactionPaths(paths, id).directory, `root-move-cleanup-${kind}.json`);
}

function cleanupManifestSource(manifest: RootMoveCleanupManifest): string {
  return JSON.stringify(manifest, null, 2) + '\n';
}

function cleanupManifestHash(source: string | Buffer): string {
  return createHash('sha256').update(source).digest('hex');
}

function parseCleanupManifestEntry(value: unknown, index: number): TreeEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Loop root-move cleanup manifest entry ${index} must be an object`);
  }
  const entry = value as Record<string, unknown>;
  const keys = Object.keys(entry).sort();
  const expectedKeys = entry.type === 'file' ? ['hash', 'ref', 'size', 'type'] : ['ref', 'type'];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`Loop root-move cleanup manifest entry ${index} has invalid fields`);
  }
  if (
    typeof entry.ref !== 'string' ||
    entry.ref.length === 0 ||
    entry.ref.includes('\\') ||
    path.posix.normalize(entry.ref) !== entry.ref ||
    entry.ref.startsWith('/') ||
    entry.ref.split('/').includes('..') ||
    Buffer.byteLength(entry.ref, 'utf8') > 4096
  ) {
    throw new Error(`Loop root-move cleanup manifest entry ${index} has an invalid ref`);
  }
  if (entry.type === 'directory') return { ref: entry.ref, type: 'directory' };
  if (
    entry.type !== 'file' ||
    typeof entry.size !== 'number' ||
    !Number.isSafeInteger(entry.size) ||
    entry.size < 0 ||
    typeof entry.hash !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(entry.hash)
  ) {
    throw new Error(`Loop root-move cleanup manifest entry ${index} is invalid`);
  }
  return { ref: entry.ref, type: 'file', size: entry.size, hash: entry.hash };
}

function parseCleanupManifest(
  value: unknown,
  id: string,
  kind: LoopRootMoveCleanupKind,
): RootMoveCleanupManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Loop root-move cleanup manifest must be an object');
  }
  const manifest = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(manifest).sort()) !==
      JSON.stringify(['entries', 'kind', 'schema', 'transactionId']) ||
    manifest.schema !== 'owner.loop.root-move-cleanup.v1' ||
    manifest.transactionId !== id ||
    manifest.kind !== kind ||
    !Array.isArray(manifest.entries)
  ) {
    throw new Error('Loop root-move cleanup manifest binding is invalid');
  }
  const entries = manifest.entries.map(parseCleanupManifestEntry);
  for (let index = 0; index < entries.length; index += 1) {
    if (index > 0 && entries[index - 1].ref.localeCompare(entries[index].ref) >= 0) {
      throw new Error('Loop root-move cleanup manifest refs must be unique and sorted');
    }
    const parent = path.posix.dirname(entries[index].ref);
    if (
      parent !== '.' &&
      !entries.some((candidate) => candidate.ref === parent && candidate.type === 'directory')
    ) {
      throw new Error(`Loop root-move cleanup manifest parent is missing: ${parent}`);
    }
  }
  return {
    schema: 'owner.loop.root-move-cleanup.v1',
    transactionId: id,
    kind,
    entries,
  };
}

async function writeCleanupManifest(options: {
  paths: LoopProjectPaths;
  id: string;
  kind: LoopRootMoveCleanupKind;
  entries: TreeEntry[];
}): Promise<string> {
  const manifest: RootMoveCleanupManifest = {
    schema: 'owner.loop.root-move-cleanup.v1',
    transactionId: options.id,
    kind: options.kind,
    entries: options.entries,
  };
  const source = cleanupManifestSource(manifest);
  if (Buffer.byteLength(source, 'utf8') > LOOP_ROOT_MOVE_MAX_MANIFEST_BYTES) {
    throw new Error('Loop root-move cleanup manifest exceeds its byte budget');
  }
  await atomicWriteText(cleanupManifestFile(options.paths, options.id, options.kind), source, {
    containedRoot: options.paths.runtimeDir,
  });
  return cleanupManifestHash(source);
}

async function readCleanupManifest(options: {
  paths: LoopProjectPaths;
  id: string;
  cleanup: LoopRootMoveCleanup;
}): Promise<RootMoveCleanupManifest> {
  const snapshot = await readLoopProtectedFile({
    root: options.paths.runtimeDir,
    file: cleanupManifestFile(options.paths, options.id, options.cleanup.kind),
    maxBytes: LOOP_ROOT_MOVE_MAX_MANIFEST_BYTES,
    label: `Loop root-move cleanup manifest ${options.cleanup.kind}`,
  });
  if (snapshot.hash !== options.cleanup.manifestHash) {
    throw new Error('Loop root-move cleanup manifest hash changed');
  }
  return parseCleanupManifest(
    JSON.parse(snapshot.bytes.toString('utf8')) as unknown,
    options.id,
    options.cleanup.kind,
  );
}

async function assertCleanupManifestMatch(options: {
  quarantine: string;
  manifest: RootMoveCleanupManifest;
  exact: boolean;
}): Promise<TreeEntry[]> {
  const current = await walkTree(options.quarantine, { rejectSymlinks: true });
  const expected = new Map(options.manifest.entries.map((entry) => [entry.ref, entry]));
  for (const entry of current) {
    const bound = expected.get(entry.ref);
    if (!bound || JSON.stringify(bound) !== JSON.stringify(entry)) {
      throw new Error(
        `Loop root-move cleanup quarantine differs from its bound manifest: ${entry.ref}`,
      );
    }
  }
  if (options.exact && current.length !== options.manifest.entries.length) {
    throw new Error('Loop root-move cleanup quarantine is incomplete before deletion');
  }
  return current;
}

function treeEntryDepth(entry: TreeEntry): number {
  return entry.ref.split('/').length;
}

async function deleteCleanupManifestSubset(options: {
  projectRoot: string;
  quarantine: string;
  manifest: RootMoveCleanupManifest;
  hooks?: LoopTransactionHooks;
}): Promise<void> {
  const current = await assertCleanupManifestMatch({
    quarantine: options.quarantine,
    manifest: options.manifest,
    exact: false,
  });
  const ordered = [...current].sort(
    (left, right) =>
      treeEntryDepth(right) - treeEntryDepth(left) ||
      (left.type === right.type
        ? right.ref.localeCompare(left.ref)
        : left.type === 'file'
          ? -1
          : 1),
  );
  let removedCount = 0;
  for (const entry of ordered) {
    const target = path.join(options.quarantine, ...entry.ref.split('/'));
    if (entry.type === 'file') {
      await removeLoopProtectedFile({
        root: options.projectRoot,
        file: target,
        maxBytes: LOOP_ROOT_MOVE_MAX_FILE_BYTES,
        expectedHash: entry.hash,
        expectedSize: entry.size,
        label: `Loop root-move cleanup file ${entry.ref}`,
      });
    } else {
      await removeLoopProtectedEmptyDirectory({
        root: options.projectRoot,
        directory: target,
        label: `Loop root-move cleanup directory ${entry.ref}`,
      });
    }
    removedCount += 1;
    await options.hooks?.afterRootMoveCleanupEntryRemoved?.(
      options.manifest.kind,
      entry.ref,
      removedCount,
    );
  }
  await assertCleanupManifestMatch({
    quarantine: options.quarantine,
    manifest: options.manifest,
    exact: false,
  });
  await removeLoopProtectedEmptyDirectory({
    root: options.projectRoot,
    directory: options.quarantine,
    label: `Loop root-move cleanup quarantine ${options.manifest.kind}`,
  });
}

function pendingConfig(
  config: OwnerProjectConfig,
  pending: LoopPendingRootMove,
  activeArtifactRoot = config.loop.artifact_root,
): OwnerProjectConfig {
  return {
    ...config,
    loop: { ...config.loop, artifact_root: activeArtifactRoot, pending_root_move: pending },
  };
}

function rootMoveJournal(options: {
  id: string;
  paths: LoopProjectPaths;
  now: Date;
}): LoopTransactionJournal {
  return {
    schema: 'owner.loop.transaction.v1',
    id: options.id,
    kind: 'root-move',
    status: 'prepared',
    projectRoot: options.paths.projectRoot,
    loopRoot: options.paths.loopRoot,
    createdAt: options.now.toISOString(),
    operations: [],
  };
}

async function readRootMoveJournal(
  sourcePaths: LoopProjectPaths,
  destinationPaths: LoopProjectPaths,
  stage: string,
  id: string,
): Promise<{ journal: LoopTransactionJournal; paths: LoopProjectPaths }> {
  for (const paths of [sourcePaths, destinationPaths]) {
    try {
      const journal = await readLoopTransaction(paths, id);
      if (journal.kind !== 'root-move') throw new Error(`Transaction ${id} is not a root move`);
      return { journal, paths };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const stageJournal = path.join(stage, 'runtime', 'transactions', id, 'transaction.json');
  try {
    const snapshot = await readLoopProtectedFile({
      root: stage,
      file: stageJournal,
      maxBytes: LOOP_ROOT_MOVE_MAX_JOURNAL_BYTES,
      label: `Staged Loop root-move journal ${id}`,
    });
    const journal = JSON.parse(snapshot.bytes.toString('utf8')) as LoopTransactionJournal;
    if (journal.schema !== 'owner.loop.transaction.v1' || journal.kind !== 'root-move') {
      throw new Error(`Invalid staged root-move journal: ${id}`);
    }
    return { journal, paths: destinationPaths };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    throw new Error(`Loop root-move journal is missing: ${id}`, { cause: error });
  }
}

async function setPendingStage(options: {
  projectRoot: string;
  config: OwnerProjectConfig;
  pending: LoopPendingRootMove;
  stage: LoopPendingRootMove['stage'];
  activeArtifactRoot?: string;
}): Promise<OwnerProjectConfig> {
  const updated = pendingConfig(
    options.config,
    { ...options.pending, stage: options.stage },
    options.activeArtifactRoot,
  );
  await writeProjectConfig(options.projectRoot, updated);
  return updated;
}

async function setPendingCleanup(options: {
  projectRoot: string;
  config: OwnerProjectConfig;
  id: string;
  cleanup?: LoopRootMoveCleanup;
}): Promise<OwnerProjectConfig> {
  const pending = options.config.loop.pending_root_move;
  if (!pending || pending.id !== options.id) {
    throw new Error(`Loop root-move cleanup ${options.id} lost its pending configuration`);
  }
  const updated = pendingConfig(
    options.config,
    {
      id: pending.id,
      fromArtifactRoot: pending.fromArtifactRoot,
      toArtifactRoot: pending.toArtifactRoot,
      stage: pending.stage,
      ...(options.cleanup ? { cleanup: options.cleanup } : {}),
    },
    options.config.loop.artifact_root,
  );
  await writeProjectConfig(options.projectRoot, updated);
  return updated;
}

async function cleanupRootMoveTree(options: {
  projectRoot: string;
  config: OwnerProjectConfig;
  id: string;
  kind: LoopRootMoveCleanupKind;
  stablePaths: LoopProjectPaths;
  target: string;
  quarantine: string;
  label: string;
  beforeQuarantine?: () => void | Promise<void>;
  afterQuarantine?: (quarantine: string) => void | Promise<void>;
  hooks?: LoopTransactionHooks;
}): Promise<OwnerProjectConfig> {
  let config = options.config;
  const pending = config.loop.pending_root_move;
  if (!pending || pending.id !== options.id) {
    throw new Error(`Loop root-move cleanup ${options.id} lost its pending configuration`);
  }
  let cleanup = pending.cleanup;
  if (cleanup && cleanup.kind !== options.kind) {
    throw new Error(
      `Loop root move has unfinished ${cleanup.kind} cleanup; cannot start ${options.kind}`,
    );
  }

  let targetExists = await exists(options.target);
  let quarantineExists = await exists(options.quarantine);
  if (targetExists && quarantineExists) {
    throw new Error(`Loop root-move cleanup target and quarantine both exist: ${options.kind}`);
  }
  if (!cleanup) {
    if (!targetExists && !quarantineExists) return config;
    if (!targetExists && quarantineExists) {
      throw new Error(
        `Loop root-move cleanup quarantine is not transaction-bound: ${options.kind}`,
      );
    }
    const manifestHash = await writeCleanupManifest({
      paths: options.stablePaths,
      id: options.id,
      kind: options.kind,
      entries: await walkTree(options.target, { rejectSymlinks: true }),
    });
    cleanup = { kind: options.kind, state: 'prepared', manifestHash };
    config = await setPendingCleanup({
      projectRoot: options.projectRoot,
      config,
      id: options.id,
      cleanup,
    });
  }

  const manifest = await readCleanupManifest({
    paths: options.stablePaths,
    id: options.id,
    cleanup,
  });
  targetExists = await exists(options.target);
  quarantineExists = await exists(options.quarantine);
  if (targetExists && quarantineExists) {
    throw new Error(`Loop root-move cleanup target and quarantine both exist: ${options.kind}`);
  }
  if (targetExists) {
    if (cleanup.state !== 'prepared') {
      throw new Error(`Loop root-move cleanup target reappeared after quarantine: ${options.kind}`);
    }
    await quarantineLoopProtectedDirectory({
      root: options.projectRoot,
      directory: options.target,
      quarantine: options.quarantine,
      label: options.label,
      beforeQuarantine: options.beforeQuarantine,
      afterQuarantine: options.afterQuarantine,
    });
    quarantineExists = true;
  }

  if (!quarantineExists) {
    if (cleanup.state !== 'deleting') {
      throw new Error(`Loop root-move cleanup quarantine disappeared: ${options.kind}`);
    }
    return setPendingCleanup({
      projectRoot: options.projectRoot,
      config,
      id: options.id,
    });
  }

  await assertCleanupManifestMatch({
    quarantine: options.quarantine,
    manifest,
    exact: cleanup.state !== 'deleting',
  });
  if (cleanup.state === 'prepared') {
    cleanup = { ...cleanup, state: 'quarantined' };
    config = await setPendingCleanup({
      projectRoot: options.projectRoot,
      config,
      id: options.id,
      cleanup,
    });
  }
  if (cleanup.state === 'quarantined') {
    cleanup = { ...cleanup, state: 'deleting' };
    config = await setPendingCleanup({
      projectRoot: options.projectRoot,
      config,
      id: options.id,
      cleanup,
    });
  }
  await deleteCleanupManifestSubset({
    projectRoot: options.projectRoot,
    quarantine: options.quarantine,
    manifest,
    hooks: options.hooks,
  });
  return setPendingCleanup({
    projectRoot: options.projectRoot,
    config,
    id: options.id,
  });
}

async function finishForwardMove(options: {
  projectRoot: string;
  config: OwnerProjectConfig;
  pending: LoopPendingRootMove;
  sourcePaths: LoopProjectPaths;
  destinationPaths: LoopProjectPaths;
  staging: string;
  journal: LoopTransactionJournal;
  lockFile: string;
  hooks?: LoopTransactionHooks;
}): Promise<OwnerProjectConfig> {
  let config = options.config;
  let stage = config.loop.pending_root_move!.stage;
  if (stage === 'copying') {
    if (!(await exists(options.sourcePaths.loopRoot))) {
      throw new Error(`Loop source root is missing: ${options.sourcePaths.loopRoot}`);
    }
    const stagingRemoval = stagingRemovalDirectory(options.staging);
    config = await cleanupRootMoveTree({
      projectRoot: options.projectRoot,
      config,
      id: options.pending.id,
      kind: 'restart-staging',
      stablePaths: options.sourcePaths,
      target: options.staging,
      quarantine: stagingRemoval,
      label: 'Loop root move stale staging removal',
      hooks: options.hooks,
    });
    await walkTree(options.sourcePaths.loopRoot, {
      rejectSymlinks: true,
      excludedFiles: new Set([path.resolve(options.lockFile)]),
    });
    await copyTree(
      options.sourcePaths.loopRoot,
      options.staging,
      options.lockFile,
      options.destinationPaths.projectRoot,
    );
    await assertEquivalentTrees(options.sourcePaths.loopRoot, options.staging, options.lockFile);
    config = await setPendingStage({
      projectRoot: options.projectRoot,
      config,
      pending: options.pending,
      stage: 'ready',
    });
    stage = 'ready';
    await options.hooks?.afterRootMoveStage?.('ready', options.journal);
  }
  if (stage === 'ready') {
    if (await exists(options.destinationPaths.loopRoot)) {
      if (await exists(options.staging)) {
        throw new Error(`Loop destination is occupied: ${options.destinationPaths.loopRoot}`);
      }
      await assertEquivalentTrees(
        options.sourcePaths.loopRoot,
        options.destinationPaths.loopRoot,
        options.lockFile,
      );
    } else {
      if (!(await exists(options.staging))) throw new Error(`Loop move staging tree is missing`);
      await assertEquivalentTrees(options.sourcePaths.loopRoot, options.staging, options.lockFile);
      await fs.rename(options.staging, options.destinationPaths.loopRoot);
    }
    config = await setPendingStage({
      projectRoot: options.projectRoot,
      config,
      pending: options.pending,
      stage: 'switched',
      activeArtifactRoot: options.pending.toArtifactRoot,
    });
    stage = 'switched';
    await options.hooks?.afterRootMoveStage?.('switched', options.journal);
  }
  if (stage !== 'switched') throw new Error(`Unsupported Loop root-move stage: ${stage}`);
  if (!(await exists(options.destinationPaths.loopRoot))) {
    throw new Error(`Loop destination root is missing: ${options.destinationPaths.loopRoot}`);
  }
  const sourceRemoval = sourceRemovalDirectory(options.sourcePaths, options.pending.id);
  if (!config.loop.pending_root_move?.cleanup && (await exists(options.sourcePaths.loopRoot))) {
    await assertEquivalentTrees(
      options.sourcePaths.loopRoot,
      options.destinationPaths.loopRoot,
      options.lockFile,
    );
  }
  config = await cleanupRootMoveTree({
    projectRoot: options.projectRoot,
    config,
    id: options.pending.id,
    kind: 'forward-source',
    stablePaths: options.destinationPaths,
    target: options.sourcePaths.loopRoot,
    quarantine: sourceRemoval,
    label: 'Loop root move source removal',
    beforeQuarantine: () =>
      options.hooks?.beforeRootMoveSourceRemove?.(options.sourcePaths.loopRoot),
    afterQuarantine: (quarantine) => options.hooks?.afterRootMoveSourceQuarantined?.(quarantine),
    hooks: options.hooks,
  });
  await refreshLoopWorkspaceIdentities(options.destinationPaths);
  const destinationJournal = await readLoopTransaction(
    options.destinationPaths,
    options.pending.id,
  );
  await finalizeLoopTransaction(options.destinationPaths, destinationJournal, 'commit');
  const stableLoop = {
    artifact_root: config.loop.artifact_root,
    language: config.loop.language,
    clarification_mode: config.loop.clarification_mode,
    archive_confirmation: config.loop.archive_confirmation,
    max_verify_failures: config.loop.max_verify_failures,
    snapshot: config.loop.snapshot,
  };
  const committed: OwnerProjectConfig = {
    ...config,
    loop: { ...stableLoop, artifact_root: options.pending.toArtifactRoot },
  };
  await writeProjectConfig(options.projectRoot, committed);
  return committed;
}

export async function moveLoopRoot(options: {
  projectRoot: string;
  toArtifactRoot: string;
  now?: Date;
  hooks?: LoopTransactionHooks;
}): Promise<{ fromLoopRoot: string; toLoopRoot: string; transactionId: string }> {
  const current = (await readProjectConfig(options.projectRoot)) ?? defaultProjectConfig('docs');
  if (current.loop.pending_root_move) {
    throw new Error(`Loop root move ${current.loop.pending_root_move.id} is already incomplete`);
  }
  const toArtifactRoot = normalizeArtifactRootRef(options.toArtifactRoot);
  if (toArtifactRoot === current.loop.artifact_root) {
    throw new Error(`Loop artifact root is already ${toArtifactRoot}`);
  }
  const sourcePaths = await loopProjectPaths(options.projectRoot, current.loop.artifact_root);
  const destinationPaths = await loopProjectPaths(options.projectRoot, toArtifactRoot);
  if (
    isInsidePath(sourcePaths.loopRoot, destinationPaths.loopRoot) ||
    isInsidePath(destinationPaths.loopRoot, sourcePaths.loopRoot)
  ) {
    throw new Error('Loop source and destination roots must not overlap');
  }
  if (!(await exists(sourcePaths.loopRoot))) {
    throw new Error(`Loop source root does not exist: ${sourcePaths.loopRoot}`);
  }
  await assertNoUnfinishedTransactions(sourcePaths);
  if (await exists(destinationPaths.loopRoot)) {
    throw new Error(`Loop destination is occupied: ${destinationPaths.loopRoot}`);
  }
  const lock = await acquireLoopLock(sourcePaths, 'root-move', `move root to ${toArtifactRoot}`);
  const id = randomUUID();
  const pending: LoopPendingRootMove = {
    id,
    fromArtifactRoot: current.loop.artifact_root,
    toArtifactRoot,
    stage: 'copying',
  };
  const journal = rootMoveJournal({ id, paths: sourcePaths, now: options.now ?? new Date() });
  const staging = stagingDirectory(destinationPaths, id);
  try {
    await assertNoOtherLocks(sourcePaths, lock.file);
    await validateLoopWorkspaceIdentitiesForRootMove(sourcePaths);
    if (await exists(staging)) throw new Error(`Loop move staging path is occupied: ${staging}`);
    await writeProjectConfig(options.projectRoot, pendingConfig(current, pending));
    await createLoopTransaction(sourcePaths, journal);
    await options.hooks?.afterRootMoveStage?.('copying', journal);
    await finishForwardMove({
      projectRoot: options.projectRoot,
      config: pendingConfig(current, pending),
      pending,
      sourcePaths,
      destinationPaths,
      staging,
      journal,
      lockFile: lock.file,
      hooks: options.hooks,
    });
    return {
      fromLoopRoot: sourcePaths.loopRoot,
      toLoopRoot: destinationPaths.loopRoot,
      transactionId: id,
    };
  } finally {
    await releaseLoopLock(lock);
  }
}

export async function recoverLoopRootMove(options: {
  projectRoot: string;
  strategy: 'continue' | 'rollback';
  hooks?: LoopTransactionHooks;
}): Promise<{ activeLoopRoot: string; config: OwnerProjectConfig }> {
  let config = await readProjectConfig(options.projectRoot);
  const pending = config?.loop.pending_root_move;
  if (!config || !pending) throw new Error('No pending Loop root move was found');
  const sourcePaths = await loopProjectPaths(options.projectRoot, pending.fromArtifactRoot);
  const destinationPaths = await loopProjectPaths(options.projectRoot, pending.toArtifactRoot);
  const staging = stagingDirectory(destinationPaths, pending.id);
  const lockPaths = (await exists(sourcePaths.loopRoot)) ? sourcePaths : destinationPaths;
  const lock = await acquireLoopLock(lockPaths, 'root-move', `recover root ${pending.id}`);
  try {
    let journalInfo: { journal: LoopTransactionJournal; paths: LoopProjectPaths };
    try {
      journalInfo = await readRootMoveJournal(sourcePaths, destinationPaths, staging, pending.id);
    } catch (error) {
      if (pending.stage !== 'copying' || !(await exists(sourcePaths.loopRoot))) throw error;
      const journal = rootMoveJournal({ id: pending.id, paths: sourcePaths, now: new Date() });
      await createLoopTransaction(sourcePaths, journal);
      journalInfo = { journal, paths: sourcePaths };
    }
    if (options.strategy === 'continue') {
      const committed = await finishForwardMove({
        projectRoot: options.projectRoot,
        config,
        pending,
        sourcePaths,
        destinationPaths,
        staging,
        journal: journalInfo.journal,
        lockFile: lock.file,
        hooks: options.hooks,
      });
      return { activeLoopRoot: destinationPaths.loopRoot, config: committed };
    }

    if (!(await exists(sourcePaths.loopRoot))) {
      throw new Error('Cannot roll back after the old Loop root was removed; continue recovery');
    }
    const destinationRemoval = rollbackRemovalDirectory(destinationPaths.loopRoot, pending.id);
    if (!config.loop.pending_root_move?.cleanup && (await exists(destinationPaths.loopRoot))) {
      await assertEquivalentTrees(sourcePaths.loopRoot, destinationPaths.loopRoot, lock.file);
    }
    if (
      !config.loop.pending_root_move?.cleanup ||
      config.loop.pending_root_move.cleanup.kind === 'rollback-destination'
    ) {
      config = await cleanupRootMoveTree({
        projectRoot: options.projectRoot,
        config,
        id: pending.id,
        kind: 'rollback-destination',
        stablePaths: sourcePaths,
        target: destinationPaths.loopRoot,
        quarantine: destinationRemoval,
        label: 'Loop root move rollback destination removal',
        hooks: options.hooks,
      });
    }
    const stagingRemoval = rollbackRemovalDirectory(staging, pending.id);
    if (!config.loop.pending_root_move?.cleanup && (await exists(staging))) {
      await assertEquivalentTrees(sourcePaths.loopRoot, staging, lock.file);
    }
    if (
      !config.loop.pending_root_move?.cleanup ||
      config.loop.pending_root_move.cleanup.kind === 'rollback-staging'
    ) {
      config = await cleanupRootMoveTree({
        projectRoot: options.projectRoot,
        config,
        id: pending.id,
        kind: 'rollback-staging',
        stablePaths: sourcePaths,
        target: staging,
        quarantine: stagingRemoval,
        label: 'Loop root move rollback staging removal',
        hooks: options.hooks,
      });
    }
    const sourceJournal = await readLoopTransaction(sourcePaths, pending.id);
    await rollbackLoopTransaction(sourcePaths, sourceJournal);
    const stableLoop = {
      artifact_root: config.loop.artifact_root,
      language: config.loop.language,
      clarification_mode: config.loop.clarification_mode,
      archive_confirmation: config.loop.archive_confirmation,
      max_verify_failures: config.loop.max_verify_failures,
      snapshot: config.loop.snapshot,
    };
    const restored: OwnerProjectConfig = {
      ...config,
      loop: { ...stableLoop, artifact_root: pending.fromArtifactRoot },
    };
    await writeProjectConfig(options.projectRoot, restored);
    return { activeLoopRoot: sourcePaths.loopRoot, config: restored };
  } finally {
    await releaseLoopLock(lock);
  }
}
