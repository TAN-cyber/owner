import { promises as fs } from 'node:fs';
import path from 'node:path';

import { atomicWriteJson } from './loop-atomic-file.js';
import { sameLoopFileObject } from './loop-file-identity.js';
import {
  inspectLoopArchiveContent,
  type LoopArchiveContentIdentity,
} from './loop-archive-content.js';
import { isInsidePath, loopStorageRoot, resolveContainedLoopPath } from './loop-paths.js';
import {
  captureLoopProtectedDirectoryGuard,
  copyLoopProtectedFile,
  ensureLoopProtectedDirectory,
  readLoopProtectedFile,
} from './loop-protected-file.js';
import {
  appendLoopTransactionEvent,
  loopTransactionPaths,
  parseLoopArchiveTransactionJournalV2,
  readLoopTransactionEvents,
  resolveLoopTransactionPaths,
  type LoopArchiveTransactionJournalV2,
  type LoopArchiveTransactionOperationV2,
} from './loop-transaction.js';
import type {
  LoopProjectPaths,
  LoopTransactionEvent,
  LoopTransactionStatus,
} from './loop-types.js';

export interface LoopArchiveTransactionHooksV2 {
  afterPrepared?: (journal: LoopArchiveTransactionJournalV2) => void | Promise<void>;
  afterOperation?: (
    operation: LoopArchiveTransactionOperationV2,
    completedCount: number,
  ) => void | Promise<void>;
  beforeArchiveChangeMove?: (operation: LoopArchiveTransactionOperationV2) => void | Promise<void>;
  afterFinalizationStarted?: (journal: LoopArchiveTransactionJournalV2) => void | Promise<void>;
  afterProtectedCopySourceParentCaptured?: (
    kind: 'stage' | 'backup' | 'apply',
    ref: string,
  ) => void | Promise<void>;
  afterArchiveTargetBound?: (
    phase: 'apply' | 'rollback',
    operation: LoopArchiveTransactionOperationV2,
    target: string,
  ) => void | Promise<void>;
  afterArchiveTargetQuarantined?: (
    phase: 'apply' | 'rollback',
    operation: LoopArchiveTransactionOperationV2,
    quarantine: string,
  ) => void | Promise<void>;
  beforeArchiveTargetInstall?: (
    phase: 'apply' | 'rollback',
    operation: LoopArchiveTransactionOperationV2,
    target: string,
  ) => void | Promise<void>;
  afterArchiveTargetInstalled?: (
    phase: 'apply' | 'rollback',
    operation: LoopArchiveTransactionOperationV2,
    target: string,
  ) => void | Promise<void>;
}

const LOOP_ARCHIVE_COPY_MAX_BYTES = 16 * 1024 * 1024;
const LOOP_ARCHIVE_JOURNAL_MAX_BYTES = 256 * 1024;
const LOOP_ARCHIVE_CAS_RECORD_MAX_BYTES = 16 * 1024;
const LOOP_ARCHIVE_CAS_SCHEMA = 'owner.loop.archive-cas.v1' as const;

interface LoopArchiveFileObjectIdentity {
  dev: number;
  ino: number;
  birthtimeMs: number;
}

interface LoopArchiveFileVersion extends LoopArchiveFileObjectIdentity {
  ctimeMs: number;
  mtimeMs: number;
  size: number;
}

interface LoopArchiveCasRecord {
  schema: typeof LOOP_ARCHIVE_CAS_SCHEMA;
  operationId: string;
  role: 'original' | 'post';
  hash: string;
  identity: LoopArchiveFileObjectIdentity;
}

function resolveRefLexically(paths: LoopProjectPaths, ref: string): string {
  const runtimePrefix = 'runtime/';
  const runtimeRef = ref.startsWith(runtimePrefix);
  const root = runtimeRef ? paths.runtimeDir : paths.loopRoot;
  const relativeRef = runtimeRef ? ref.slice(runtimePrefix.length) : ref;
  const target = path.resolve(root, ...relativeRef.split('/'));
  if (!isInsidePath(root, target)) {
    throw new Error(`Unsafe Loop Archive transaction ref: ${ref}`);
  }
  return target;
}

async function resolveRef(paths: LoopProjectPaths, ref: string): Promise<string> {
  const target = resolveRefLexically(paths, ref);
  return resolveContainedLoopPath(loopStorageRoot(paths, target), target);
}

function sameContent(
  actual: LoopArchiveContentIdentity | null,
  expectedHash: string | null,
  expectedKind: LoopArchiveContentIdentity['kind'] = 'file',
): boolean {
  return expectedHash === null
    ? actual === null
    : actual?.kind === expectedKind && actual.hash === expectedHash;
}

function contentDescription(value: LoopArchiveContentIdentity | null): string {
  return value === null ? 'missing' : `${value.kind}:${value.hash}`;
}

async function assertContent(options: {
  target: string;
  expectedHash: string | null;
  expectedKind?: LoopArchiveContentIdentity['kind'];
  label: string;
}): Promise<LoopArchiveContentIdentity | null> {
  const actual = await inspectLoopArchiveContent(options.target);
  if (!sameContent(actual, options.expectedHash, options.expectedKind)) {
    throw new Error(
      `${options.label} content changed: expected ${options.expectedHash ?? 'missing'}, got ${contentDescription(actual)}`,
    );
  }
  return actual;
}

export async function createLoopArchiveTransactionV2(
  paths: LoopProjectPaths,
  journal: LoopArchiveTransactionJournalV2,
): Promise<void> {
  const validated = parseLoopArchiveTransactionJournalV2(journal);
  const tx = await resolveLoopTransactionPaths(paths, validated.id);
  await fs.mkdir(tx.staged, { recursive: true });
  await fs.mkdir(tx.backups, { recursive: true });
  await atomicWriteJson(tx.journal, validated, { containedRoot: paths.runtimeDir });
  await appendLoopTransactionEvent(paths, validated.id, 'prepared');
}

export async function readLoopArchiveTransactionV2(
  paths: LoopProjectPaths,
  id: string,
): Promise<LoopArchiveTransactionJournalV2> {
  const tx = await resolveLoopTransactionPaths(paths, id);
  const snapshot = await readLoopProtectedFile({
    root: paths.runtimeDir,
    file: tx.journal,
    maxBytes: LOOP_ARCHIVE_JOURNAL_MAX_BYTES,
    label: `Loop Archive transaction journal ${id}`,
  });
  const journal = parseLoopArchiveTransactionJournalV2(
    JSON.parse(snapshot.bytes.toString('utf8')) as unknown,
  );
  if (journal.id !== id) throw new Error(`Invalid Loop Archive transaction journal: ${id}`);
  return journal;
}

async function setStatus(
  paths: LoopProjectPaths,
  journal: LoopArchiveTransactionJournalV2,
  status: LoopTransactionStatus,
): Promise<LoopArchiveTransactionJournalV2> {
  const updated = parseLoopArchiveTransactionJournalV2({ ...journal, status });
  const tx = await resolveLoopTransactionPaths(paths, updated.id);
  await atomicWriteJson(tx.journal, updated, { containedRoot: paths.runtimeDir });
  return updated;
}

function fileObjectIdentity(stat: import('node:fs').Stats): LoopArchiveFileObjectIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    birthtimeMs: stat.birthtimeMs,
  };
}

function fileVersion(stat: import('node:fs').Stats): LoopArchiveFileVersion {
  return {
    ...fileObjectIdentity(stat),
    ctimeMs: stat.ctimeMs,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  };
}

function sameFileObject(
  expected: LoopArchiveFileObjectIdentity,
  actual: LoopArchiveFileObjectIdentity,
): boolean {
  return (
    sameLoopFileObject(
      { ...expected, birthtime: expected.birthtimeMs },
      {
        ...actual,
        birthtime: actual.birthtimeMs,
      },
    ) && expected.birthtimeMs === actual.birthtimeMs
  );
}

function sameFileVersion(
  expected: LoopArchiveFileVersion,
  actual: LoopArchiveFileVersion,
): boolean {
  return (
    sameFileObject(expected, actual) &&
    expected.birthtimeMs === actual.birthtimeMs &&
    expected.ctimeMs === actual.ctimeMs &&
    expected.mtimeMs === actual.mtimeMs &&
    expected.size === actual.size
  );
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function captureStableArchiveFile(options: {
  paths: LoopProjectPaths;
  file: string;
  expectedHash: string;
  label: string;
}): Promise<{ identity: LoopArchiveFileObjectIdentity; size: number }> {
  const before = await fs.lstat(options.file);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`${options.label} must be a regular file`);
  }
  const beforeVersion = fileVersion(before);
  const snapshot = await readLoopProtectedFile({
    root: loopStorageRoot(options.paths, options.file),
    file: options.file,
    maxBytes: LOOP_ARCHIVE_COPY_MAX_BYTES,
    label: options.label,
  });
  const after = await fs.lstat(options.file);
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    !sameFileVersion(beforeVersion, fileVersion(after)) ||
    snapshot.hash !== options.expectedHash
  ) {
    throw new Error(`${options.label} content changed or object identity changed while binding`);
  }
  return { identity: fileObjectIdentity(after), size: snapshot.size };
}

function parseCasRecord(
  value: unknown,
  operation: LoopArchiveTransactionOperationV2,
  role: LoopArchiveCasRecord['role'],
  expectedHash: string,
): LoopArchiveCasRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Archive CAS ${operation.id} ${role} record must be an object`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== 'hash,identity,operationId,role,schema') {
    throw new Error(`Archive CAS ${operation.id} ${role} record has an invalid shape`);
  }
  const identity = record.identity;
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    throw new Error(`Archive CAS ${operation.id} ${role} identity must be an object`);
  }
  const identityRecord = identity as Record<string, unknown>;
  if (Object.keys(identityRecord).sort().join(',') !== 'birthtimeMs,dev,ino') {
    throw new Error(`Archive CAS ${operation.id} ${role} identity has an invalid shape`);
  }
  for (const field of ['dev', 'ino', 'birthtimeMs'] as const) {
    if (
      typeof identityRecord[field] !== 'number' ||
      !Number.isFinite(identityRecord[field]) ||
      identityRecord[field] < 0
    ) {
      throw new Error(`Archive CAS ${operation.id} ${role} identity ${field} is invalid`);
    }
  }
  if (
    record.schema !== LOOP_ARCHIVE_CAS_SCHEMA ||
    record.operationId !== operation.id ||
    record.role !== role ||
    record.hash !== expectedHash
  ) {
    throw new Error(`Archive CAS ${operation.id} ${role} record is not transaction-bound`);
  }
  return {
    schema: LOOP_ARCHIVE_CAS_SCHEMA,
    operationId: operation.id,
    role,
    hash: expectedHash,
    identity: {
      dev: identityRecord.dev as number,
      ino: identityRecord.ino as number,
      birthtimeMs: identityRecord.birthtimeMs as number,
    },
  };
}

async function archiveCasPaths(
  paths: LoopProjectPaths,
  journal: LoopArchiveTransactionJournalV2,
  operation: LoopArchiveTransactionOperationV2,
  target: string,
): Promise<{
  directory: string;
  originalRecord: string;
  postRecord: string;
  candidate: string;
  originalQuarantine: string;
  rollbackQuarantine: string;
}> {
  const tx = await resolveLoopTransactionPaths(paths, journal.id);
  const directory = path.join(tx.backups, '.cas');
  const prefix = `.${path.basename(target)}.owner-archive-cas-${journal.id}-${operation.id}`;
  const result = {
    directory,
    originalRecord: path.join(directory, `${operation.id}.original.json`),
    postRecord: path.join(directory, `${operation.id}.post.json`),
    candidate: path.join(directory, `${operation.id}.candidate`),
    originalQuarantine: path.join(path.dirname(target), `${prefix}.original`),
    rollbackQuarantine: path.join(path.dirname(target), `${prefix}.rollback`),
  };
  await Promise.all(
    Object.values(result).map((item) =>
      resolveContainedLoopPath(loopStorageRoot(paths, item), item),
    ),
  );
  return result;
}

async function readCasRecord(options: {
  paths: LoopProjectPaths;
  file: string;
  operation: LoopArchiveTransactionOperationV2;
  role: LoopArchiveCasRecord['role'];
  expectedHash: string;
}): Promise<LoopArchiveCasRecord | null> {
  if (!(await pathExists(options.file))) return null;
  const snapshot = await readLoopProtectedFile({
    root: options.paths.runtimeDir,
    file: options.file,
    maxBytes: LOOP_ARCHIVE_CAS_RECORD_MAX_BYTES,
    label: `Archive CAS ${options.operation.id} ${options.role} record`,
  });
  return parseCasRecord(
    JSON.parse(snapshot.bytes.toString('utf8')) as unknown,
    options.operation,
    options.role,
    options.expectedHash,
  );
}

async function persistCasRecord(options: {
  paths: LoopProjectPaths;
  file: string;
  operation: LoopArchiveTransactionOperationV2;
  role: LoopArchiveCasRecord['role'];
  expectedHash: string;
  identity: LoopArchiveFileObjectIdentity;
}): Promise<LoopArchiveCasRecord> {
  const existing = await readCasRecord(options);
  if (existing) {
    if (!sameFileObject(existing.identity, options.identity)) {
      throw new Error(
        `Archive CAS ${options.operation.id} ${options.role} object identity changed`,
      );
    }
    return existing;
  }
  await ensureLoopProtectedDirectory({
    root: options.paths.runtimeDir,
    directory: path.dirname(options.file),
    label: `Archive CAS ${options.operation.id} records`,
  });
  const record: LoopArchiveCasRecord = {
    schema: LOOP_ARCHIVE_CAS_SCHEMA,
    operationId: options.operation.id,
    role: options.role,
    hash: options.expectedHash,
    identity: options.identity,
  };
  try {
    await atomicWriteJson(options.file, record, {
      containedRoot: options.paths.runtimeDir,
      exclusive: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const persisted = await readCasRecord(options);
  if (!persisted || !sameFileObject(persisted.identity, options.identity)) {
    throw new Error(`Archive CAS ${options.operation.id} ${options.role} record changed`);
  }
  return persisted;
}

async function validateFileAgainstCasRecord(options: {
  paths: LoopProjectPaths;
  file: string;
  operation: LoopArchiveTransactionOperationV2;
  record: LoopArchiveCasRecord;
  label: string;
}): Promise<void> {
  const current = await captureStableArchiveFile({
    paths: options.paths,
    file: options.file,
    expectedHash: options.record.hash,
    label: options.label,
  });
  if (!sameFileObject(options.record.identity, current.identity)) {
    throw new Error(`${options.label} object identity changed`);
  }
}

async function bindCurrentTarget(options: {
  paths: LoopProjectPaths;
  file: string;
  recordFile: string;
  operation: LoopArchiveTransactionOperationV2;
  role: LoopArchiveCasRecord['role'];
  expectedHash: string;
  label: string;
}): Promise<LoopArchiveCasRecord> {
  const current = await captureStableArchiveFile({
    paths: options.paths,
    file: options.file,
    expectedHash: options.expectedHash,
    label: options.label,
  });
  const record = await persistCasRecord({
    paths: options.paths,
    file: options.recordFile,
    operation: options.operation,
    role: options.role,
    expectedHash: options.expectedHash,
    identity: current.identity,
  });
  await validateFileAgainstCasRecord({
    paths: options.paths,
    file: options.file,
    operation: options.operation,
    record,
    label: options.label,
  });
  return record;
}

async function restoreUnexpectedQuarantine(options: {
  paths: LoopProjectPaths;
  quarantine: string;
  target: string;
  operation: LoopArchiveTransactionOperationV2;
}): Promise<void> {
  if (!(await pathExists(options.quarantine)) || (await pathExists(options.target))) return;
  const guard = await captureLoopProtectedDirectoryGuard({
    root: loopStorageRoot(options.paths, options.target),
    directory: path.dirname(options.target),
    label: `Archive CAS ${options.operation.id} quarantine restoration`,
  });
  await guard.verify();
  try {
    await fs.link(options.quarantine, options.target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
    throw error;
  }
  await guard.verify();
  const [quarantine, target] = await Promise.all([
    fs.lstat(options.quarantine),
    fs.lstat(options.target),
  ]);
  if (!sameFileObject(fileObjectIdentity(quarantine), fileObjectIdentity(target))) {
    throw new Error(`Archive CAS ${options.operation.id} could not restore quarantined content`);
  }
  await fs.unlink(options.quarantine);
  await guard.verify();
}

async function quarantineBoundTarget(options: {
  paths: LoopProjectPaths;
  operation: LoopArchiveTransactionOperationV2;
  phase: 'apply' | 'rollback';
  target: string;
  quarantine: string;
  record: LoopArchiveCasRecord;
  hooks?: LoopArchiveTransactionHooksV2;
}): Promise<void> {
  if (await pathExists(options.quarantine)) {
    await validateFileAgainstCasRecord({
      paths: options.paths,
      file: options.quarantine,
      operation: options.operation,
      record: options.record,
      label: `Archive ${options.phase} quarantine ${options.operation.target}`,
    });
    return;
  }
  const guard = await captureLoopProtectedDirectoryGuard({
    root: loopStorageRoot(options.paths, options.target),
    directory: path.dirname(options.target),
    label: `Archive ${options.phase} target ${options.operation.target}`,
  });
  await validateFileAgainstCasRecord({
    paths: options.paths,
    file: options.target,
    operation: options.operation,
    record: options.record,
    label: `Archive ${options.phase} target ${options.operation.target}`,
  });
  await options.hooks?.afterArchiveTargetBound?.(options.phase, options.operation, options.target);
  await guard.verify();
  await validateFileAgainstCasRecord({
    paths: options.paths,
    file: options.target,
    operation: options.operation,
    record: options.record,
    label: `Archive ${options.phase} target ${options.operation.target}`,
  });
  try {
    await fs.rename(options.target, options.quarantine);
    await guard.verify();
    await validateFileAgainstCasRecord({
      paths: options.paths,
      file: options.quarantine,
      operation: options.operation,
      record: options.record,
      label: `Archive ${options.phase} quarantine ${options.operation.target}`,
    });
  } catch (error) {
    await restoreUnexpectedQuarantine(options);
    throw new Error(
      `Archive ${options.phase} target ${options.operation.target} changed during quarantine`,
      { cause: error },
    );
  }
  await options.hooks?.afterArchiveTargetQuarantined?.(
    options.phase,
    options.operation,
    options.quarantine,
  );
}

async function removeExactCasFile(options: {
  paths: LoopProjectPaths;
  file: string;
  operation: LoopArchiveTransactionOperationV2;
  record: LoopArchiveCasRecord;
  label: string;
}): Promise<void> {
  if (!(await pathExists(options.file))) return;
  await validateFileAgainstCasRecord(options);
  const guard = await captureLoopProtectedDirectoryGuard({
    root: loopStorageRoot(options.paths, options.file),
    directory: path.dirname(options.file),
    label: options.label,
  });
  await guard.verify();
  await validateFileAgainstCasRecord(options);
  await fs.unlink(options.file);
  await guard.verify();
}

async function ensureBackup(
  paths: LoopProjectPaths,
  operation: LoopArchiveTransactionOperationV2,
  hooks?: LoopArchiveTransactionHooksV2,
): Promise<void> {
  if (!operation.backup || operation.expectedTargetHash === null) return;
  const target = await resolveRef(paths, operation.target);
  const backup = await resolveRef(paths, operation.backup);
  const existing = await inspectLoopArchiveContent(backup);
  if (existing !== null) {
    if (!sameContent(existing, operation.expectedTargetHash)) {
      throw new Error(`Archive transaction backup content changed: ${operation.backup}`);
    }
    return;
  }
  await assertContent({
    target,
    expectedHash: operation.expectedTargetHash,
    label: `Archive transaction target ${operation.target}`,
  });
  await copyLoopProtectedFile({
    sourceRoot: loopStorageRoot(paths, target),
    source: target,
    targetRoot: loopStorageRoot(paths, backup),
    target: backup,
    maxBytes: LOOP_ARCHIVE_COPY_MAX_BYTES,
    label: `Archive transaction backup ${operation.backup}`,
    expectedHash: operation.expectedTargetHash,
    expectedTargetHash: null,
    exclusive: true,
    hooks: {
      afterParentChainCaptured: () =>
        hooks?.afterProtectedCopySourceParentCaptured?.('backup', operation.target),
    },
  });
  await assertContent({
    target: backup,
    expectedHash: operation.expectedTargetHash,
    label: `Archive transaction backup ${operation.backup}`,
  });
}

async function ensureOriginalTargetQuarantined(options: {
  paths: LoopProjectPaths;
  journal: LoopArchiveTransactionJournalV2;
  operation: LoopArchiveTransactionOperationV2;
  target: string;
  hooks?: LoopArchiveTransactionHooksV2;
}): Promise<{
  record: LoopArchiveCasRecord;
  quarantine: string;
}> {
  const expectedHash = options.operation.expectedTargetHash;
  if (expectedHash === null) {
    throw new Error(
      `Archive operation ${options.operation.id} has no original target to quarantine`,
    );
  }
  const cas = await archiveCasPaths(
    options.paths,
    options.journal,
    options.operation,
    options.target,
  );
  let record = await readCasRecord({
    paths: options.paths,
    file: cas.originalRecord,
    operation: options.operation,
    role: 'original',
    expectedHash,
  });
  if (await pathExists(cas.originalQuarantine)) {
    if (!record) {
      throw new Error(
        `Archive apply quarantine ${options.operation.target} has no bound object identity`,
      );
    }
    await validateFileAgainstCasRecord({
      paths: options.paths,
      file: cas.originalQuarantine,
      operation: options.operation,
      record,
      label: `Archive apply quarantine ${options.operation.target}`,
    });
    await ensureBackup(options.paths, options.operation, options.hooks);
    return { record, quarantine: cas.originalQuarantine };
  }
  if (!(await pathExists(options.target))) {
    throw new Error(
      `Archive apply target ${options.operation.target} disappeared before quarantine`,
    );
  }
  record ??= await bindCurrentTarget({
    paths: options.paths,
    file: options.target,
    recordFile: cas.originalRecord,
    operation: options.operation,
    role: 'original',
    expectedHash,
    label: `Archive apply target ${options.operation.target}`,
  });
  await validateFileAgainstCasRecord({
    paths: options.paths,
    file: options.target,
    operation: options.operation,
    record,
    label: `Archive apply target ${options.operation.target}`,
  });
  await ensureBackup(options.paths, options.operation, options.hooks);
  await quarantineBoundTarget({
    paths: options.paths,
    operation: options.operation,
    phase: 'apply',
    target: options.target,
    quarantine: cas.originalQuarantine,
    record,
    hooks: options.hooks,
  });
  return { record, quarantine: cas.originalQuarantine };
}

async function ensureWriteCandidate(options: {
  paths: LoopProjectPaths;
  journal: LoopArchiveTransactionJournalV2;
  operation: LoopArchiveTransactionOperationV2;
  staged: string;
  target: string;
  hooks?: LoopArchiveTransactionHooksV2;
}): Promise<string> {
  const cas = await archiveCasPaths(
    options.paths,
    options.journal,
    options.operation,
    options.target,
  );
  if (await pathExists(cas.candidate)) {
    await captureStableArchiveFile({
      paths: options.paths,
      file: cas.candidate,
      expectedHash: options.operation.stagedHash!,
      label: `Archive write candidate ${options.operation.target}`,
    });
    return cas.candidate;
  }
  await ensureLoopProtectedDirectory({
    root: options.paths.runtimeDir,
    directory: cas.directory,
    label: `Archive CAS ${options.operation.id} records`,
  });
  await copyLoopProtectedFile({
    sourceRoot: loopStorageRoot(options.paths, options.staged),
    source: options.staged,
    targetRoot: options.paths.runtimeDir,
    target: cas.candidate,
    maxBytes: LOOP_ARCHIVE_COPY_MAX_BYTES,
    label: `Archive transaction staged file ${options.operation.staged}`,
    expectedHash: options.operation.stagedHash!,
    expectedTargetHash: null,
    exclusive: true,
    hooks: {
      afterParentChainCaptured: () =>
        options.hooks?.afterProtectedCopySourceParentCaptured?.('apply', options.operation.staged!),
    },
  });
  return cas.candidate;
}

async function ensureWriteInstalled(options: {
  paths: LoopProjectPaths;
  journal: LoopArchiveTransactionJournalV2;
  operation: LoopArchiveTransactionOperationV2;
  staged: string;
  target: string;
  hooks?: LoopArchiveTransactionHooksV2;
}): Promise<LoopArchiveCasRecord> {
  const expectedHash = options.operation.stagedHash!;
  const cas = await archiveCasPaths(
    options.paths,
    options.journal,
    options.operation,
    options.target,
  );
  let record = await readCasRecord({
    paths: options.paths,
    file: cas.postRecord,
    operation: options.operation,
    role: 'post',
    expectedHash,
  });
  if (record && (await pathExists(options.target))) {
    await validateFileAgainstCasRecord({
      paths: options.paths,
      file: options.target,
      operation: options.operation,
      record,
      label: `Archive write target ${options.operation.target}`,
    });
    if (await pathExists(cas.candidate)) {
      await removeExactCasFile({
        paths: options.paths,
        file: cas.candidate,
        operation: options.operation,
        record,
        label: `Archive write candidate ${options.operation.target}`,
      });
    }
    return record;
  }
  if (await pathExists(options.target)) {
    const candidate = await ensureWriteCandidate(options);
    const candidateIdentity = await captureStableArchiveFile({
      paths: options.paths,
      file: candidate,
      expectedHash,
      label: `Archive write candidate ${options.operation.target}`,
    });
    const targetIdentity = await captureStableArchiveFile({
      paths: options.paths,
      file: options.target,
      expectedHash,
      label: `Archive write target ${options.operation.target}`,
    });
    if (!sameFileObject(candidateIdentity.identity, targetIdentity.identity)) {
      throw new Error(
        `Archive write target ${options.operation.target} is occupied by an external object`,
      );
    }
    record = await persistCasRecord({
      paths: options.paths,
      file: cas.postRecord,
      operation: options.operation,
      role: 'post',
      expectedHash,
      identity: targetIdentity.identity,
    });
    await removeExactCasFile({
      paths: options.paths,
      file: candidate,
      operation: options.operation,
      record,
      label: `Archive write candidate ${options.operation.target}`,
    });
    return record;
  }
  const candidate = await ensureWriteCandidate(options);
  const candidateIdentity = await captureStableArchiveFile({
    paths: options.paths,
    file: candidate,
    expectedHash,
    label: `Archive write candidate ${options.operation.target}`,
  });
  await ensureLoopProtectedDirectory({
    root: loopStorageRoot(options.paths, options.target),
    directory: path.dirname(options.target),
    label: `Archive write target ${options.operation.target}`,
  });
  const guard = await captureLoopProtectedDirectoryGuard({
    root: loopStorageRoot(options.paths, options.target),
    directory: path.dirname(options.target),
    label: `Archive write target ${options.operation.target}`,
  });
  await options.hooks?.beforeArchiveTargetInstall?.('apply', options.operation, options.target);
  await guard.verify();
  await validateFileAgainstCasRecord({
    paths: options.paths,
    file: candidate,
    operation: options.operation,
    record: {
      schema: LOOP_ARCHIVE_CAS_SCHEMA,
      operationId: options.operation.id,
      role: 'post',
      hash: expectedHash,
      identity: candidateIdentity.identity,
    },
    label: `Archive write candidate ${options.operation.target}`,
  });
  try {
    await fs.link(candidate, options.target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `Archive write target ${options.operation.target} was created before exclusive install`,
        { cause: error },
      );
    }
    throw error;
  }
  await guard.verify();
  await options.hooks?.afterArchiveTargetInstalled?.('apply', options.operation, options.target);
  const targetIdentity = await captureStableArchiveFile({
    paths: options.paths,
    file: options.target,
    expectedHash,
    label: `Archive write target ${options.operation.target}`,
  });
  if (!sameFileObject(candidateIdentity.identity, targetIdentity.identity)) {
    throw new Error(`Archive write target ${options.operation.target} changed during install`);
  }
  record = await persistCasRecord({
    paths: options.paths,
    file: cas.postRecord,
    operation: options.operation,
    role: 'post',
    expectedHash,
    identity: targetIdentity.identity,
  });
  await removeExactCasFile({
    paths: options.paths,
    file: candidate,
    operation: options.operation,
    record,
    label: `Archive write candidate ${options.operation.target}`,
  });
  return record;
}

async function applyWrite(
  paths: LoopProjectPaths,
  journal: LoopArchiveTransactionJournalV2,
  operation: LoopArchiveTransactionOperationV2,
  hooks?: LoopArchiveTransactionHooksV2,
): Promise<void> {
  const target = await resolveRef(paths, operation.target);
  const staged = await resolveRef(paths, operation.staged!);
  await assertContent({
    target: staged,
    expectedHash: operation.stagedHash!,
    label: `Archive transaction staged file ${operation.staged}`,
  });
  if (operation.expectedTargetHash !== null) {
    const cas = await archiveCasPaths(paths, journal, operation, target);
    const postRecord = await readCasRecord({
      paths,
      file: cas.postRecord,
      operation,
      role: 'post',
      expectedHash: operation.stagedHash!,
    });
    if (!postRecord || !(await pathExists(target))) {
      await ensureOriginalTargetQuarantined({ paths, journal, operation, target, hooks });
    }
  } else {
    const actual = await inspectLoopArchiveContent(target);
    if (actual !== null && !sameContent(actual, operation.stagedHash!)) {
      throw new Error(
        `Archive transaction target ${operation.target} changed before create: ${contentDescription(actual)}`,
      );
    }
  }
  await ensureWriteInstalled({
    paths,
    journal,
    operation,
    staged,
    target,
    hooks,
  });
  await assertContent({
    target,
    expectedHash: operation.stagedHash!,
    label: `Archive transaction target ${operation.target}`,
  });
}

async function applyRemove(
  paths: LoopProjectPaths,
  journal: LoopArchiveTransactionJournalV2,
  operation: LoopArchiveTransactionOperationV2,
  hooks?: LoopArchiveTransactionHooksV2,
): Promise<void> {
  const target = await resolveRef(paths, operation.target);
  await ensureOriginalTargetQuarantined({ paths, journal, operation, target, hooks });
  await assertContent({
    target,
    expectedHash: null,
    label: `Archive transaction target ${operation.target}`,
  });
}

async function applyMove(
  paths: LoopProjectPaths,
  operation: LoopArchiveTransactionOperationV2,
): Promise<void> {
  const source = await resolveRef(paths, operation.source!);
  const target = await resolveRef(paths, operation.target);
  const [sourceContent, targetContent] = await Promise.all([
    inspectLoopArchiveContent(source),
    inspectLoopArchiveContent(target),
  ]);
  if (
    sourceContent === null &&
    sameContent(targetContent, operation.expectedSourceHash!, 'directory')
  ) {
    return;
  }
  if (
    !sameContent(sourceContent, operation.expectedSourceHash!, 'directory') ||
    targetContent !== null
  ) {
    throw new Error(
      `Archive transaction move ${operation.id} content changed: source=${contentDescription(sourceContent)}, target=${contentDescription(targetContent)}`,
    );
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rename(source, target);
  await assertContent({
    target,
    expectedHash: operation.expectedSourceHash!,
    expectedKind: 'directory',
    label: `Archive transaction move target ${operation.target}`,
  });
}

async function applyOperation(
  paths: LoopProjectPaths,
  journal: LoopArchiveTransactionJournalV2,
  operation: LoopArchiveTransactionOperationV2,
  hooks?: LoopArchiveTransactionHooksV2,
): Promise<void> {
  if (operation.type === 'write') return applyWrite(paths, journal, operation, hooks);
  if (operation.type === 'remove') return applyRemove(paths, journal, operation, hooks);
  return applyMove(paths, operation);
}

function completedOperationIds(options: {
  journal: LoopArchiveTransactionJournalV2;
  events: readonly LoopTransactionEvent[];
}): string[] {
  let operationIndex = 0;
  let startedCurrent = false;
  const completed: string[] = [];
  for (const event of options.events) {
    if (event.type !== 'operation-started' && event.type !== 'operation-completed') continue;
    const expected = options.journal.operations[operationIndex];
    if (!expected || event.operationId !== expected.id) {
      throw new Error(
        `Loop Archive transaction ${options.journal.id} operation events are out of order`,
      );
    }
    if (event.type === 'operation-started') {
      startedCurrent = true;
      continue;
    }
    if (!startedCurrent) {
      throw new Error(
        `Loop Archive transaction ${options.journal.id} completed an operation before it started`,
      );
    }
    completed.push(expected.id);
    operationIndex += 1;
    startedCurrent = false;
  }
  return completed;
}

async function assertCompletedOperation(
  paths: LoopProjectPaths,
  journal: LoopArchiveTransactionJournalV2,
  operation: LoopArchiveTransactionOperationV2,
  finalizationStarted: boolean,
): Promise<void> {
  const target = await resolveRef(paths, operation.target);
  if (operation.type === 'write') {
    const staged = await resolveRef(paths, operation.staged!);
    await assertContent({
      target: staged,
      expectedHash: operation.stagedHash!,
      label: `Completed Archive staged file ${operation.staged}`,
    });
    const cas = await archiveCasPaths(paths, journal, operation, target);
    const postRecord = await readCasRecord({
      paths,
      file: cas.postRecord,
      operation,
      role: 'post',
      expectedHash: operation.stagedHash!,
    });
    if (!postRecord) {
      throw new Error(`Completed Archive target ${operation.target} has no CAS identity`);
    }
    await validateFileAgainstCasRecord({
      paths,
      file: target,
      operation,
      record: postRecord,
      label: `Completed Archive target ${operation.target}`,
    });
    if (operation.expectedTargetHash !== null) {
      await assertContent({
        target: await resolveRef(paths, operation.backup!),
        expectedHash: operation.expectedTargetHash,
        label: `Completed Archive backup ${operation.backup}`,
      });
      const originalRecord = await readCasRecord({
        paths,
        file: cas.originalRecord,
        operation,
        role: 'original',
        expectedHash: operation.expectedTargetHash,
      });
      if (!originalRecord) {
        throw new Error(
          `Completed Archive target ${operation.target} has no original CAS identity`,
        );
      }
      if (await pathExists(cas.originalQuarantine)) {
        await validateFileAgainstCasRecord({
          paths,
          file: cas.originalQuarantine,
          operation,
          record: originalRecord,
          label: `Completed Archive original quarantine ${operation.target}`,
        });
      } else if (!finalizationStarted) {
        throw new Error(`Completed Archive original quarantine ${operation.target} disappeared`);
      }
    }
    return;
  }
  if (operation.type === 'remove') {
    await assertContent({
      target,
      expectedHash: null,
      label: `Completed Archive target ${operation.target}`,
    });
    await assertContent({
      target: await resolveRef(paths, operation.backup!),
      expectedHash: operation.expectedTargetHash,
      label: `Completed Archive backup ${operation.backup}`,
    });
    const cas = await archiveCasPaths(paths, journal, operation, target);
    const originalRecord = await readCasRecord({
      paths,
      file: cas.originalRecord,
      operation,
      role: 'original',
      expectedHash: operation.expectedTargetHash!,
    });
    if (!originalRecord) {
      throw new Error(`Completed Archive remove ${operation.target} has no original CAS identity`);
    }
    if (await pathExists(cas.originalQuarantine)) {
      await validateFileAgainstCasRecord({
        paths,
        file: cas.originalQuarantine,
        operation,
        record: originalRecord,
        label: `Completed Archive original quarantine ${operation.target}`,
      });
    } else if (!finalizationStarted) {
      throw new Error(`Completed Archive original quarantine ${operation.target} disappeared`);
    }
    return;
  }
  if (finalizationStarted) return;
  await assertContent({
    target: await resolveRef(paths, operation.source!),
    expectedHash: null,
    label: `Completed Archive move source ${operation.source}`,
  });
  await assertContent({
    target,
    expectedHash: operation.expectedSourceHash!,
    expectedKind: 'directory',
    label: `Completed Archive move target ${operation.target}`,
  });
}

export async function applyLoopArchiveTransactionV2(
  paths: LoopProjectPaths,
  journal: LoopArchiveTransactionJournalV2,
  hooks?: LoopArchiveTransactionHooksV2,
): Promise<LoopArchiveTransactionJournalV2> {
  let current =
    journal.status === 'prepared' ? await setStatus(paths, journal, 'applying') : journal;
  if (current.status !== 'applying') {
    throw new Error(`Loop Archive transaction ${current.id} cannot apply from ${current.status}`);
  }
  const events = await readLoopTransactionEvents(paths, current.id);
  const completedIds = completedOperationIds({ journal: current, events });
  const completed = new Set(completedIds);
  const finalizationStarted = events.some((event) => event.type === 'archive-finalization-started');
  for (const operation of current.operations.slice(0, completedIds.length)) {
    await assertCompletedOperation(paths, current, operation, finalizationStarted);
  }
  let completedCount = completed.size;
  for (const operation of current.operations) {
    if (completed.has(operation.id)) continue;
    if (operation.id === 'archive-change') {
      await hooks?.beforeArchiveChangeMove?.(operation);
    }
    await appendLoopTransactionEvent(paths, current.id, 'operation-started', operation.id);
    await applyOperation(paths, current, operation, hooks);
    await appendLoopTransactionEvent(paths, current.id, 'operation-completed', operation.id);
    completedCount += 1;
    await hooks?.afterOperation?.(operation, completedCount);
  }
  current = await readLoopArchiveTransactionV2(paths, current.id);
  return current;
}

async function fileMatchesCasRecord(options: {
  paths: LoopProjectPaths;
  file: string;
  operation: LoopArchiveTransactionOperationV2;
  record: LoopArchiveCasRecord;
  label: string;
}): Promise<boolean> {
  try {
    await validateFileAgainstCasRecord(options);
    return true;
  } catch {
    return false;
  }
}

async function installOriginalTarget(options: {
  paths: LoopProjectPaths;
  operation: LoopArchiveTransactionOperationV2;
  target: string;
  quarantine: string;
  record: LoopArchiveCasRecord;
  hooks?: LoopArchiveTransactionHooksV2;
}): Promise<void> {
  await validateFileAgainstCasRecord({
    paths: options.paths,
    file: options.quarantine,
    operation: options.operation,
    record: options.record,
    label: `Archive rollback original quarantine ${options.operation.target}`,
  });
  const guard = await captureLoopProtectedDirectoryGuard({
    root: loopStorageRoot(options.paths, options.target),
    directory: path.dirname(options.target),
    label: `Archive rollback target ${options.operation.target}`,
  });
  await options.hooks?.beforeArchiveTargetInstall?.('rollback', options.operation, options.target);
  await guard.verify();
  await validateFileAgainstCasRecord({
    paths: options.paths,
    file: options.quarantine,
    operation: options.operation,
    record: options.record,
    label: `Archive rollback original quarantine ${options.operation.target}`,
  });
  try {
    await fs.link(options.quarantine, options.target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `Archive rollback target ${options.operation.target} was created before exclusive restore`,
        { cause: error },
      );
    }
    throw error;
  }
  await guard.verify();
  await options.hooks?.afterArchiveTargetInstalled?.('rollback', options.operation, options.target);
  await validateFileAgainstCasRecord({
    paths: options.paths,
    file: options.target,
    operation: options.operation,
    record: options.record,
    label: `Archive rollback target ${options.operation.target}`,
  });
}

async function removeWriteCandidateIfPresent(options: {
  paths: LoopProjectPaths;
  journal: LoopArchiveTransactionJournalV2;
  operation: LoopArchiveTransactionOperationV2;
  target: string;
}): Promise<void> {
  if (options.operation.type !== 'write') return;
  const cas = await archiveCasPaths(
    options.paths,
    options.journal,
    options.operation,
    options.target,
  );
  if (!(await pathExists(cas.candidate))) return;
  const current = await captureStableArchiveFile({
    paths: options.paths,
    file: cas.candidate,
    expectedHash: options.operation.stagedHash!,
    label: `Archive write candidate ${options.operation.target}`,
  });
  await removeExactCasFile({
    paths: options.paths,
    file: cas.candidate,
    operation: options.operation,
    record: {
      schema: LOOP_ARCHIVE_CAS_SCHEMA,
      operationId: options.operation.id,
      role: 'post',
      hash: options.operation.stagedHash!,
      identity: current.identity,
    },
    label: `Archive write candidate ${options.operation.target}`,
  });
}

async function rollbackWriteOrRemove(
  paths: LoopProjectPaths,
  journal: LoopArchiveTransactionJournalV2,
  operation: LoopArchiveTransactionOperationV2,
  hooks?: LoopArchiveTransactionHooksV2,
): Promise<void> {
  const target = await resolveRef(paths, operation.target);
  const cas = await archiveCasPaths(paths, journal, operation, target);
  const originalHash = operation.expectedTargetHash;
  const originalRecord =
    originalHash === null
      ? null
      : await readCasRecord({
          paths,
          file: cas.originalRecord,
          operation,
          role: 'original',
          expectedHash: originalHash,
        });
  let postRecord =
    operation.type === 'write'
      ? await readCasRecord({
          paths,
          file: cas.postRecord,
          operation,
          role: 'post',
          expectedHash: operation.stagedHash!,
        })
      : null;

  if (
    operation.type === 'write' &&
    !postRecord &&
    (await pathExists(cas.candidate)) &&
    (await pathExists(target))
  ) {
    const candidate = await captureStableArchiveFile({
      paths,
      file: cas.candidate,
      expectedHash: operation.stagedHash!,
      label: `Archive write candidate ${operation.target}`,
    });
    const current = await captureStableArchiveFile({
      paths,
      file: target,
      expectedHash: operation.stagedHash!,
      label: `Archive rollback target ${operation.target}`,
    });
    if (sameFileObject(candidate.identity, current.identity)) {
      postRecord = await persistCasRecord({
        paths,
        file: cas.postRecord,
        operation,
        role: 'post',
        expectedHash: operation.stagedHash!,
        identity: current.identity,
      });
    }
  }

  if (await pathExists(cas.rollbackQuarantine)) {
    if (!postRecord) {
      throw new Error(`Archive rollback quarantine ${operation.target} has no CAS identity`);
    }
    await validateFileAgainstCasRecord({
      paths,
      file: cas.rollbackQuarantine,
      operation,
      record: postRecord,
      label: `Archive rollback quarantine ${operation.target}`,
    });
  }

  if (await pathExists(target)) {
    const alreadyRestored =
      originalRecord !== null &&
      (await fileMatchesCasRecord({
        paths,
        file: target,
        operation,
        record: originalRecord,
        label: `Archive rollback target ${operation.target}`,
      }));
    if (!alreadyRestored) {
      if (!postRecord) {
        if (!originalRecord) {
          const actual = await inspectLoopArchiveContent(target);
          if (sameContent(actual, originalHash)) {
            await removeWriteCandidateIfPresent({ paths, journal, operation, target });
            return;
          }
        }
        throw new Error(
          `Archive rollback target ${operation.target} is occupied by an external object`,
        );
      }
      await quarantineBoundTarget({
        paths,
        operation,
        phase: 'rollback',
        target,
        quarantine: cas.rollbackQuarantine,
        record: postRecord,
        hooks,
      });
    }
  }

  if (originalHash === null) {
    if (await pathExists(target)) {
      throw new Error(`Archive rollback create target ${operation.target} could not be removed`);
    }
  } else if (!(await pathExists(target))) {
    if (!originalRecord || !(await pathExists(cas.originalQuarantine))) {
      throw new Error(
        `Archive rollback original target ${operation.target} cannot be recovered safely`,
      );
    }
    await installOriginalTarget({
      paths,
      operation,
      target,
      quarantine: cas.originalQuarantine,
      record: originalRecord,
      hooks,
    });
  }

  if (originalRecord && (await pathExists(cas.originalQuarantine))) {
    await removeExactCasFile({
      paths,
      file: cas.originalQuarantine,
      operation,
      record: originalRecord,
      label: `Archive rollback original quarantine ${operation.target}`,
    });
  }
  if (postRecord && (await pathExists(cas.rollbackQuarantine))) {
    await removeExactCasFile({
      paths,
      file: cas.rollbackQuarantine,
      operation,
      record: postRecord,
      label: `Archive rollback quarantine ${operation.target}`,
    });
  }
  await removeWriteCandidateIfPresent({ paths, journal, operation, target });
  await assertContent({
    target,
    expectedHash: originalHash,
    label: `Archive rollback target ${operation.target}`,
  });
}

async function rollbackMove(
  paths: LoopProjectPaths,
  operation: LoopArchiveTransactionOperationV2,
): Promise<void> {
  const source = await resolveRef(paths, operation.source!);
  const target = await resolveRef(paths, operation.target);
  const [sourceContent, targetContent] = await Promise.all([
    inspectLoopArchiveContent(source),
    inspectLoopArchiveContent(target),
  ]);
  if (
    sameContent(sourceContent, operation.expectedSourceHash!, 'directory') &&
    targetContent === null
  ) {
    return;
  }
  if (
    sourceContent !== null ||
    !sameContent(targetContent, operation.expectedSourceHash!, 'directory')
  ) {
    throw new Error(
      `Archive rollback move ${operation.id} content changed: source=${contentDescription(sourceContent)}, target=${contentDescription(targetContent)}`,
    );
  }
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.rename(target, source);
}

export async function rollbackLoopArchiveTransactionV2(
  paths: LoopProjectPaths,
  journal: LoopArchiveTransactionJournalV2,
  hooks?: LoopArchiveTransactionHooksV2,
): Promise<LoopArchiveTransactionJournalV2> {
  const events = await readLoopTransactionEvents(paths, journal.id);
  if (
    events.some(
      (event) =>
        event.type === 'archive-finalization-started' || event.type === 'archive-finalized',
    )
  ) {
    throw new Error('An archive whose finalization started can only be recovered by continuing it');
  }
  let current = await setStatus(paths, journal, 'rolling-back');
  await appendLoopTransactionEvent(paths, current.id, 'rollback-started');
  const started = new Set(
    events
      .filter((event) => event.type === 'operation-started' || event.type === 'operation-completed')
      .map((event) => event.operationId),
  );
  for (const operation of [...current.operations].reverse()) {
    if (!started.has(operation.id)) continue;
    if (operation.type === 'move') await rollbackMove(paths, operation);
    else await rollbackWriteOrRemove(paths, current, operation, hooks);
  }
  await appendLoopTransactionEvent(paths, current.id, 'rollback-completed');
  current = await setStatus(paths, current, 'rolled-back');
  return current;
}

async function assertCommittedArchiveCasTarget(
  paths: LoopProjectPaths,
  journal: LoopArchiveTransactionJournalV2,
  operation: LoopArchiveTransactionOperationV2,
): Promise<void> {
  const target = await resolveRef(paths, operation.target);
  if (operation.type === 'write') {
    const cas = await archiveCasPaths(paths, journal, operation, target);
    const postRecord = await readCasRecord({
      paths,
      file: cas.postRecord,
      operation,
      role: 'post',
      expectedHash: operation.stagedHash!,
    });
    if (!postRecord) {
      throw new Error(`Archive commit target ${operation.target} has no CAS identity`);
    }
    await validateFileAgainstCasRecord({
      paths,
      file: target,
      operation,
      record: postRecord,
      label: `Archive commit target ${operation.target}`,
    });
    return;
  }
  await assertContent({
    target,
    expectedHash: null,
    label: `Archive commit target ${operation.target}`,
  });
}

async function cleanupCommittedArchiveCas(
  paths: LoopProjectPaths,
  journal: LoopArchiveTransactionJournalV2,
): Promise<void> {
  for (const operation of journal.operations) {
    if (operation.type === 'move') continue;
    const target = await resolveRef(paths, operation.target);
    const cas = await archiveCasPaths(paths, journal, operation, target);
    if (await pathExists(cas.rollbackQuarantine)) {
      throw new Error(`Archive commit found an unfinished rollback for ${operation.target}`);
    }
    await assertCommittedArchiveCasTarget(paths, journal, operation);
    if (operation.expectedTargetHash !== null) {
      const originalRecord = await readCasRecord({
        paths,
        file: cas.originalRecord,
        operation,
        role: 'original',
        expectedHash: operation.expectedTargetHash,
      });
      if (!originalRecord) {
        throw new Error(`Archive commit target ${operation.target} has no original CAS identity`);
      }
      if (await pathExists(cas.originalQuarantine)) {
        await removeExactCasFile({
          paths,
          file: cas.originalQuarantine,
          operation,
          record: originalRecord,
          label: `Archive commit original quarantine ${operation.target}`,
        });
      }
    }
    await removeWriteCandidateIfPresent({ paths, journal, operation, target });
  }
  for (const operation of journal.operations) {
    if (operation.type !== 'move') {
      await assertCommittedArchiveCasTarget(paths, journal, operation);
    }
  }
}

export async function finalizeLoopArchiveTransactionV2(
  paths: LoopProjectPaths,
  journal: LoopArchiveTransactionJournalV2,
  event: 'archive-finalization-started' | 'archive-finalized' | 'commit',
): Promise<LoopArchiveTransactionJournalV2> {
  if (event === 'commit') await cleanupCommittedArchiveCas(paths, journal);
  await appendLoopTransactionEvent(paths, journal.id, event);
  return event === 'commit' ? setStatus(paths, journal, 'committed') : journal;
}

export function loopArchiveTransactionPaths(
  paths: LoopProjectPaths,
  id: string,
): ReturnType<typeof loopTransactionPaths> {
  return loopTransactionPaths(paths, id);
}
