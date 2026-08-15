import path from 'path';

import { atomicWriteJson } from './loop-atomic-file.js';
import { parseLoopChangeValue } from './loop-change.js';
import { sha256Text } from './loop-hash.js';
import {
  isInsidePath,
  loopChangeRuntimeDir,
  loopStorageRoot,
  resolveContainedLoopPath,
} from './loop-paths.js';
import { readLoopProtectedFile } from './loop-protected-file.js';
import {
  loopSensitiveArtifactReason,
  loopSensitiveRelativePathReason,
} from './loop-sensitive-paths.js';
import { redactLoopCredentialText } from './loop-redaction.js';
import type {
  LoopCheckpointArtifact,
  LoopCheckpointJournal,
  LoopCheckpointManifest,
  LoopFinding,
  LoopProgressCheckpoint,
  LoopProjectPaths,
} from './loop-types.js';

export const LOOP_CHECKPOINT_LIMITS = {
  maxArtifacts: 128,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxDocumentBytes: 256 * 1024,
} as const;

const HASH_PATTERN = /^[a-f0-9]{64}$/u;

export interface LoopCheckpointArtifactReadHooks {
  afterParentChainCaptured?: (artifactRef: string) => void | Promise<void>;
  afterOpen?: (artifactRef: string) => void | Promise<void>;
  beforeRead?: (artifactRef: string) => void | Promise<void>;
}

export interface LoopCheckpointManifestWriteHooks {
  beforeCommit?: () => void | Promise<void>;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  const missing = keys.filter((key) => !(key in value));
  if (unknown.length > 0) throw new Error(`${label} has unknown field(s): ${unknown.join(', ')}`);
  if (missing.length > 0) throw new Error(`${label} is missing field(s): ${missing.join(', ')}`);
}

function stringValue(value: unknown, label: string, max = 2_000): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new Error(`${label} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value as number;
}

export function normalizeLoopCheckpointArtifactRef(value: string): string {
  const trimmed = value.trim().replaceAll('\\', '/');
  if (
    trimmed.length === 0 ||
    path.isAbsolute(trimmed) ||
    /^(?:[A-Za-z]:|~|\/)/u.test(trimmed) ||
    trimmed.split('/').includes('..')
  ) {
    throw new Error(`Checkpoint artifact must be project-relative: ${value}`);
  }
  const normalized = path.posix.normalize(trimmed);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Checkpoint artifact must name a project file: ${value}`);
  }
  return normalized;
}

export function loopProgressCheckpointFile(paths: LoopProjectPaths, name: string): string {
  return path.join(loopChangeRuntimeDir(paths, name), 'checkpoints', 'progress.json');
}

export function loopCheckpointJournalFile(paths: LoopProjectPaths, name: string): string {
  return path.join(loopChangeRuntimeDir(paths, name), 'checkpoint-journal.json');
}

export function loopCheckpointManifestFile(
  paths: LoopProjectPaths,
  name: string,
  hash: string,
): string {
  if (!HASH_PATTERN.test(hash)) throw new Error('Loop checkpoint manifest hash is invalid');
  return path.join(loopChangeRuntimeDir(paths, name), 'checkpoints', 'manifests', `${hash}.json`);
}

export function loopCheckpointManifestRef(hash: string): string {
  if (!HASH_PATTERN.test(hash)) throw new Error('Loop checkpoint manifest hash is invalid');
  return `runtime/checkpoints/manifests/${hash}.json`;
}

async function readBoundedJson(root: string, file: string, label: string): Promise<unknown> {
  const snapshot = await readLoopProtectedFile({
    root,
    file,
    maxBytes: LOOP_CHECKPOINT_LIMITS.maxDocumentBytes,
    label,
  });
  return JSON.parse(snapshot.bytes.toString('utf8')) as unknown;
}

function parseArtifact(value: unknown, index: number): LoopCheckpointArtifact {
  const artifact = record(value, `checkpoint manifest artifact ${index}`);
  exactKeys(artifact, ['path', 'hash', 'size'], `checkpoint manifest artifact ${index}`);
  const artifactPath = normalizeLoopCheckpointArtifactRef(
    stringValue(artifact.path, `checkpoint artifact ${index} path`, 4_096),
  );
  const sensitiveReason = loopSensitiveRelativePathReason(artifactPath);
  if (sensitiveReason) {
    throw new Error(
      `checkpoint artifact ${index} is excluded as sensitive (${sensitiveReason}): ${artifactPath}`,
    );
  }
  if (typeof artifact.hash !== 'string' || !HASH_PATTERN.test(artifact.hash)) {
    throw new Error(`checkpoint artifact ${index} hash is invalid`);
  }
  return {
    path: artifactPath,
    hash: artifact.hash,
    size: nonNegativeInteger(artifact.size, `checkpoint artifact ${index} size`),
  };
}

export function parseLoopCheckpointManifestValue(
  value: unknown,
  expectedName: string,
): LoopCheckpointManifest {
  const manifest = record(value, 'Loop checkpoint manifest');
  exactKeys(manifest, ['schema', 'change', 'artifacts', 'totalBytes'], 'Loop checkpoint manifest');
  if (manifest.schema !== 'owner.loop.checkpoint-manifest.v1') {
    throw new Error('Loop checkpoint manifest schema is invalid');
  }
  if (manifest.change !== expectedName) throw new Error('Loop checkpoint manifest change mismatch');
  if (!Array.isArray(manifest.artifacts)) {
    throw new Error('Loop checkpoint manifest artifacts must be an array');
  }
  if (manifest.artifacts.length > LOOP_CHECKPOINT_LIMITS.maxArtifacts) {
    throw new Error('Loop checkpoint manifest has too many artifacts');
  }
  const artifacts = manifest.artifacts.map(parseArtifact);
  const sorted = [...artifacts].sort((left, right) => left.path.localeCompare(right.path));
  if (JSON.stringify(artifacts) !== JSON.stringify(sorted)) {
    throw new Error('Loop checkpoint manifest artifacts must be sorted');
  }
  if (new Set(artifacts.map((artifact) => artifact.path)).size !== artifacts.length) {
    throw new Error('Loop checkpoint manifest has duplicate artifacts');
  }
  const totalBytes = nonNegativeInteger(manifest.totalBytes, 'checkpoint manifest totalBytes');
  if (artifacts.reduce((total, artifact) => total + artifact.size, 0) !== totalBytes) {
    throw new Error('Loop checkpoint manifest totalBytes mismatch');
  }
  if (totalBytes > LOOP_CHECKPOINT_LIMITS.maxTotalBytes) {
    throw new Error('Loop checkpoint manifest totalBytes exceeds its budget');
  }
  return {
    schema: 'owner.loop.checkpoint-manifest.v1',
    change: expectedName,
    artifacts,
    totalBytes,
  };
}

export function hashLoopCheckpointManifest(manifest: LoopCheckpointManifest): string {
  return sha256Text(JSON.stringify(parseLoopCheckpointManifestValue(manifest, manifest.change)));
}

export function parseLoopProgressCheckpointValue(
  value: unknown,
  expectedName: string,
): LoopProgressCheckpoint {
  const checkpoint = record(value, 'Loop progress checkpoint');
  exactKeys(
    checkpoint,
    [
      'schema',
      'id',
      'change',
      'phase',
      'previousRevision',
      'stateRevision',
      'summary',
      'nextAction',
      'inputHash',
      'manifestHash',
      'manifestRef',
      'artifactCount',
      'createdAt',
    ],
    'Loop progress checkpoint',
  );
  if (checkpoint.schema !== 'owner.loop.progress-checkpoint.v1') {
    throw new Error('Loop progress checkpoint schema is invalid');
  }
  if (checkpoint.change !== expectedName) throw new Error('Loop checkpoint change mismatch');
  const phase = checkpoint.phase;
  if (phase !== 'shape' && phase !== 'build' && phase !== 'verify' && phase !== 'archive') {
    throw new Error('Loop checkpoint phase is invalid');
  }
  const previousRevision = positiveInteger(
    checkpoint.previousRevision,
    'Loop checkpoint previousRevision',
  );
  const stateRevision = positiveInteger(checkpoint.stateRevision, 'Loop checkpoint stateRevision');
  if (stateRevision !== previousRevision + 1) {
    throw new Error('Loop checkpoint stateRevision must increment previousRevision once');
  }
  const manifestHash = stringValue(checkpoint.manifestHash, 'Loop checkpoint manifestHash', 64);
  if (!HASH_PATTERN.test(manifestHash)) throw new Error('Loop checkpoint manifestHash is invalid');
  const expectedManifestRef = loopCheckpointManifestRef(manifestHash);
  if (checkpoint.manifestRef !== expectedManifestRef) {
    throw new Error('Loop checkpoint manifestRef does not match manifestHash');
  }
  const inputHash = stringValue(checkpoint.inputHash, 'Loop checkpoint inputHash', 64);
  if (!HASH_PATTERN.test(inputHash)) throw new Error('Loop checkpoint inputHash is invalid');
  const createdAt = stringValue(checkpoint.createdAt, 'Loop checkpoint createdAt', 64);
  if (Number.isNaN(Date.parse(createdAt))) throw new Error('Loop checkpoint createdAt is invalid');
  const artifactCount = nonNegativeInteger(
    checkpoint.artifactCount,
    'Loop checkpoint artifactCount',
  );
  if (artifactCount > LOOP_CHECKPOINT_LIMITS.maxArtifacts) {
    throw new Error('Loop checkpoint artifactCount exceeds its budget');
  }
  const summary = stringValue(checkpoint.summary, 'Loop checkpoint summary');
  const nextAction = stringValue(checkpoint.nextAction, 'Loop checkpoint nextAction');
  if (
    redactLoopCredentialText(summary) !== summary ||
    redactLoopCredentialText(nextAction) !== nextAction
  ) {
    throw new Error('Loop checkpoint text contains unredacted credential material');
  }
  return {
    schema: 'owner.loop.progress-checkpoint.v1',
    id: stringValue(checkpoint.id, 'Loop checkpoint id', 128),
    change: expectedName,
    phase,
    previousRevision,
    stateRevision,
    summary,
    nextAction,
    inputHash,
    manifestHash,
    manifestRef: expectedManifestRef,
    artifactCount,
    createdAt,
  };
}

export function parseLoopCheckpointJournalValue(
  value: unknown,
  expectedName: string,
): LoopCheckpointJournal {
  const journal = record(value, 'Loop checkpoint journal');
  exactKeys(
    journal,
    [
      'schema',
      'id',
      'change',
      'inputHash',
      'createdAt',
      'previousState',
      'nextState',
      'checkpoint',
      'manifest',
    ],
    'Loop checkpoint journal',
  );
  if (journal.schema !== 'owner.loop.checkpoint-journal.v1') {
    throw new Error('Loop checkpoint journal schema is invalid');
  }
  if (journal.change !== expectedName) throw new Error('Loop checkpoint journal change mismatch');
  const previousState = parseLoopChangeValue(journal.previousState);
  const nextState = parseLoopChangeValue(journal.nextState);
  const checkpoint = parseLoopProgressCheckpointValue(journal.checkpoint, expectedName);
  const manifest = parseLoopCheckpointManifestValue(journal.manifest, expectedName);
  const inputHash = stringValue(journal.inputHash, 'Loop checkpoint journal inputHash', 64);
  const expectedInputHash = sha256Text(
    JSON.stringify({
      summary: checkpoint.summary,
      nextAction: checkpoint.nextAction,
      artifacts: manifest.artifacts,
    }),
  );
  if (
    !HASH_PATTERN.test(inputHash) ||
    inputHash !== checkpoint.inputHash ||
    inputHash !== expectedInputHash ||
    journal.id !== checkpoint.id ||
    journal.createdAt !== checkpoint.createdAt
  ) {
    throw new Error('Loop checkpoint journal envelope mismatch');
  }
  if (
    previousState.name !== expectedName ||
    nextState.name !== expectedName ||
    nextState.revision !== previousState.revision + 1 ||
    checkpoint.previousRevision !== previousState.revision ||
    checkpoint.stateRevision !== nextState.revision ||
    checkpoint.phase !== nextState.phase ||
    checkpoint.manifestHash !== hashLoopCheckpointManifest(manifest) ||
    checkpoint.artifactCount !== manifest.artifacts.length
  ) {
    throw new Error('Loop checkpoint journal state mismatch');
  }
  return {
    schema: 'owner.loop.checkpoint-journal.v1',
    id: checkpoint.id,
    change: expectedName,
    inputHash,
    createdAt: checkpoint.createdAt,
    previousState,
    nextState,
    checkpoint,
    manifest,
  };
}

async function hashProjectArtifact(
  paths: LoopProjectPaths,
  artifactRef: string,
  hooks?: LoopCheckpointArtifactReadHooks,
): Promise<LoopCheckpointArtifact> {
  const target = path.resolve(paths.projectRoot, ...artifactRef.split('/'));
  if (
    !isInsidePath(paths.projectRoot, target) ||
    isInsidePath(paths.loopRoot, target) ||
    isInsidePath(paths.runtimeDir, target)
  ) {
    throw new Error(`Checkpoint artifact is outside project content: ${artifactRef}`);
  }
  const sensitiveReason = loopSensitiveArtifactReason(paths, artifactRef);
  if (sensitiveReason) {
    throw new Error(
      `Checkpoint artifact is excluded as sensitive (${sensitiveReason}): ${artifactRef}`,
    );
  }
  const snapshot = await readLoopProtectedFile({
    root: paths.projectRoot,
    file: target,
    maxBytes: LOOP_CHECKPOINT_LIMITS.maxFileBytes,
    label: `Checkpoint artifact ${artifactRef}`,
    forbiddenRoots: [paths.loopRoot, paths.runtimeDir],
    hooks: {
      afterParentChainCaptured: () => hooks?.afterParentChainCaptured?.(artifactRef),
      afterOpen: () => hooks?.afterOpen?.(artifactRef),
      beforeRead: () => hooks?.beforeRead?.(artifactRef),
    },
  });
  return { path: artifactRef, hash: snapshot.hash, size: snapshot.size };
}

export async function createLoopCheckpointManifest(
  paths: LoopProjectPaths,
  name: string,
  artifactRefs: readonly string[],
  hooks?: LoopCheckpointArtifactReadHooks,
): Promise<LoopCheckpointManifest> {
  const normalized = artifactRefs.map(normalizeLoopCheckpointArtifactRef).sort();
  if (normalized.length > LOOP_CHECKPOINT_LIMITS.maxArtifacts) {
    throw new Error(`Checkpoint supports at most ${LOOP_CHECKPOINT_LIMITS.maxArtifacts} artifacts`);
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('Checkpoint artifacts must not contain duplicates');
  }
  const artifacts: LoopCheckpointArtifact[] = [];
  let totalBytes = 0;
  for (const artifactRef of normalized) {
    const artifact = await hashProjectArtifact(paths, artifactRef, hooks);
    totalBytes += artifact.size;
    if (totalBytes > LOOP_CHECKPOINT_LIMITS.maxTotalBytes) {
      throw new Error('Checkpoint artifacts exceed the total byte budget');
    }
    artifacts.push(artifact);
  }
  return {
    schema: 'owner.loop.checkpoint-manifest.v1',
    change: name,
    artifacts,
    totalBytes,
  };
}

export async function readLoopProgressCheckpoint(
  paths: LoopProjectPaths,
  name: string,
): Promise<LoopProgressCheckpoint | null> {
  const file = loopProgressCheckpointFile(paths, name);
  const storageRoot = loopStorageRoot(paths, file);
  await resolveContainedLoopPath(storageRoot, file);
  try {
    return parseLoopProgressCheckpointValue(
      await readBoundedJson(storageRoot, file, 'Loop progress checkpoint'),
      name,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function readLoopCheckpointManifest(
  paths: LoopProjectPaths,
  name: string,
  hash: string,
): Promise<LoopCheckpointManifest> {
  const file = loopCheckpointManifestFile(paths, name, hash);
  const storageRoot = loopStorageRoot(paths, file);
  await resolveContainedLoopPath(storageRoot, file);
  const value = await readBoundedJson(storageRoot, file, 'Loop checkpoint manifest');
  const manifest = parseLoopCheckpointManifestValue(value, name);
  assertCheckpointManifestSafeForPaths(paths, manifest);
  if (hashLoopCheckpointManifest(manifest) !== hash) {
    throw new Error('Loop checkpoint manifest content hash mismatch');
  }
  return manifest;
}

export async function readLoopCheckpointJournal(
  paths: LoopProjectPaths,
  name: string,
): Promise<LoopCheckpointJournal | null> {
  const file = loopCheckpointJournalFile(paths, name);
  const storageRoot = loopStorageRoot(paths, file);
  await resolveContainedLoopPath(storageRoot, file);
  try {
    const journal = parseLoopCheckpointJournalValue(
      await readBoundedJson(storageRoot, file, 'Loop checkpoint journal'),
      name,
    );
    assertCheckpointManifestSafeForPaths(paths, journal.manifest);
    return journal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeLoopCheckpointManifest(
  paths: LoopProjectPaths,
  name: string,
  manifest: LoopCheckpointManifest,
  hooks?: LoopCheckpointManifestWriteHooks,
): Promise<string> {
  const parsed = parseLoopCheckpointManifestValue(manifest, name);
  assertCheckpointManifestSafeForPaths(paths, parsed);
  const hash = hashLoopCheckpointManifest(parsed);
  const file = loopCheckpointManifestFile(paths, name, hash);
  const storageRoot = loopStorageRoot(paths, file);
  await resolveContainedLoopPath(storageRoot, file);
  try {
    const existing = await readLoopCheckpointManifest(paths, name, hash);
    if (JSON.stringify(existing) !== JSON.stringify(parsed)) {
      throw new Error('Loop checkpoint manifest hash collision');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // Commit through the protected boundary even when identical content already
  // exists. Otherwise an internal parent symlink could bypass the write-time
  // directory-chain validation through the read-only idempotent branch.
  await atomicWriteJson(file, parsed, {
    containedRoot: storageRoot,
    beforeCommit: hooks?.beforeCommit,
  });
  return hash;
}

function assertCheckpointManifestSafeForPaths(
  paths: LoopProjectPaths,
  manifest: LoopCheckpointManifest,
): void {
  for (const artifact of manifest.artifacts) {
    const reason = loopSensitiveArtifactReason(paths, artifact.path);
    if (reason) {
      throw new Error(
        `Loop checkpoint manifest contains a sensitive artifact (${reason}): ${artifact.path}`,
      );
    }
  }
}

export async function writeLoopProgressCheckpoint(
  paths: LoopProjectPaths,
  checkpoint: LoopProgressCheckpoint,
): Promise<void> {
  const parsed = parseLoopProgressCheckpointValue(checkpoint, checkpoint.change);
  const manifest = await readLoopCheckpointManifest(paths, parsed.change, parsed.manifestHash);
  const expectedInputHash = sha256Text(
    JSON.stringify({
      summary: parsed.summary,
      nextAction: parsed.nextAction,
      artifacts: manifest.artifacts,
    }),
  );
  if (
    parsed.inputHash !== expectedInputHash ||
    parsed.artifactCount !== manifest.artifacts.length
  ) {
    throw new Error('Loop progress checkpoint does not match its artifact manifest');
  }
  const file = loopProgressCheckpointFile(paths, checkpoint.change);
  const storageRoot = loopStorageRoot(paths, file);
  await resolveContainedLoopPath(storageRoot, file);
  await atomicWriteJson(file, parsed, { containedRoot: storageRoot });
}

export async function writeLoopCheckpointJournal(
  paths: LoopProjectPaths,
  journal: LoopCheckpointJournal,
): Promise<void> {
  const parsed = parseLoopCheckpointJournalValue(journal, journal.change);
  const file = loopCheckpointJournalFile(paths, journal.change);
  const storageRoot = loopStorageRoot(paths, file);
  await resolveContainedLoopPath(storageRoot, file);
  if (await readLoopCheckpointJournal(paths, journal.change)) {
    throw new Error(`Loop checkpoint recovery is already pending for ${journal.change}`);
  }
  await atomicWriteJson(file, parsed, { containedRoot: storageRoot });
}

export async function inspectLoopCheckpointFreshness(options: {
  paths: LoopProjectPaths;
  name: string;
  stateRevision: number;
}): Promise<{
  checkpoint: LoopProgressCheckpoint | null;
  manifest: LoopCheckpointManifest | null;
  freshness: 'fresh' | 'stale';
  reasons: string[];
  findings: LoopFinding[];
}> {
  let checkpoint: LoopProgressCheckpoint | null;
  try {
    checkpoint = await readLoopProgressCheckpoint(options.paths, options.name);
  } catch (error) {
    return {
      checkpoint: null,
      manifest: null,
      freshness: 'stale',
      reasons: ['checkpoint-progress-invalid'],
      findings: [
        {
          code: 'checkpoint-progress-invalid',
          message: `Loop progress checkpoint is invalid: ${(error as Error).message}. Automatic repair is unavailable; inspect and move the invalid checkpoint file aside before retrying`,
          path: loopProgressCheckpointFile(options.paths, options.name),
        },
      ],
    };
  }
  if (!checkpoint) {
    return {
      checkpoint: null,
      manifest: null,
      freshness: 'fresh',
      reasons: ['no-checkpoint'],
      findings: [],
    };
  }
  const reasons: string[] = [];
  const findings: LoopFinding[] = [];
  if (checkpoint.stateRevision !== options.stateRevision) reasons.push('state-revision-changed');
  let manifest: LoopCheckpointManifest | null = null;
  try {
    manifest = await readLoopCheckpointManifest(
      options.paths,
      options.name,
      checkpoint.manifestHash,
    );
    const expectedInputHash = sha256Text(
      JSON.stringify({
        summary: checkpoint.summary,
        nextAction: checkpoint.nextAction,
        artifacts: manifest.artifacts,
      }),
    );
    if (
      checkpoint.inputHash !== expectedInputHash ||
      checkpoint.artifactCount !== manifest.artifacts.length
    ) {
      throw new Error('Loop progress checkpoint does not match its artifact manifest');
    }
    for (const expected of manifest.artifacts) {
      try {
        const actual = await hashProjectArtifact(options.paths, expected.path);
        if (actual.hash !== expected.hash || actual.size !== expected.size) {
          reasons.push(`artifact-changed:${expected.path}`);
        }
      } catch {
        reasons.push(`artifact-unavailable:${expected.path}`);
      }
    }
  } catch (error) {
    reasons.push('checkpoint-manifest-invalid');
    findings.push({
      code: 'checkpoint-manifest-invalid',
      message: `Loop checkpoint manifest is invalid: ${(error as Error).message}`,
      path: loopCheckpointManifestFile(options.paths, options.name, checkpoint.manifestHash),
    });
  }
  return {
    checkpoint,
    manifest,
    freshness: reasons.length === 0 ? 'fresh' : 'stale',
    reasons,
    findings,
  };
}
