import { createHash } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import { LOOP_RUN_STORAGE } from '../engine/storage-layout.js';
import { parseStoredRunStateValue, startRunWithStorage } from '../engine/storage-run.js';
import type { Checkpoint, EngineAction, RunState, TrajectoryEvent } from '../engine/types.js';
import type { SkillPackage } from '../skill/types.js';
import { atomicWriteText } from './loop-atomic-file.js';
import { sameLoopFileObject } from './loop-file-identity.js';

export const LOOP_RUN_IO_LIMITS = {
  runStateBytes: 256 * 1024,
  trajectoryBytes: 8 * 1024 * 1024,
  trajectoryEvents: 4_096,
  trajectoryEventBytes: 256 * 1024,
  checkpointBytes: 256 * 1024,
  pendingActionBytes: 256 * 1024,
  contextBytes: 1024 * 1024,
  artifactsBytes: 1024 * 1024,
} as const;

export interface LoopRunReadHooks {
  afterParentChainCaptured?: () => void | Promise<void>;
  afterOpen?: () => void | Promise<void>;
  beforeFinalCheck?: () => void | Promise<void>;
}

export interface LoopRunWriteHooks {
  beforeCommit?: () => void | Promise<void>;
}

interface DirectoryIdentity {
  path: string;
  realPath: string;
  dev: number;
  ino: number;
  birthtimeMs: number;
}

interface FileIdentity {
  dev: number;
  ino: number;
  birthtimeMs: number;
  ctimeMs: number;
  mtimeMs: number;
  size: number;
}

interface ExistingTarget {
  exists: true;
  identity: FileIdentity;
  realPath: string;
}

interface MissingTarget {
  exists: false;
}

type TargetSnapshot = ExistingTarget | MissingTarget;

interface ProtectedText {
  text: string;
  target: ExistingTarget;
}

type LoopRunFileKind = keyof typeof LOOP_RUN_STORAGE;

function isInside(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

function asIdentity(stat: import('node:fs').Stats): FileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    birthtimeMs: stat.birthtimeMs,
    ctimeMs: stat.ctimeMs,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  };
}

function sameFileIdentity(expected: FileIdentity, actual: import('node:fs').Stats): boolean {
  return (
    sameLoopFileObject(
      { ...expected, birthtime: expected.birthtimeMs },
      {
        ...actual,
        birthtime: actual.birthtimeMs,
      },
    ) &&
    expected.birthtimeMs === actual.birthtimeMs &&
    expected.ctimeMs === actual.ctimeMs &&
    expected.mtimeMs === actual.mtimeMs &&
    expected.size === actual.size
  );
}

function sameDirectoryIdentity(
  expected: DirectoryIdentity,
  actual: import('node:fs').Stats,
): boolean {
  return sameLoopFileObject(
    { ...expected, birthtime: expected.birthtimeMs },
    {
      ...actual,
      birthtime: actual.birthtimeMs,
    },
  );
}

function runFile(runtimeDir: string, kind: LoopRunFileKind, relativePath?: string): string {
  const expected = LOOP_RUN_STORAGE[kind];
  if (relativePath !== undefined && relativePath !== expected) {
    throw new Error(`Loop Run ${kind} ref must be ${expected}`);
  }
  const root = path.resolve(runtimeDir);
  const target = path.resolve(root, ...expected.slice('runtime/'.length).split('/'));
  if (!isInside(root, target)) throw new Error('Loop Run path must stay inside its Runtime root');
  return target;
}

async function directoryIdentity(directory: string): Promise<DirectoryIdentity> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Loop Run parent must be a real directory: ${directory}`);
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
): Promise<DirectoryIdentity[] | null> {
  const lexicalRoot = path.resolve(root);
  const lexicalDirectory = path.resolve(directory);
  if (!isInside(lexicalRoot, lexicalDirectory)) {
    throw new Error('Loop Run path is outside its change');
  }
  const chain = [await directoryIdentity(lexicalRoot)];
  let cursor = lexicalRoot;
  for (const segment of path
    .relative(lexicalRoot, lexicalDirectory)
    .split(path.sep)
    .filter(Boolean)) {
    cursor = path.join(cursor, segment);
    let identity: DirectoryIdentity;
    try {
      identity = await directoryIdentity(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (!isInside(chain[0].realPath, identity.realPath)) {
      throw new Error(`Loop Run parent resolves outside its change: ${cursor}`);
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
      throw new Error(`Loop Run parent changed during I/O: ${identity.path}`);
    }
  }
}

async function readHandleBounded(
  handle: Awaited<ReturnType<typeof fs.open>>,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1));
  while (true) {
    const remaining = maxBytes + 1 - total;
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, remaining), null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks, total);
}

async function readProtectedText(
  changeDir: string,
  file: string,
  maxBytes: number,
  label: string,
  hooks?: LoopRunReadHooks,
): Promise<ProtectedText | null> {
  const chain = await captureDirectoryChain(changeDir, path.dirname(file));
  if (!chain) return null;
  await hooks?.afterParentChainCaptured?.();
  let before: import('node:fs').Stats;
  try {
    before = await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file`);
  }
  if (before.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  const beforeIdentity = asIdentity(before);
  const beforeRealPath = await fs.realpath(file);
  if (!isInside(chain[0].realPath, beforeRealPath)) {
    throw new Error(`${label} resolves outside its change`);
  }
  const flags =
    process.platform === 'win32'
      ? fsConstants.O_RDONLY
      : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(file, flags);
  } catch (error) {
    throw new Error(`${label} changed while opening`, { cause: error });
  }
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
      realPathAfterOpen !== beforeRealPath ||
      !sameFileIdentity(beforeIdentity, opened) ||
      !sameFileIdentity(beforeIdentity, pathAfterOpen)
    ) {
      throw new Error(`${label} changed while opening`);
    }
    await hooks?.afterOpen?.();
    const bytes = await readHandleBounded(handle, maxBytes, label);
    await hooks?.beforeFinalCheck?.();
    const [afterHandle, afterPath, afterRealPath] = await Promise.all([
      handle.stat(),
      fs.lstat(file),
      fs.realpath(file),
    ]);
    await verifyDirectoryChain(chain);
    if (
      !afterPath.isFile() ||
      afterPath.isSymbolicLink() ||
      afterRealPath !== beforeRealPath ||
      !sameFileIdentity(beforeIdentity, afterHandle) ||
      !sameFileIdentity(beforeIdentity, afterPath)
    ) {
      throw new Error(`${label} changed while reading`);
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
      throw new Error(`${label} is not valid UTF-8`, { cause: error });
    }
    return {
      text,
      target: { exists: true, identity: beforeIdentity, realPath: beforeRealPath },
    };
  } finally {
    await handle.close();
  }
}

async function captureTarget(
  changeDir: string,
  file: string,
  label: string,
): Promise<TargetSnapshot> {
  const chain = await captureDirectoryChain(changeDir, path.dirname(file));
  if (!chain) return { exists: false };
  let stat: import('node:fs').Stats;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false };
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  const realPath = await fs.realpath(file);
  if (!isInside(chain[0].realPath, realPath))
    throw new Error(`${label} resolves outside its change`);
  await verifyDirectoryChain(chain);
  return { exists: true, identity: asIdentity(stat), realPath };
}

async function verifyTarget(
  changeDir: string,
  file: string,
  expected: TargetSnapshot,
  label: string,
): Promise<void> {
  const chain = await captureDirectoryChain(changeDir, path.dirname(file));
  if (!chain) {
    if (!expected.exists) return;
    throw new Error(`${label} parent changed before commit`);
  }
  let stat: import('node:fs').Stats;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !expected.exists) return;
    throw new Error(`${label} changed before commit`, { cause: error });
  }
  if (
    !expected.exists ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    !sameFileIdentity(expected.identity, stat) ||
    (await fs.realpath(file)) !== expected.realPath
  ) {
    throw new Error(`${label} changed before commit`);
  }
  await verifyDirectoryChain(chain);
}

async function writeProtectedText(options: {
  changeDir: string;
  file: string;
  content: string;
  maxBytes: number;
  label: string;
  expected?: TargetSnapshot;
  hooks?: LoopRunWriteHooks;
}): Promise<void> {
  const bytes = Buffer.byteLength(options.content, 'utf8');
  if (bytes > options.maxBytes) {
    throw new Error(`${options.label} exceeds ${options.maxBytes} bytes`);
  }
  const expected =
    options.expected ?? (await captureTarget(options.changeDir, options.file, options.label));
  if (expected.exists && expected.identity.size > options.maxBytes) {
    throw new Error(`${options.label} exceeds ${options.maxBytes} bytes`);
  }
  await atomicWriteText(options.file, options.content, {
    containedRoot: options.changeDir,
    beforeCommit: async () => {
      await options.hooks?.beforeCommit?.();
      await verifyTarget(options.changeDir, options.file, expected, options.label);
    },
  });
  const persisted = await readProtectedText(
    options.changeDir,
    options.file,
    options.maxBytes,
    options.label,
  );
  if (!persisted || persisted.text !== options.content) {
    throw new Error(`${options.label} commit could not be verified`);
  }
}

async function removeProtectedFile(changeDir: string, file: string, label: string): Promise<void> {
  const expected = await captureTarget(changeDir, file, label);
  if (!expected.exists) return;
  await verifyTarget(changeDir, file, expected, label);
  await fs.unlink(file);
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${label} contains invalid JSON`, { cause: error });
  }
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function parseLoopStoredRunStateValue(value: unknown): RunState {
  return parseStoredRunStateValue(value);
}

export function startLoopRun(pkg: SkillPackage, runId: string, skillHash: string): RunState {
  return startRunWithStorage(pkg, runId, skillHash, LOOP_RUN_STORAGE);
}

export async function readLoopRunState(
  changeDir: string,
  hooks?: LoopRunReadHooks,
): Promise<RunState | null> {
  const file = runFile(changeDir, 'stateRef');
  const raw = await readProtectedText(
    changeDir,
    file,
    LOOP_RUN_IO_LIMITS.runStateBytes,
    'Loop Run state',
    hooks,
  );
  return raw ? parseStoredRunStateValue(parseJson(raw.text, 'Loop Run state')) : null;
}

export async function writeLoopRunState(
  changeDir: string,
  state: RunState,
  hooks?: LoopRunWriteHooks,
): Promise<void> {
  const validated = parseStoredRunStateValue(state);
  await writeProtectedText({
    changeDir,
    file: runFile(changeDir, 'stateRef'),
    content: jsonText(validated),
    maxBytes: LOOP_RUN_IO_LIMITS.runStateBytes,
    label: 'Loop Run state',
    hooks,
  });
}

export async function removeLoopRunState(changeDir: string): Promise<void> {
  await removeProtectedFile(changeDir, runFile(changeDir, 'stateRef'), 'Loop Run state');
}

export async function readLoopTrajectory(
  changeDir: string,
  relativePath: string,
  hooks?: LoopRunReadHooks,
): Promise<TrajectoryEvent[]> {
  const file = runFile(changeDir, 'trajectoryRef', relativePath);
  const raw = await readProtectedText(
    changeDir,
    file,
    LOOP_RUN_IO_LIMITS.trajectoryBytes,
    'Loop Run trajectory',
    hooks,
  );
  if (!raw) return [];
  const lines = raw.text
    .split(/\r?\n/u)
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => line.length > 0);
  if (lines.length > LOOP_RUN_IO_LIMITS.trajectoryEvents) {
    throw new Error(`Loop Run trajectory exceeds ${LOOP_RUN_IO_LIMITS.trajectoryEvents} events`);
  }
  return lines.map(({ line, number }) => {
    try {
      return JSON.parse(line) as TrajectoryEvent;
    } catch (error) {
      throw new Error(`Invalid Loop Run trajectory event at line ${number}`, { cause: error });
    }
  });
}

/** Raw, bounded trajectory text for deterministic tail inspection and recovery. */
export async function readLoopTrajectoryText(
  changeDir: string,
  relativePath: string,
  hooks?: LoopRunReadHooks,
): Promise<string | null> {
  const raw = await readProtectedText(
    changeDir,
    runFile(changeDir, 'trajectoryRef', relativePath),
    LOOP_RUN_IO_LIMITS.trajectoryBytes,
    'Loop Run trajectory',
    hooks,
  );
  return raw?.text ?? null;
}

/** Compare-and-swap replacement used only to repair an already inspected trajectory tail. */
export async function replaceLoopTrajectoryText(
  changeDir: string,
  relativePath: string,
  content: string,
  expectedHash: string,
  hooks?: LoopRunWriteHooks,
): Promise<void> {
  if (!/^[a-f0-9]{64}$/u.test(expectedHash)) {
    throw new Error('Loop Run trajectory expected hash is invalid');
  }
  const file = runFile(changeDir, 'trajectoryRef', relativePath);
  const existing = await readProtectedText(
    changeDir,
    file,
    LOOP_RUN_IO_LIMITS.trajectoryBytes,
    'Loop Run trajectory',
  );
  if (!existing) throw new Error('Loop Run trajectory disappeared before repair');
  const actualHash = createHash('sha256').update(existing.text, 'utf8').digest('hex');
  if (actualHash !== expectedHash) {
    throw new Error('Loop Run trajectory changed before repair');
  }
  await writeProtectedText({
    changeDir,
    file,
    content,
    maxBytes: LOOP_RUN_IO_LIMITS.trajectoryBytes,
    label: 'Loop Run trajectory',
    expected: existing.target,
    hooks,
  });
}

export async function appendLoopTrajectory(
  changeDir: string,
  relativePath: string,
  event: TrajectoryEvent,
  hooks?: LoopRunWriteHooks,
): Promise<void> {
  const file = runFile(changeDir, 'trajectoryRef', relativePath);
  const line = `${JSON.stringify(event)}\n`;
  if (Buffer.byteLength(line, 'utf8') > LOOP_RUN_IO_LIMITS.trajectoryEventBytes) {
    throw new Error(
      `Loop Run trajectory event exceeds ${LOOP_RUN_IO_LIMITS.trajectoryEventBytes} bytes`,
    );
  }
  const existing = await readProtectedText(
    changeDir,
    file,
    LOOP_RUN_IO_LIMITS.trajectoryBytes,
    'Loop Run trajectory',
  );
  const existingEvents = existing
    ? existing.text.split(/\r?\n/u).filter((value) => value.length > 0).length
    : 0;
  if (existingEvents >= LOOP_RUN_IO_LIMITS.trajectoryEvents) {
    throw new Error(`Loop Run trajectory exceeds ${LOOP_RUN_IO_LIMITS.trajectoryEvents} events`);
  }
  await writeProtectedText({
    changeDir,
    file,
    content: `${existing?.text ?? ''}${line}`,
    maxBytes: LOOP_RUN_IO_LIMITS.trajectoryBytes,
    label: 'Loop Run trajectory',
    expected: existing?.target ?? { exists: false },
    hooks,
  });
}

export async function readLoopArtifacts(
  changeDir: string,
  relativePath: string,
  hooks?: LoopRunReadHooks,
): Promise<Record<string, string>> {
  const raw = await readProtectedText(
    changeDir,
    runFile(changeDir, 'artifactsRef', relativePath),
    LOOP_RUN_IO_LIMITS.artifactsBytes,
    'Loop Run artifacts',
    hooks,
  );
  return raw ? (parseJson(raw.text, 'Loop Run artifacts') as Record<string, string>) : {};
}

export async function writeLoopArtifacts(
  changeDir: string,
  relativePath: string,
  artifacts: Record<string, string>,
  hooks?: LoopRunWriteHooks,
): Promise<void> {
  await writeProtectedText({
    changeDir,
    file: runFile(changeDir, 'artifactsRef', relativePath),
    content: jsonText(artifacts),
    maxBytes: LOOP_RUN_IO_LIMITS.artifactsBytes,
    label: 'Loop Run artifacts',
    hooks,
  });
}

export async function readLoopContext(
  changeDir: string,
  relativePath: string,
  hooks?: LoopRunReadHooks,
): Promise<string | null> {
  const raw = await readProtectedText(
    changeDir,
    runFile(changeDir, 'contextRef', relativePath),
    LOOP_RUN_IO_LIMITS.contextBytes,
    'Loop Run context',
    hooks,
  );
  return raw?.text ?? null;
}

export async function writeLoopContext(
  changeDir: string,
  relativePath: string,
  context: string,
  hooks?: LoopRunWriteHooks,
): Promise<void> {
  await writeProtectedText({
    changeDir,
    file: runFile(changeDir, 'contextRef', relativePath),
    content: context,
    maxBytes: LOOP_RUN_IO_LIMITS.contextBytes,
    label: 'Loop Run context',
    hooks,
  });
}

export async function readLoopPendingAction(
  changeDir: string,
  relativePath: string,
  hooks?: LoopRunReadHooks,
): Promise<EngineAction | null> {
  const raw = await readProtectedText(
    changeDir,
    runFile(changeDir, 'pendingRef', relativePath),
    LOOP_RUN_IO_LIMITS.pendingActionBytes,
    'Loop Run pending action',
    hooks,
  );
  return raw ? (parseJson(raw.text, 'Loop Run pending action') as EngineAction) : null;
}

export async function writeLoopPendingAction(
  changeDir: string,
  relativePath: string,
  action: EngineAction,
  hooks?: LoopRunWriteHooks,
): Promise<void> {
  await writeProtectedText({
    changeDir,
    file: runFile(changeDir, 'pendingRef', relativePath),
    content: jsonText(action),
    maxBytes: LOOP_RUN_IO_LIMITS.pendingActionBytes,
    label: 'Loop Run pending action',
    hooks,
  });
}

export async function clearLoopPendingAction(
  changeDir: string,
  relativePath: string,
): Promise<void> {
  await removeProtectedFile(
    changeDir,
    runFile(changeDir, 'pendingRef', relativePath),
    'Loop Run pending action',
  );
}

export async function readLoopCheckpoint(
  changeDir: string,
  relativePath: string,
  hooks?: LoopRunReadHooks,
): Promise<Checkpoint | null> {
  const raw = await readProtectedText(
    changeDir,
    runFile(changeDir, 'checkpointRef', relativePath),
    LOOP_RUN_IO_LIMITS.checkpointBytes,
    'Loop Run checkpoint',
    hooks,
  );
  return raw ? (parseJson(raw.text, 'Loop Run checkpoint') as Checkpoint) : null;
}

export async function writeLoopCheckpoint(
  changeDir: string,
  relativePath: string,
  checkpoint: Checkpoint,
  hooks?: LoopRunWriteHooks,
): Promise<void> {
  await writeProtectedText({
    changeDir,
    file: runFile(changeDir, 'checkpointRef', relativePath),
    content: jsonText(checkpoint),
    maxBytes: LOOP_RUN_IO_LIMITS.checkpointBytes,
    label: 'Loop Run checkpoint',
    hooks,
  });
}
