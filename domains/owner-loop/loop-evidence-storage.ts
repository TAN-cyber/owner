import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { atomicWriteJson } from './loop-atomic-file.js';
import {
  loopChangeRuntimeDir,
  loopRuntimeRefFile,
  loopStorageRoot,
  resolveContainedLoopPath,
} from './loop-paths.js';
import { hasComparableLoopFileObject, sameLoopFileObject } from './loop-file-identity.js';
import type { LoopProjectPaths } from './loop-types.js';
import {
  parseLoopImplementationScopeBundle,
  parseLoopImplementationScope,
  parseLoopSnapshotProjection,
  rebuildLoopImplementationScopeBundle,
  MAX_LOOP_IMPLEMENTATION_EVIDENCE_DOCUMENT_BYTES,
  type LoopImplementationScopeBundle,
  type LoopImplementationScope,
  type LoopSnapshotProjection,
} from './loop-verification-scope.js';
import {
  parseLoopPartialAllowance,
  parseLoopVerificationEvidenceEnvelope,
  type LoopPartialAllowance,
  type LoopReadableVerificationEvidenceEnvelope,
  type LoopVerificationEvidenceEnvelope,
} from './loop-verification-evidence.js';
import {
  parseLoopVerificationReceipt,
  type LoopVerificationReceipt,
} from './loop-verification-receipt.js';

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
export const MAX_LOOP_EVIDENCE_DOCUMENT_BYTES = MAX_LOOP_IMPLEMENTATION_EVIDENCE_DOCUMENT_BYTES;
/** Retained for callers that size transient bundles; persistence is governed per document. */
export const MAX_LOOP_IMPLEMENTATION_SCOPE_BUNDLE_BYTES = 3 * MAX_LOOP_EVIDENCE_DOCUMENT_BYTES;

export type LoopEvidenceKind =
  | 'snapshots'
  | 'scopes'
  | 'allowances'
  | 'verifications'
  | 'reports'
  | 'receipts';

export interface LoopEvidenceReadHooks {
  afterParentChainCaptured?: () => void | Promise<void>;
  afterOpen?: () => void | Promise<void>;
  beforeFinalCheck?: () => void | Promise<void>;
}

export interface LoopVerificationAcceptanceCounts {
  total: number;
  evidenced: number;
  skipped: number;
}

interface DirectoryIdentity {
  path: string;
  realPath: string;
  dev: number;
  ino: number;
  birthtimeMs: number;
}

function isInside(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

function sameDirectoryIdentity(
  identity: DirectoryIdentity,
  stat: import('node:fs').Stats,
): boolean {
  return sameLoopFileObject(
    { ...identity, birthtime: identity.birthtimeMs },
    {
      ...stat,
      birthtime: stat.birthtimeMs,
    },
  );
}

function sameFileIdentity(left: import('node:fs').Stats, right: import('node:fs').Stats): boolean {
  const leftObject = { ...left, birthtime: left.birthtimeMs };
  const rightObject = { ...right, birthtime: right.birthtimeMs };
  if (hasComparableLoopFileObject(leftObject, rightObject)) {
    return sameLoopFileObject(leftObject, rightObject);
  }
  return (
    sameLoopFileObject(leftObject, rightObject) &&
    left.birthtimeMs === right.birthtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.size === right.size
  );
}

async function captureDirectoryIdentity(directory: string): Promise<DirectoryIdentity> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Loop evidence parent must be a real directory: ${directory}`);
  }
  return {
    path: directory,
    realPath: await fs.realpath(directory),
    dev: stat.dev,
    ino: stat.ino,
    birthtimeMs: stat.birthtimeMs,
  };
}

async function captureDirectoryChain(
  root: string,
  directory: string,
): Promise<DirectoryIdentity[]> {
  const lexicalRoot = path.resolve(root);
  const lexicalDirectory = path.resolve(directory);
  if (!isInside(lexicalRoot, lexicalDirectory)) {
    throw new Error('Loop evidence path is outside its change');
  }
  const chain = [await captureDirectoryIdentity(lexicalRoot)];
  let cursor = lexicalRoot;
  for (const segment of path
    .relative(lexicalRoot, lexicalDirectory)
    .split(path.sep)
    .filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const identity = await captureDirectoryIdentity(cursor);
    if (!isInside(chain[0].realPath, identity.realPath)) {
      throw new Error(`Loop evidence parent resolves outside its change: ${cursor}`);
    }
    chain.push(identity);
  }
  return chain;
}

async function verifyDirectoryChain(chain: readonly DirectoryIdentity[]): Promise<void> {
  for (const identity of chain) {
    const stat = await fs.lstat(identity.path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      !sameDirectoryIdentity(identity, stat) ||
      (await fs.realpath(identity.path)) !== identity.realPath
    ) {
      throw new Error(`Loop evidence parent changed while reading: ${identity.path}`);
    }
  }
}

async function readBoundedEvidenceJson(
  file: string,
  changeRoot: string,
  hooks: LoopEvidenceReadHooks = {},
): Promise<unknown> {
  const chain = await captureDirectoryChain(changeRoot, path.dirname(file));
  await hooks.afterParentChainCaptured?.();
  const lexical = await fs.lstat(file);
  if (!lexical.isFile() || lexical.isSymbolicLink()) {
    throw new Error('Loop evidence document must be a regular file');
  }
  const realPath = await fs.realpath(file);
  if (!isInside(chain[0].realPath, realPath)) {
    throw new Error('Loop evidence document resolves outside its change');
  }
  const handle = await fs.open(file, 'r');
  try {
    const [opened, pathAfterOpen, realPathAfterOpen] = await Promise.all([
      handle.stat(),
      fs.lstat(file),
      fs.realpath(file),
    ]);
    await verifyDirectoryChain(chain);
    if (
      !opened.isFile() ||
      !pathAfterOpen.isFile() ||
      pathAfterOpen.isSymbolicLink() ||
      realPathAfterOpen !== realPath ||
      !sameFileIdentity(opened, lexical) ||
      !sameFileIdentity(opened, pathAfterOpen)
    ) {
      throw new Error('Loop evidence document changed while opening');
    }
    if (opened.size > MAX_LOOP_EVIDENCE_DOCUMENT_BYTES) {
      throw new Error(`Loop evidence document exceeds ${MAX_LOOP_EVIDENCE_DOCUMENT_BYTES} bytes`);
    }
    await hooks.afterOpen?.();
    const chunks: Buffer[] = [];
    let total = 0;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const remaining = MAX_LOOP_EVIDENCE_DOCUMENT_BYTES + 1 - total;
      const read = await handle.read(buffer, 0, Math.min(buffer.length, remaining), null);
      if (read.bytesRead === 0) break;
      total += read.bytesRead;
      if (total > MAX_LOOP_EVIDENCE_DOCUMENT_BYTES) {
        throw new Error(`Loop evidence document exceeds ${MAX_LOOP_EVIDENCE_DOCUMENT_BYTES} bytes`);
      }
      chunks.push(Buffer.from(buffer.subarray(0, read.bytesRead)));
    }
    await hooks.beforeFinalCheck?.();
    const [afterHandle, afterPath, afterRealPath] = await Promise.all([
      handle.stat(),
      fs.lstat(file),
      fs.realpath(file),
    ]);
    await verifyDirectoryChain(chain);
    if (
      !afterPath.isFile() ||
      afterPath.isSymbolicLink() ||
      afterRealPath !== realPath ||
      !sameFileIdentity(opened, afterHandle) ||
      !sameFileIdentity(opened, afterPath)
    ) {
      throw new Error('Loop evidence document changed while reading');
    }
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as unknown;
  } finally {
    await handle.close();
  }
}

export function loopEvidenceRef(kind: LoopEvidenceKind, hash: string): string {
  if (!HASH_PATTERN.test(hash)) throw new Error('Loop evidence hash is invalid');
  return `runtime/evidence/${kind}/${hash}.json`;
}

export function loopReportEvidenceRef(hash: string): string {
  return loopEvidenceRef('reports', hash);
}

export async function writeLoopVerificationReportSnapshot(options: {
  paths: LoopProjectPaths;
  name: string;
  hash: string;
  text: string;
}): Promise<string> {
  const encoded = Buffer.from(options.text, 'utf8');
  if (
    encoded.byteLength > MAX_LOOP_EVIDENCE_DOCUMENT_BYTES ||
    createHash('sha256').update(encoded).digest('hex') !== options.hash
  ) {
    throw new Error('Loop verification report snapshot hash or size is invalid');
  }
  return writeEvidenceDocument({
    paths: options.paths,
    name: options.name,
    kind: 'reports',
    hash: options.hash,
    value: {
      schema: 'owner.loop.verification-report.v1',
      reportHash: options.hash,
      content: options.text,
    },
  });
}

export async function readLoopVerificationReportSnapshot(
  paths: LoopProjectPaths,
  name: string,
  hash: string,
  hooks?: LoopEvidenceReadHooks,
  changeDir?: string,
): Promise<string> {
  if (!HASH_PATTERN.test(hash)) throw new Error('Loop report evidence hash is invalid');
  const value = await readEvidenceDocument({
    paths,
    name,
    kind: 'reports',
    hash,
    hooks,
    changeDir,
  });
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Loop report evidence must be an object');
  }
  const report = value as Record<string, unknown>;
  if (
    Object.keys(report).sort().join(',') !== 'content,reportHash,schema' ||
    report.schema !== 'owner.loop.verification-report.v1' ||
    report.reportHash !== hash ||
    typeof report.content !== 'string' ||
    createHash('sha256').update(Buffer.from(report.content, 'utf8')).digest('hex') !== hash
  ) {
    throw new Error('Loop report evidence does not match its hash');
  }
  return report.content;
}

function parseEvidenceRef(ref: string, expectedKind: LoopEvidenceKind): string {
  const match =
    /^runtime\/evidence\/(snapshots|scopes|allowances|verifications|reports|receipts)\/([a-f0-9]{64})\.json$/u.exec(
      ref,
    );
  if (!match || match[1] !== expectedKind) {
    throw new Error(`Loop evidence ref is invalid for ${expectedKind}`);
  }
  return match[2];
}

function evidenceFile(
  paths: LoopProjectPaths,
  name: string,
  kind: LoopEvidenceKind,
  hash: string,
  changeDir?: string,
): string {
  const ref = loopEvidenceRef(kind, hash);
  return changeDir
    ? path.join(changeDir, ...ref.split('/'))
    : loopRuntimeRefFile(loopChangeRuntimeDir(paths, name), ref);
}

async function readEvidenceDocument(options: {
  paths: LoopProjectPaths;
  name: string;
  kind: LoopEvidenceKind;
  hash: string;
  hooks?: LoopEvidenceReadHooks;
  changeDir?: string;
}): Promise<unknown> {
  const file = evidenceFile(
    options.paths,
    options.name,
    options.kind,
    options.hash,
    options.changeDir,
  );
  const storageRoot = options.changeDir ?? loopStorageRoot(options.paths, file);
  await resolveContainedLoopPath(storageRoot, file);
  return readBoundedEvidenceJson(file, storageRoot, options.hooks);
}

async function writeEvidenceDocument(options: {
  paths: LoopProjectPaths;
  name: string;
  kind: LoopEvidenceKind;
  hash: string;
  value: unknown;
}): Promise<string> {
  assertEvidenceDocumentBudget(options.value);
  const file = evidenceFile(options.paths, options.name, options.kind, options.hash);
  const storageRoot = loopStorageRoot(options.paths, file);
  await resolveContainedLoopPath(storageRoot, file);
  try {
    const existing = await readEvidenceDocument(options);
    if (JSON.stringify(existing) !== JSON.stringify(options.value)) {
      throw new Error(`Loop evidence hash collision for ${options.hash}`);
    }
    return loopEvidenceRef(options.kind, options.hash);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await atomicWriteJson(file, options.value, { containedRoot: storageRoot });
  const persisted = await readEvidenceDocument(options);
  if (JSON.stringify(persisted) !== JSON.stringify(options.value)) {
    throw new Error(`Loop evidence changed during commit for ${options.hash}`);
  }
  return loopEvidenceRef(options.kind, options.hash);
}

function assertEvidenceDocumentBudget(value: unknown): void {
  if (serializedEvidenceBytes(value) > MAX_LOOP_EVIDENCE_DOCUMENT_BYTES) {
    throw new Error(`Loop evidence document exceeds ${MAX_LOOP_EVIDENCE_DOCUMENT_BYTES} bytes`);
  }
}

function serializedEvidenceBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function parseSnapshot(value: unknown, expectedHash: string): LoopSnapshotProjection {
  return parseLoopSnapshotProjection(value, expectedHash);
}

function parseScope(value: unknown, expectedHash: string): LoopImplementationScope {
  const scope = parseLoopImplementationScope(value);
  if (scope.scopeHash !== expectedHash) {
    throw new Error('Loop implementation scope ref/hash mismatch');
  }
  return scope;
}

function parseAllowance(
  value: unknown,
  expectedName: string,
  expectedHash: string,
): LoopPartialAllowance {
  const allowance = parseLoopPartialAllowance(value);
  if (allowance.change !== expectedName || allowance.allowanceHash !== expectedHash) {
    throw new Error('Loop partial allowance ref/hash/change mismatch');
  }
  return allowance;
}

function parseEnvelope(
  value: unknown,
  expectedName: string,
  expectedHash: string,
): LoopReadableVerificationEvidenceEnvelope {
  const evidence = parseLoopVerificationEvidenceEnvelope(value);
  if (evidence.change !== expectedName || evidence.envelopeHash !== expectedHash) {
    throw new Error('Loop verification evidence ref/hash/change mismatch');
  }
  return evidence;
}

function acceptanceCounts(trace: {
  total: number;
  evidenced: number;
  skipped: number;
}): LoopVerificationAcceptanceCounts {
  return {
    total: trace.total,
    evidenced: trace.evidenced,
    skipped: trace.skipped,
  };
}

function parseLegacyArchivedAcceptanceCounts(
  value: unknown,
  expectedName: string,
  expectedHash: string,
): LoopVerificationAcceptanceCounts | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  if (envelope.schema !== 'owner.loop.verification-evidence.v1') return null;
  if (envelope.change !== expectedName || envelope.envelopeHash !== expectedHash) {
    throw new Error('Legacy Loop verification evidence ref/hash/change mismatch');
  }
  const trace = envelope.acceptanceTrace;
  if (!trace || typeof trace !== 'object' || Array.isArray(trace)) {
    throw new Error('Legacy Loop acceptance trace is invalid');
  }
  const counts = trace as Record<string, unknown>;
  const { total, evidenced, skipped } = counts;
  const totalCount = typeof total === 'number' ? total : Number.NaN;
  const evidencedCount = typeof evidenced === 'number' ? evidenced : Number.NaN;
  const skippedCount = typeof skipped === 'number' ? skipped : Number.NaN;
  if (
    counts.schema !== 'owner.loop.acceptance-trace.v1' ||
    !Number.isSafeInteger(totalCount) ||
    !Number.isSafeInteger(evidencedCount) ||
    !Number.isSafeInteger(skippedCount) ||
    totalCount < 0 ||
    evidencedCount < 0 ||
    skippedCount < 0 ||
    evidencedCount + skippedCount > totalCount
  ) {
    throw new Error('Legacy Loop acceptance trace is invalid');
  }
  return { total: totalCount, evidenced: evidencedCount, skipped: skippedCount };
}

async function assertEnvelopeDependencies(
  paths: LoopProjectPaths,
  name: string,
  evidence: LoopReadableVerificationEvidenceEnvelope,
  requireReportSnapshot = false,
  changeDir?: string,
): Promise<void> {
  const scope = await readLoopImplementationScope(
    paths,
    name,
    evidence.implementationScopeRef,
    undefined,
    changeDir,
  );
  if (requireReportSnapshot) {
    await readLoopVerificationReportSnapshot(
      paths,
      name,
      evidence.reportHash,
      undefined,
      changeDir,
    );
  }
  if (
    scope.scopeHash !== evidence.implementationScopeHash ||
    scope.contractHash !== evidence.contractHash ||
    (scope.complete ? 'complete' : 'partial') !== evidence.freshness
  ) {
    throw new Error('Loop verification evidence does not match its implementation scope');
  }
  if (evidence.partialAllowanceRef === null) return;
  const allowance = await readLoopPartialAllowance(
    paths,
    name,
    evidence.partialAllowanceRef,
    undefined,
    changeDir,
  );
  if (
    allowance.allowanceHash !== evidence.partialAllowanceHash ||
    allowance.scopeHash !== scope.scopeHash ||
    JSON.stringify(allowance.scopeIds) !==
      JSON.stringify(scope.unresolvedScopes.map((entry) => entry.id).sort()) ||
    allowance.sourceRevision >= evidence.sourceRevision
  ) {
    throw new Error('Loop verification evidence does not match its partial allowance');
  }
}

export async function writeLoopImplementationScope(options: {
  paths: LoopProjectPaths;
  name: string;
  bundle: LoopImplementationScopeBundle;
}): Promise<string> {
  const bundle = parseLoopImplementationScopeBundle(options.bundle);
  const { baseline, current, scope } = bundle;
  assertEvidenceDocumentBudget(baseline);
  assertEvidenceDocumentBudget(current);
  assertEvidenceDocumentBudget(scope);
  await writeEvidenceDocument({
    paths: options.paths,
    name: options.name,
    kind: 'snapshots',
    hash: scope.baselineProjectionHash,
    value: baseline,
  });
  await writeEvidenceDocument({
    paths: options.paths,
    name: options.name,
    kind: 'snapshots',
    hash: scope.currentProjectionHash,
    value: current,
  });
  return writeEvidenceDocument({
    paths: options.paths,
    name: options.name,
    kind: 'scopes',
    hash: scope.scopeHash,
    value: scope,
  });
}

export async function readLoopImplementationScopeBundle(
  paths: LoopProjectPaths,
  name: string,
  ref: string,
  hooks?: LoopEvidenceReadHooks,
  changeDir?: string,
): Promise<LoopImplementationScopeBundle> {
  const hash = parseEvidenceRef(ref, 'scopes');
  const scope = parseScope(
    await readEvidenceDocument({ paths, name, kind: 'scopes', hash, hooks, changeDir }),
    hash,
  );
  const baselineHash = parseEvidenceRef(scope.baselineProjectionRef, 'snapshots');
  const currentHash = parseEvidenceRef(scope.currentProjectionRef, 'snapshots');
  const [baseline, current] = await Promise.all([
    readEvidenceDocument({ paths, name, kind: 'snapshots', hash: baselineHash, changeDir }).then(
      (value) => parseSnapshot(value, baselineHash),
    ),
    readEvidenceDocument({ paths, name, kind: 'snapshots', hash: currentHash, changeDir }).then(
      (value) => parseSnapshot(value, currentHash),
    ),
  ]);
  return rebuildLoopImplementationScopeBundle({ baseline, current, scope });
}

export async function readLoopImplementationScope(
  paths: LoopProjectPaths,
  name: string,
  ref: string,
  hooks?: LoopEvidenceReadHooks,
  changeDir?: string,
): Promise<LoopImplementationScope> {
  return (await readLoopImplementationScopeBundle(paths, name, ref, hooks, changeDir)).scope;
}

export async function writeLoopPartialAllowance(options: {
  paths: LoopProjectPaths;
  name: string;
  allowance: LoopPartialAllowance;
}): Promise<string> {
  const allowance = parseAllowance(
    options.allowance,
    options.name,
    options.allowance.allowanceHash,
  );
  const scope = await readLoopImplementationScope(
    options.paths,
    options.name,
    loopEvidenceRef('scopes', allowance.scopeHash),
  );
  const unresolvedScopeIds = scope.unresolvedScopes.map((entry) => entry.id).sort();
  if (scope.complete || JSON.stringify(unresolvedScopeIds) !== JSON.stringify(allowance.scopeIds)) {
    throw new Error('Loop partial allowance does not match a persisted partial scope');
  }
  return writeEvidenceDocument({
    ...options,
    kind: 'allowances',
    hash: allowance.allowanceHash,
    value: allowance,
  });
}

export async function readLoopPartialAllowance(
  paths: LoopProjectPaths,
  name: string,
  ref: string,
  hooks?: LoopEvidenceReadHooks,
  changeDir?: string,
): Promise<LoopPartialAllowance> {
  const hash = parseEvidenceRef(ref, 'allowances');
  return parseAllowance(
    await readEvidenceDocument({ paths, name, kind: 'allowances', hash, hooks, changeDir }),
    name,
    hash,
  );
}

export async function writeLoopVerificationReceipt(options: {
  paths: LoopProjectPaths;
  name: string;
  receipt: LoopVerificationReceipt;
}): Promise<string> {
  const receipt = parseLoopVerificationReceipt(options.receipt);
  if (receipt.bindings.change !== options.name) {
    throw new Error('Loop verification receipt change mismatch');
  }
  return writeEvidenceDocument({
    paths: options.paths,
    name: options.name,
    kind: 'receipts',
    hash: receipt.receiptHash,
    value: receipt,
  });
}

export async function readLoopVerificationReceipt(
  paths: LoopProjectPaths,
  name: string,
  ref: string,
  hooks?: LoopEvidenceReadHooks,
  changeDir?: string,
): Promise<LoopVerificationReceipt> {
  const hash = parseEvidenceRef(ref, 'receipts');
  const receipt = parseLoopVerificationReceipt(
    await readEvidenceDocument({ paths, name, kind: 'receipts', hash, hooks, changeDir }),
  );
  if (receipt.bindings.change !== name || receipt.receiptHash !== hash) {
    throw new Error('Loop verification receipt ref/hash/change mismatch');
  }
  return receipt;
}

/**
 * List persisted typed receipt refs without trusting arbitrary directory names.
 * Callers still read each document through readLoopVerificationReceipt, which
 * performs the full bounded and symlink-safe validation.
 */
export async function listLoopVerificationReceiptRefs(
  paths: LoopProjectPaths,
  name: string,
): Promise<string[]> {
  const directory = path.join(loopChangeRuntimeDir(paths, name), 'evidence', 'receipts');
  await resolveContainedLoopPath(loopStorageRoot(paths, directory), directory);
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => /^([a-f0-9]{64})\.json$/u.exec(entry.name)?.[1])
    .filter((hash): hash is string => hash !== undefined)
    .sort()
    .map((hash) => loopEvidenceRef('receipts', hash));
}

export async function writeLoopVerificationEvidence(options: {
  paths: LoopProjectPaths;
  name: string;
  evidence: LoopVerificationEvidenceEnvelope;
}): Promise<string> {
  const evidence = parseEnvelope(options.evidence, options.name, options.evidence.envelopeHash);
  if (evidence.schema !== 'owner.loop.verification-evidence.v2') {
    throw new Error('Loop active verification evidence must use v2');
  }
  await assertEnvelopeDependencies(options.paths, options.name, evidence, true);
  return writeEvidenceDocument({
    ...options,
    kind: 'verifications',
    hash: evidence.envelopeHash,
    value: evidence,
  });
}

export async function readLoopVerificationEvidence(
  paths: LoopProjectPaths,
  name: string,
  ref: string,
  hooks?: LoopEvidenceReadHooks,
  changeDir?: string,
): Promise<LoopReadableVerificationEvidenceEnvelope> {
  const hash = parseEvidenceRef(ref, 'verifications');
  const evidence = parseEnvelope(
    await readEvidenceDocument({ paths, name, kind: 'verifications', hash, hooks, changeDir }),
    name,
    hash,
  );
  await assertEnvelopeDependencies(paths, name, evidence, false, changeDir);
  return evidence;
}

/**
 * Reads the compact acceptance counters for an archived change. Archived v1
 * envelopes predate the current receipt-bound v2 parser, but still carry their
 * immutable acceptance trace and must remain visible in read-only status output.
 */
export async function readArchivedLoopVerificationAcceptanceCounts(
  paths: LoopProjectPaths,
  name: string,
  ref: string,
  changeDir: string,
): Promise<LoopVerificationAcceptanceCounts> {
  const hash = parseEvidenceRef(ref, 'verifications');
  const value = await readEvidenceDocument({
    paths,
    name,
    kind: 'verifications',
    hash,
    changeDir,
  });
  const legacy = parseLegacyArchivedAcceptanceCounts(value, name, hash);
  if (legacy) return legacy;
  const evidence = parseEnvelope(value, name, hash);
  await assertEnvelopeDependencies(paths, name, evidence, false, changeDir);
  return acceptanceCounts(evidence.acceptanceTrace);
}
