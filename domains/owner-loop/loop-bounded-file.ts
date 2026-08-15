import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import { loopSensitiveRelativePathReason } from './loop-sensitive-paths.js';
import { hasComparableLoopFileObject, sameLoopFileObject } from './loop-file-identity.js';

export const DEFAULT_LOOP_ARTIFACT_MAX_BYTES = 1024 * 1024;

export interface LoopBoundedFileReadHooks {
  afterParentChainCaptured?: () => void | Promise<void>;
  afterOpen?: () => void | Promise<void>;
  beforeFinalCheck?: () => void | Promise<void>;
}

export interface LoopBoundedTextFile {
  ref: string;
  size: number;
  hash: string;
  text: string;
}

export interface LoopUnhashedTextFile extends Omit<LoopBoundedTextFile, 'hash'> {
  hash: null;
}

export interface LoopTextFilePrefix {
  ref: string;
  size: number;
  text: string;
  truncated: boolean;
}

interface LoopTextFileReadOptions {
  root: string;
  ref: string;
  maxBytes?: number | null;
  includeHash?: boolean;
  hooks?: LoopBoundedFileReadHooks;
}

interface LoopTextFilePrefixReadOptions {
  root: string;
  ref: string;
  maxBytes: number;
  hooks?: LoopBoundedFileReadHooks;
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

function portableArtifactRef(value: string): string {
  const normalized = path.posix.normalize(value);
  if (
    value.length === 0 ||
    value !== value.trim() ||
    value.includes('\\') ||
    Array.from(value).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    }) ||
    path.posix.isAbsolute(normalized) ||
    /^(?:[A-Za-z]:|~)/u.test(value) ||
    value.split('/').includes('..') ||
    normalized !== value ||
    normalized === '.' ||
    value.endsWith('/')
  ) {
    throw new Error(`Loop artifact ref must be normalized and relative: ${value}`);
  }
  const lower = value.toLowerCase();
  const sensitiveReason = loopSensitiveRelativePathReason(value);
  if (sensitiveReason || lower === 'runtime' || lower.startsWith('runtime/')) {
    throw new Error(
      `Loop artifact ref is excluded as sensitive (${sensitiveReason ?? 'loop-runtime'}): ${value}`,
    );
  }
  return value;
}

function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('Loop artifact byte limit must be a positive integer');
  }
  return value;
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

async function directoryIdentity(directory: string): Promise<DirectoryIdentity> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Loop artifact parent must be a real directory: ${directory}`);
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
    throw new Error('Loop artifact path is outside its root');
  }
  const chain = [await directoryIdentity(lexicalRoot)];
  let cursor = lexicalRoot;
  for (const segment of path
    .relative(lexicalRoot, lexicalDirectory)
    .split(path.sep)
    .filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const identity = await directoryIdentity(cursor);
    if (!isInside(chain[0].realPath, identity.realPath)) {
      throw new Error(`Loop artifact parent resolves outside its root: ${cursor}`);
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
      throw new Error(`Loop artifact parent changed while reading: ${identity.path}`);
    }
  }
}

export function readLoopBoundedTextFile(
  options: LoopTextFileReadOptions & { includeHash: false },
): Promise<LoopUnhashedTextFile>;
export function readLoopBoundedTextFile(
  options: LoopTextFileReadOptions & { includeHash?: true; maxBytes?: number },
): Promise<LoopBoundedTextFile>;
export async function readLoopBoundedTextFile(
  options: LoopTextFileReadOptions,
): Promise<LoopBoundedTextFile | LoopUnhashedTextFile> {
  const ref = portableArtifactRef(options.ref);
  const maxBytes =
    options.maxBytes === null
      ? null
      : positiveLimit(options.maxBytes ?? DEFAULT_LOOP_ARTIFACT_MAX_BYTES);
  const file = path.resolve(options.root, ...ref.split('/'));
  const chain = await captureDirectoryChain(options.root, path.dirname(file));
  await options.hooks?.afterParentChainCaptured?.();
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`Loop artifact must be a regular file: ${ref}`);
  }
  if (maxBytes !== null && before.size > maxBytes) {
    throw new Error(`Loop artifact exceeds ${maxBytes} bytes: ${ref}`);
  }
  const realPath = await fs.realpath(file);
  if (!isInside(chain[0].realPath, realPath)) {
    throw new Error(`Loop artifact resolves outside its root: ${ref}`);
  }
  const handle = await fs.open(file, 'r');
  try {
    const [opened, afterOpenPath, afterOpenRealPath] = await Promise.all([
      handle.stat(),
      fs.lstat(file),
      fs.realpath(file),
    ]);
    await verifyDirectoryChain(chain);
    if (
      !opened.isFile() ||
      !afterOpenPath.isFile() ||
      afterOpenPath.isSymbolicLink() ||
      afterOpenRealPath !== realPath ||
      !sameFileIdentity(before, opened) ||
      !sameFileIdentity(opened, afterOpenPath)
    ) {
      throw new Error(`Loop artifact changed while opening: ${ref}`);
    }
    await options.hooks?.afterOpen?.();
    const chunks: Buffer[] = [];
    let total = 0;
    const buffer = Buffer.allocUnsafe(
      maxBytes === null ? 64 * 1024 : Math.min(64 * 1024, maxBytes + 1),
    );
    while (true) {
      const remaining = maxBytes === null ? buffer.length : maxBytes + 1 - total;
      const result = await handle.read(buffer, 0, Math.min(buffer.length, remaining), null);
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
      if (maxBytes !== null && total > maxBytes) {
        throw new Error(`Loop artifact exceeds ${maxBytes} bytes: ${ref}`);
      }
      chunks.push(Buffer.from(buffer.subarray(0, result.bytesRead)));
    }
    await options.hooks?.beforeFinalCheck?.();
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
      throw new Error(`Loop artifact changed while reading: ${ref}`);
    }
    const bytes = Buffer.concat(chunks, total);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
      throw new Error(`Loop artifact is not valid UTF-8: ${ref}`, { cause: error });
    }
    return {
      ref,
      size: total,
      hash: options.includeHash === false ? null : createHash('sha256').update(bytes).digest('hex'),
      text,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Read a display prefix without making the file's total size the read budget.
 * The returned size comes from the verified open file, while at most maxBytes
 * are read into memory.
 */
export async function readLoopTextFilePrefix(
  options: LoopTextFilePrefixReadOptions,
): Promise<LoopTextFilePrefix> {
  const ref = portableArtifactRef(options.ref);
  const maxBytes = positiveLimit(options.maxBytes);
  const file = path.resolve(options.root, ...ref.split('/'));
  const chain = await captureDirectoryChain(options.root, path.dirname(file));
  await options.hooks?.afterParentChainCaptured?.();
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`Loop artifact must be a regular file: ${ref}`);
  }
  const realPath = await fs.realpath(file);
  if (!isInside(chain[0].realPath, realPath)) {
    throw new Error(`Loop artifact resolves outside its root: ${ref}`);
  }
  const handle = await fs.open(file, 'r');
  try {
    const [opened, afterOpenPath, afterOpenRealPath] = await Promise.all([
      handle.stat(),
      fs.lstat(file),
      fs.realpath(file),
    ]);
    await verifyDirectoryChain(chain);
    if (
      !opened.isFile() ||
      !afterOpenPath.isFile() ||
      afterOpenPath.isSymbolicLink() ||
      afterOpenRealPath !== realPath ||
      !sameFileIdentity(before, opened) ||
      !sameFileIdentity(opened, afterOpenPath)
    ) {
      throw new Error(`Loop artifact changed while opening: ${ref}`);
    }
    await options.hooks?.afterOpen?.();

    const targetBytes = Math.min(opened.size, maxBytes);
    const chunks: Buffer[] = [];
    let total = 0;
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes));
    while (total < targetBytes) {
      const result = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, targetBytes - total),
        null,
      );
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
      chunks.push(Buffer.from(buffer.subarray(0, result.bytesRead)));
    }

    await options.hooks?.beforeFinalCheck?.();
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
      !sameFileIdentity(opened, afterPath) ||
      total !== targetBytes
    ) {
      throw new Error(`Loop artifact changed while reading: ${ref}`);
    }

    const truncated = opened.size > maxBytes;
    const bytes = Buffer.concat(chunks, total);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: truncated });
    } catch (error) {
      throw new Error(`Loop artifact prefix is not valid UTF-8: ${ref}`, { cause: error });
    }
    return { ref, size: opened.size, text, truncated };
  } finally {
    await handle.close();
  }
}
