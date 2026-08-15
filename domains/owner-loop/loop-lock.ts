import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { RaceSafeReadError, readFileRaceSafe } from '../../platform/fs/race-safe-read.js';

import { resolveContainedLoopPath } from './loop-paths.js';
import { hasComparableLoopFileObject, sameLoopFileObject } from './loop-file-identity.js';
import type { LoopProjectPaths } from './loop-types.js';

const LOOP_LOCK_MAX_BYTES = 16 * 1024;
const LOOP_LOCK_COORDINATOR_DIR = '.coordinator';
const LOOP_LOCK_COORDINATOR_TIMEOUT_MS = 5_000;

export interface LoopLockOwner {
  id: string;
  pid: number;
  hostname: string;
  createdAt: string;
  operation: string;
}

export interface LoopLockFileIdentity {
  device: string;
  inode: string;
  size: string;
  birthtimeNs: string;
  ctimeNs: string;
  mtimeNs: string;
}

export interface LoopLock {
  file: string;
  loopRoot: string;
  locksDir: string;
  owner: LoopLockOwner;
  identity: LoopLockFileIdentity;
}

export interface LoopLockDiagnosis {
  status: 'missing' | 'active' | 'stale' | 'unknown';
  owner: LoopLockOwner | null;
  identity: LoopLockFileIdentity | null;
}

export type LoopStaleLockTakeover =
  | { status: 'removed'; owner: LoopLockOwner }
  | { status: 'missing' }
  | { status: 'changed'; diagnosis: LoopLockDiagnosis };

interface LoopLockSnapshot {
  file: string;
  owner: LoopLockOwner;
  identity: LoopLockFileIdentity;
}

type LoopLockCoordinatorPaths = Pick<LoopProjectPaths, 'runtimeDir' | 'locksDir'>;

const loopLockCoordinator = new AsyncLocalStorage<Map<string, LoopLock>>();
const loopLockLocalCoordinator = new Map<string, Promise<void>>();

function lockName(value: string): string {
  if (!/^[a-z][a-z0-9-]*$/u.test(value)) throw new Error(`Invalid Loop lock name: ${value}`);
  return `${value}.lock`;
}

function parseLoopLockOwner(value: unknown, file: string): LoopLockOwner {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid Loop lock metadata: ${file}`);
  }
  const owner = value as Partial<LoopLockOwner>;
  if (
    typeof owner.id !== 'string' ||
    owner.id.length === 0 ||
    typeof owner.pid !== 'number' ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid < 1 ||
    typeof owner.hostname !== 'string' ||
    owner.hostname.length === 0 ||
    typeof owner.createdAt !== 'string' ||
    owner.createdAt.length === 0 ||
    typeof owner.operation !== 'string' ||
    owner.operation.length === 0
  ) {
    throw new Error(`Invalid Loop lock metadata: ${file}`);
  }
  return owner as LoopLockOwner;
}

function loopLockFileIdentity(stat: import('fs').BigIntStats): LoopLockFileIdentity {
  return {
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    size: stat.size.toString(),
    birthtimeNs: stat.birthtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
    mtimeNs: stat.mtimeNs.toString(),
  };
}

function sameLoopLockObject(left: LoopLockFileIdentity, right: LoopLockFileIdentity): boolean {
  const leftObject = { dev: left.device, ino: left.inode, birthtime: left.birthtimeNs };
  const rightObject = { dev: right.device, ino: right.inode, birthtime: right.birthtimeNs };
  if (hasComparableLoopFileObject(leftObject, rightObject)) {
    return sameLoopFileObject(leftObject, rightObject);
  }
  return sameLoopFileObject(leftObject, rightObject) && left.size === right.size;
}

function sameLoopLockVersion(left: LoopLockFileIdentity, right: LoopLockFileIdentity): boolean {
  return (
    sameLoopLockObject(left, right) &&
    left.size === right.size &&
    left.birthtimeNs === right.birthtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs
  );
}

function sameLoopLockDiagnosis(left: LoopLockDiagnosis, right: LoopLockDiagnosis): boolean {
  if (left.status !== right.status) return false;
  if (!left.owner || !left.identity || !right.owner || !right.identity) {
    return left.owner === right.owner && left.identity === right.identity;
  }
  return left.owner.id === right.owner.id && sameLoopLockVersion(left.identity, right.identity);
}

async function readLoopLockSnapshot(file: string): Promise<LoopLockSnapshot | null> {
  let bytes: Buffer;
  let stat: import('fs').BigIntStats;
  try {
    const result = await readFileRaceSafe(file, LOOP_LOCK_MAX_BYTES, {
      bigint: true,
      label: 'Loop lock',
    });
    bytes = result.bytes;
    stat = result.stat as import('fs').BigIntStats;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof RaceSafeReadError) {
      if (error.reason === 'too-large') {
        throw new Error(`Loop lock metadata exceeds ${LOOP_LOCK_MAX_BYTES} bytes: ${file}`, {
          cause: error,
        });
      }
      if (error.reason === 'not-regular-file') {
        throw new Error(`Loop lock must be a regular file: ${file}`, { cause: error });
      }
      throw new Error(`Loop lock changed while reading: ${file}`, { cause: error });
    }
    throw error;
  }
  return {
    file,
    owner: parseLoopLockOwner(JSON.parse(bytes.toString('utf8')) as unknown, file),
    identity: loopLockFileIdentity(stat),
  };
}

export async function readLoopLock(file: string): Promise<LoopLockOwner | null> {
  return (await readLoopLockSnapshot(file))?.owner ?? null;
}

function diagnosisFromSnapshot(snapshot: LoopLockSnapshot | null): LoopLockDiagnosis {
  if (!snapshot) return { status: 'missing', owner: null, identity: null };
  if (snapshot.owner.hostname !== os.hostname()) {
    return { status: 'unknown', owner: snapshot.owner, identity: snapshot.identity };
  }
  const alive = isProcessAlive(snapshot.owner.pid);
  return {
    status: alive === true ? 'active' : alive === false ? 'stale' : 'unknown',
    owner: snapshot.owner,
    identity: snapshot.identity,
  };
}

async function restoreQuarantinedLoopLock(quarantine: string, file: string): Promise<void> {
  try {
    await fs.lstat(file);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    await fs.rename(quarantine, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function removeBoundLoopLock(
  expected: LoopLockSnapshot,
  quarantineDir: string,
): Promise<'removed' | 'missing'> {
  const current = await readLoopLockSnapshot(expected.file);
  if (!current) return 'missing';
  if (current.owner.id !== expected.owner.id) {
    throw new Error(`Loop lock ownership changed: ${expected.file}`);
  }
  if (!sameLoopLockVersion(current.identity, expected.identity)) {
    throw new Error(`Loop lock identity changed: ${expected.file}`);
  }
  await fs.mkdir(quarantineDir, { recursive: true });
  const quarantine = path.join(
    quarantineDir,
    `${path.basename(expected.file)}.${expected.owner.id}.${randomUUID()}.removed`,
  );
  try {
    await fs.rename(expected.file, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
  const moved = await readLoopLockSnapshot(quarantine);
  if (
    !moved ||
    moved.owner.id !== expected.owner.id ||
    !sameLoopLockObject(moved.identity, expected.identity)
  ) {
    await restoreQuarantinedLoopLock(quarantine, expected.file);
    throw new Error(`Loop lock changed before quarantine: ${expected.file}`);
  }
  await fs.rm(quarantine, { force: true });
  return 'removed';
}

function newLoopLockOwner(operation: string): LoopLockOwner {
  return {
    id: randomUUID(),
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: new Date().toISOString(),
    operation,
  };
}

async function writeLoopLockFile(
  file: string,
  owner: LoopLockOwner,
): Promise<LoopLockFileIdentity> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(file, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const existing = await readLoopLock(file);
      throw new Error(
        `Loop lock is already held: ${file}${existing ? ` by pid ${existing.pid} for ${existing.operation}` : ''}`,
        { cause: error },
      );
    }
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify(owner, null, 2) + '\n', 'utf8');
    await handle.sync();
    return loopLockFileIdentity(await handle.stat({ bigint: true }));
  } finally {
    await handle.close();
  }
}

async function publishLoopCoordinatorClaim(
  paths: LoopLockCoordinatorPaths,
  operation: string,
): Promise<LoopLock> {
  const locksDir = await resolveContainedLoopPath(paths.runtimeDir, paths.locksDir);
  await fs.mkdir(locksDir, { recursive: true });
  const coordinatorDir = await resolveContainedLoopPath(
    paths.runtimeDir,
    path.join(locksDir, LOOP_LOCK_COORDINATOR_DIR),
  );
  await fs.mkdir(coordinatorDir, { recursive: true });
  const owner = newLoopLockOwner(operation);
  const temporary = path.join(coordinatorDir, `.${owner.id}.tmp`);
  const file = path.join(coordinatorDir, `${owner.id}.claim`);
  try {
    const identity = await writeLoopLockFile(temporary, owner);
    await fs.rename(temporary, file);
    const published = await readLoopLockSnapshot(file);
    if (!published || !sameLoopLockObject(identity, published.identity)) {
      throw new Error(`Loop lock coordinator claim changed while publishing: ${file}`);
    }
    return { file, loopRoot: paths.runtimeDir, locksDir, owner, identity: published.identity };
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function hasLoopCoordinatorPredecessor(claim: LoopLock): Promise<boolean> {
  const coordinatorDir = path.dirname(claim.file);
  let predecessor = false;
  const claimName = path.basename(claim.file);
  for (const entry of await fs.readdir(coordinatorDir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.claim')) continue;
    const file = path.join(coordinatorDir, entry.name);
    if (path.resolve(file) === path.resolve(claim.file)) continue;
    try {
      const snapshot = await readLoopLockSnapshot(file);
      const diagnosis = diagnosisFromSnapshot(snapshot);
      if (diagnosis.status === 'missing') continue;
      if (diagnosis.status === 'stale' && snapshot) {
        await removeBoundLoopLock(snapshot, coordinatorDir);
        continue;
      }
      if (entry.name < claimName) predecessor = true;
    } catch {
      if (entry.name < claimName) predecessor = true;
    }
  }
  return predecessor;
}

async function releaseLoopCoordinatorClaim(claim: LoopLock): Promise<void> {
  const current = await readLoopLockSnapshot(claim.file);
  if (!current) return;
  if (
    current.owner.id !== claim.owner.id ||
    !sameLoopLockVersion(current.identity, claim.identity)
  ) {
    throw new Error(`Loop lock coordinator ownership changed: ${claim.file}`);
  }
  await removeBoundLoopLock(current, path.dirname(claim.file));
}

async function acquireLoopCoordinator(
  paths: LoopLockCoordinatorPaths,
  operation: string,
): Promise<LoopLock> {
  const deadline = Date.now() + LOOP_LOCK_COORDINATOR_TIMEOUT_MS;
  while (true) {
    const claim = await publishLoopCoordinatorClaim(paths, operation);
    // A total order prevents two simultaneous claimants from symmetrically observing each
    // other, releasing, and retrying until both time out. The lexicographically first live
    // claim proceeds; later claims wait for it to publish the actual lock.
    if (!(await hasLoopCoordinatorPredecessor(claim))) return claim;
    await releaseLoopCoordinatorClaim(claim);
    if (Date.now() >= deadline) {
      throw new Error(`Loop lock coordinator is busy: ${paths.locksDir}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2 + Math.floor(Math.random() * 7)));
  }
}

async function acquireLoopLocalCoordinator(key: string): Promise<() => void> {
  const previous = loopLockLocalCoordinator.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const turn = previous.then(() => current);
  loopLockLocalCoordinator.set(key, turn);
  await previous;
  return () => {
    release();
    if (loopLockLocalCoordinator.get(key) === turn) loopLockLocalCoordinator.delete(key);
  };
}

async function withLoopLockCoordinator<T>(
  paths: LoopLockCoordinatorPaths,
  operation: string,
  work: () => Promise<T>,
): Promise<T> {
  const key = path.resolve(paths.locksDir);
  const current = loopLockCoordinator.getStore();
  if (current?.has(key)) return work();
  const releaseLocal = await acquireLoopLocalCoordinator(key);
  try {
    const claim = await acquireLoopCoordinator(paths, operation);
    const next = new Map(current ?? []);
    next.set(key, claim);
    return await loopLockCoordinator.run(next, async () => {
      try {
        return await work();
      } finally {
        await releaseLoopCoordinatorClaim(claim);
      }
    });
  } finally {
    releaseLocal();
  }
}

export async function withLoopLockRecovery<T>(
  pathEntries: readonly LoopLockCoordinatorPaths[],
  operation: string,
  work: () => Promise<T>,
): Promise<T> {
  const unique = [
    ...new Map(pathEntries.map((entry) => [path.resolve(entry.locksDir), entry])).values(),
  ].sort((left, right) => path.resolve(left.locksDir).localeCompare(path.resolve(right.locksDir)));
  const enter = async (index: number): Promise<T> => {
    const entry = unique[index];
    return entry ? withLoopLockCoordinator(entry, operation, () => enter(index + 1)) : work();
  };
  return enter(0);
}

export async function acquireLoopLock(
  paths: LoopProjectPaths,
  name: string,
  operation: string,
): Promise<LoopLock> {
  return withLoopLockCoordinator(paths, `acquire ${name}`, async () => {
    const locksDir = await resolveContainedLoopPath(paths.runtimeDir, paths.locksDir);
    await fs.mkdir(locksDir, { recursive: true });
    const file = await resolveContainedLoopPath(
      paths.runtimeDir,
      path.join(locksDir, lockName(name)),
    );
    const owner = newLoopLockOwner(operation);
    const identity = await writeLoopLockFile(file, owner);
    return { file, loopRoot: paths.runtimeDir, locksDir, owner, identity };
  });
}

export async function releaseLoopLock(lock: LoopLock): Promise<void> {
  if (!(await readLoopLockSnapshot(lock.file))) return;
  await withLoopLockCoordinator(
    { runtimeDir: lock.loopRoot, locksDir: lock.locksDir },
    `release ${path.basename(lock.file)}`,
    async () => {
      const current = await readLoopLockSnapshot(lock.file);
      if (!current) return;
      if (current.owner.id !== lock.owner.id) {
        throw new Error(`Loop lock ownership changed: ${lock.file}`);
      }
      if (!sameLoopLockVersion(current.identity, lock.identity)) {
        throw new Error(`Loop lock identity changed: ${lock.file}`);
      }
      const coordinatorDir = path.join(lock.locksDir, LOOP_LOCK_COORDINATOR_DIR);
      await removeBoundLoopLock(current, coordinatorDir);
    },
  );
}

export function isProcessAlive(pid: number): boolean | null {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return null;
  }
}

export async function diagnoseLoopLock(file: string): Promise<LoopLockDiagnosis> {
  return diagnosisFromSnapshot(await readLoopLockSnapshot(file));
}

export async function takeOverLoopStaleLock(
  paths: LoopProjectPaths,
  file: string,
  expected?: LoopLockDiagnosis,
): Promise<LoopStaleLockTakeover> {
  return withLoopLockCoordinator(paths, `take over ${path.basename(file)}`, async () => {
    const locksDir = await resolveContainedLoopPath(paths.runtimeDir, paths.locksDir);
    const containedFile = await resolveContainedLoopPath(paths.runtimeDir, file);
    if (path.resolve(path.dirname(containedFile)) !== path.resolve(locksDir)) {
      throw new Error(`Loop lock takeover target is outside the lock directory: ${file}`);
    }
    const snapshot = await readLoopLockSnapshot(containedFile);
    const diagnosis = diagnosisFromSnapshot(snapshot);
    if (diagnosis.status === 'missing') return { status: 'missing' };
    if (expected && !sameLoopLockDiagnosis(expected, diagnosis)) {
      return { status: 'changed', diagnosis };
    }
    if (diagnosis.status !== 'stale' || !snapshot) {
      return { status: 'changed', diagnosis };
    }
    const coordinatorDir = path.join(locksDir, LOOP_LOCK_COORDINATOR_DIR);
    const removed = await removeBoundLoopLock(snapshot, coordinatorDir);
    return removed === 'removed'
      ? { status: 'removed', owner: snapshot.owner }
      : { status: 'missing' };
  });
}
