import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { sha256Text } from './loop-hash.js';
import { readLoopProtectedDirectory, readLoopProtectedFile } from './loop-protected-file.js';

export interface LoopArchiveContentIdentity {
  kind: 'file' | 'directory';
  hash: string;
}

interface TreeEntry {
  ref: string;
  kind: 'directory' | 'file';
  hash?: string;
  size?: number;
}

const TREE_HASH_TAG = 'owner.loop.archive-tree.v1';
export const LOOP_ARCHIVE_CONTENT_LIMITS = {
  maxDepth: 128,
  maxEntries: 20_000,
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxManifestBytes: 16 * 1024 * 1024,
  maxRefBytes: 4 * 1024,
} as const;

export interface LoopArchiveContentLimits {
  maxDepth: number;
  maxEntries: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxManifestBytes: number;
  maxRefBytes: number;
}

interface TreeWalkBudget {
  entryCount: number;
  totalBytes: number;
  manifestBytes: number;
}

function normalizedLimits(limits: Partial<LoopArchiveContentLimits>): LoopArchiveContentLimits {
  const resolved = { ...LOOP_ARCHIVE_CONTENT_LIMITS, ...limits };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Loop Archive content limit ${name} must be a positive safe integer`);
    }
  }
  return resolved;
}

function directorySnapshot(
  entries: Awaited<ReturnType<typeof readLoopProtectedDirectory>>['entries'],
): string {
  return JSON.stringify(
    entries
      .map((entry) => ({
        name: entry.name,
        kind: entry.isDirectory()
          ? 'directory'
          : entry.isFile()
            ? 'file'
            : entry.isSymbolicLink()
              ? 'symlink'
              : 'other',
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  );
}

function appendTreeEntry(
  entries: TreeEntry[],
  entry: TreeEntry,
  budget: TreeWalkBudget,
  limits: LoopArchiveContentLimits,
): void {
  budget.entryCount += 1;
  if (budget.entryCount > limits.maxEntries) {
    throw new Error(`Loop Archive content exceeds ${limits.maxEntries} entries`);
  }
  if (Buffer.byteLength(entry.ref, 'utf8') > limits.maxRefBytes) {
    throw new Error(`Loop Archive content ref exceeds ${limits.maxRefBytes} bytes: ${entry.ref}`);
  }
  const entryBytes = Buffer.byteLength(JSON.stringify(entry), 'utf8');
  budget.manifestBytes += entryBytes + (entries.length === 0 ? 0 : 1);
  if (budget.manifestBytes + 2 > limits.maxManifestBytes) {
    throw new Error(`Loop Archive content manifest exceeds ${limits.maxManifestBytes} bytes`);
  }
  entries.push(entry);
}

async function walkArchiveTree(
  root: string,
  directory: string,
  entries: TreeEntry[],
  budget: TreeWalkBudget,
  limits: LoopArchiveContentLimits,
  depth: number,
): Promise<void> {
  if (depth > limits.maxDepth) {
    throw new Error(`Loop Archive content exceeds depth ${limits.maxDepth}`);
  }
  const protectedDirectory = await readLoopProtectedDirectory({
    root,
    directory,
    label: `Loop Archive content directory ${path.relative(root, directory) || '.'}`,
    maxEntries: limits.maxEntries,
  });
  const beforeSnapshot = directorySnapshot(protectedDirectory.entries);
  const children = [...protectedDirectory.entries];
  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    await protectedDirectory.verify();
    const target = path.join(directory, child.name);
    const ref = path.relative(root, target).replaceAll('\\', '/');
    const stat = await fs.lstat(target);
    if (child.isSymbolicLink() || stat.isSymbolicLink()) {
      throw new Error(`Loop Archive content must not contain symlinks or junctions: ${ref}`);
    }
    if (child.isDirectory() && stat.isDirectory()) {
      appendTreeEntry(entries, { ref, kind: 'directory' }, budget, limits);
      await walkArchiveTree(root, target, entries, budget, limits, depth + 1);
      continue;
    }
    if (!child.isFile() || !stat.isFile()) {
      throw new Error(`Loop Archive content must contain only files and directories: ${ref}`);
    }
    const snapshot = await readLoopProtectedFile({
      root,
      file: target,
      maxBytes: limits.maxFileBytes,
      label: `Loop Archive content file ${ref}`,
    });
    budget.totalBytes += snapshot.size;
    if (budget.totalBytes > limits.maxTotalBytes) {
      throw new Error(`Loop Archive content exceeds ${limits.maxTotalBytes} total file bytes`);
    }
    appendTreeEntry(
      entries,
      { ref, kind: 'file', hash: snapshot.hash, size: snapshot.size },
      budget,
      limits,
    );
    await protectedDirectory.verify();
  }
  await protectedDirectory.verify();
  const afterDirectory = await readLoopProtectedDirectory({
    root,
    directory,
    label: `Loop Archive content directory ${path.relative(root, directory) || '.'}`,
    maxEntries: limits.maxEntries,
  });
  if (directorySnapshot(afterDirectory.entries) !== beforeSnapshot) {
    throw new Error(
      `Loop Archive content directory changed while reading: ${path.relative(root, directory) || '.'}`,
    );
  }
  await Promise.all([protectedDirectory.verify(), afterDirectory.verify()]);
}

/** Hash the complete change tree without embedding its absolute location. */
export async function hashLoopArchiveTree(
  directory: string,
  requestedLimits: Partial<LoopArchiveContentLimits> = {},
): Promise<string> {
  const limits = normalizedLimits(requestedLimits);
  directory = path.resolve(directory);
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Loop Archive move source must be a real directory: ${directory}`);
  }
  const entries: TreeEntry[] = [];
  const budget: TreeWalkBudget = { entryCount: 0, totalBytes: 0, manifestBytes: 0 };
  await walkArchiveTree(directory, directory, entries, budget, limits, 0);
  const manifest = JSON.stringify(entries);
  if (Buffer.byteLength(manifest, 'utf8') > limits.maxManifestBytes) {
    throw new Error(`Loop Archive content manifest exceeds ${limits.maxManifestBytes} bytes`);
  }
  return sha256Text(`${TREE_HASH_TAG}\0${manifest}`);
}

export async function inspectLoopArchiveContent(
  target: string,
  requestedLimits: Partial<LoopArchiveContentLimits> = {},
): Promise<LoopArchiveContentIdentity | null> {
  const limits = normalizedLimits(requestedLimits);
  target = path.resolve(target);
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`Loop Archive transaction path must not be a symlink or junction: ${target}`);
  }
  if (stat.isFile()) {
    const snapshot = await readLoopProtectedFile({
      root: path.dirname(target),
      file: target,
      maxBytes: limits.maxFileBytes,
      label: `Loop Archive transaction file ${path.basename(target)}`,
    });
    return { kind: 'file', hash: snapshot.hash };
  }
  if (stat.isDirectory()) {
    return { kind: 'directory', hash: await hashLoopArchiveTree(target, limits) };
  }
  throw new Error(`Loop Archive transaction path has an unsupported file type: ${target}`);
}

export function isLoopArchiveHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

export function hashLoopArchiveBytes(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}
