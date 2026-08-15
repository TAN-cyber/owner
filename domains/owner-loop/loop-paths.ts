import { existsSync, promises as fs } from 'fs';
import path from 'path';
import os from 'os';

import { normalizeWorkflowArtifactRoot } from '../workflow-contract/project-config.js';

import type { LoopProjectPaths } from './loop-types.js';

export const PROJECT_CONFIG_FILE = '.owner/config.yaml';
const LOOP_CHANGE_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

async function isFileOrDirectory(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function declaresLoopProjectConfig(target: string): Promise<boolean> {
  try {
    const source = await fs.readFile(target, 'utf8');
    return /^schema:\s*owner\.project\.v1\s*$/mu.test(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function inside(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

async function physicalPath(target: string): Promise<string> {
  const missing: string[] = [];
  let cursor = target;
  while (!(await isFileOrDirectory(cursor))) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    missing.push(path.basename(cursor));
    cursor = parent;
  }
  const existing = await fs.realpath(cursor);
  return path.resolve(existing, ...missing.reverse());
}

async function isSymbolicLink(target: string): Promise<boolean> {
  try {
    return (await fs.lstat(target)).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function discoverLoopProject(startPath: string): Promise<string> {
  let cursor = path.resolve(startPath);
  try {
    if (!(await fs.stat(cursor)).isDirectory()) cursor = path.dirname(cursor);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const fallback = cursor;
  const home = path.resolve(os.homedir());
  while (true) {
    const isHomeBoundary = cursor === home && fallback !== home;
    if (!isHomeBoundary) {
      const configFile = path.join(cursor, ...PROJECT_CONFIG_FILE.split('/'));
      const configMarksProject =
        cursor === fallback || (await declaresLoopProjectConfig(configFile));
      if ((await isFileOrDirectory(configFile)) && configMarksProject) {
        return cursor;
      }
    }
    if (await isFileOrDirectory(path.join(cursor, '.git'))) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) return fallback;
    cursor = parent;
  }
}

export function normalizeArtifactRootRef(value: string): string {
  return normalizeWorkflowArtifactRoot(value);
}

export async function resolveArtifactRoot(projectRoot: string, value: string): Promise<string> {
  const normalized = normalizeArtifactRootRef(value);
  const lexical = path.resolve(projectRoot, ...normalized.split('/'));
  const physicalProject = await fs.realpath(projectRoot);
  const physicalTarget = await physicalPath(lexical);
  if (!inside(physicalProject, physicalTarget)) {
    throw new Error('loop.artifact_root resolves outside the project root');
  }
  return lexical;
}

export async function loopProjectPaths(
  projectRoot: string,
  artifactRootRef: string,
): Promise<LoopProjectPaths> {
  const normalized = normalizeArtifactRootRef(artifactRootRef);
  const artifactRoot = await resolveArtifactRoot(projectRoot, normalized);
  const loopRoot = path.join(artifactRoot, 'owner');
  if (await isSymbolicLink(loopRoot)) {
    throw new Error('The configured Loop owner root must not be a symbolic link');
  }
  const [physicalArtifactRoot, physicalLoopRoot] = await Promise.all([
    physicalPath(artifactRoot),
    physicalPath(loopRoot),
  ]);
  if (!inside(physicalArtifactRoot, physicalLoopRoot)) {
    throw new Error('The configured Loop owner root resolves outside its artifact root');
  }
  const resolvedProjectRoot = path.resolve(projectRoot);
  const runtimeDir = path.join(resolvedProjectRoot, '.owner', 'runtime', 'loop');
  if (await isSymbolicLink(runtimeDir)) {
    throw new Error('The Loop Runtime root must not be a symbolic link');
  }
  const [physicalProjectRoot, physicalRuntimeDir] = await Promise.all([
    fs.realpath(resolvedProjectRoot),
    physicalPath(runtimeDir),
  ]);
  if (!inside(physicalProjectRoot, physicalRuntimeDir)) {
    throw new Error('The Loop Runtime root resolves outside the project root');
  }
  return {
    projectRoot: resolvedProjectRoot,
    configFile: path.join(projectRoot, ...PROJECT_CONFIG_FILE.split('/')),
    artifactRoot,
    artifactRootRef: normalized,
    loopRoot,
    specsDir: path.join(loopRoot, 'specs'),
    changesDir: path.join(loopRoot, 'changes'),
    archiveDir: path.join(loopRoot, 'archive'),
    runtimeDir,
    changesRuntimeDir: path.join(runtimeDir, 'changes'),
    locksDir: path.join(runtimeDir, 'locks'),
    transactionsDir: path.join(runtimeDir, 'transactions'),
  };
}

export async function ensureLoopDirectories(paths: LoopProjectPaths): Promise<void> {
  await Promise.all(
    [paths.specsDir, paths.changesDir, paths.archiveDir].map(async (directory) => {
      await resolveContainedLoopPath(paths.loopRoot, directory);
      await fs.mkdir(directory, { recursive: true });
    }),
  );
  await Promise.all(
    [paths.changesRuntimeDir, paths.locksDir, paths.transactionsDir].map(async (directory) => {
      await resolveContainedLoopPath(paths.projectRoot, directory);
      await fs.mkdir(directory, { recursive: true });
    }),
  );
}

function assertLoopRuntimeChangeName(name: string): void {
  if (!LOOP_CHANGE_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid Loop change name: ${name}`);
  }
}

export function loopPreferredChangeRuntimeDir(paths: LoopProjectPaths, name: string): string {
  assertLoopRuntimeChangeName(name);
  const target = path.join(paths.changesRuntimeDir, name);
  if (!isInsidePath(paths.changesRuntimeDir, target)) {
    throw new Error('Loop change Runtime path escaped');
  }
  return target;
}

export function loopLegacyChangeRuntimeDir(paths: LoopProjectPaths, name: string): string {
  assertLoopRuntimeChangeName(name);
  const target = path.join(paths.changesDir, name, 'runtime');
  if (!isInsidePath(paths.changesDir, target)) {
    throw new Error('Legacy Loop change Runtime path escaped');
  }
  return target;
}

/**
 * Resolve the physical Runtime root for a change. New Runtime wins whenever it exists;
 * otherwise an existing legacy `<change>/runtime` remains readable until Doctor migrates it.
 * A missing Runtime resolves to the preferred new location so all new writes use `.owner`.
 */
export function loopChangeRuntimeDir(paths: LoopProjectPaths, name: string): string {
  const preferred = loopPreferredChangeRuntimeDir(paths, name);
  if (existsSync(preferred)) return preferred;
  const legacy = loopLegacyChangeRuntimeDir(paths, name);
  return existsSync(legacy) ? legacy : preferred;
}

export interface LoopRuntimeStorageInspection {
  status: 'available' | 'missing' | 'invalid';
  layout: 'project-local' | 'legacy' | 'missing';
  path: string;
  message?: string;
}

async function inspectRuntimeDirectory(
  target: string,
): Promise<'directory' | 'missing' | 'invalid'> {
  try {
    const stat = await fs.lstat(target);
    return stat.isDirectory() && !stat.isSymbolicLink() ? 'directory' : 'invalid';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

/** Read-only storage health used by status/doctor before opening machine-owned files. */
export async function inspectLoopRuntimeStorage(
  paths: LoopProjectPaths,
  name: string,
): Promise<LoopRuntimeStorageInspection> {
  const preferred = loopPreferredChangeRuntimeDir(paths, name);
  const legacy = loopLegacyChangeRuntimeDir(paths, name);
  const [preferredKind, legacyKind] = await Promise.all([
    inspectRuntimeDirectory(preferred),
    inspectRuntimeDirectory(legacy),
  ]);
  if (preferredKind === 'invalid') {
    return {
      status: 'invalid',
      layout: 'project-local',
      path: preferred,
      message: 'Loop Runtime path must be a real directory',
    };
  }
  if (legacyKind === 'invalid') {
    return {
      status: 'invalid',
      layout: 'legacy',
      path: legacy,
      message: 'Legacy Loop Runtime path must be a real directory',
    };
  }
  if (preferredKind === 'directory' && legacyKind === 'directory') {
    return {
      status: 'invalid',
      layout: 'project-local',
      path: preferred,
      message: 'Both project-local and legacy Loop Runtime directories exist',
    };
  }
  if (preferredKind === 'directory') {
    return { status: 'available', layout: 'project-local', path: preferred };
  }
  if (legacyKind === 'directory') {
    return { status: 'available', layout: 'legacy', path: legacy };
  }
  return { status: 'missing', layout: 'missing', path: preferred };
}

export function loopRuntimeRefFile(runtimeDir: string, ref: string): string {
  if (!ref.startsWith('runtime/') || path.isAbsolute(ref) || ref.split(/[\\/]/u).includes('..')) {
    throw new Error(`Invalid Loop Runtime ref: ${ref}`);
  }
  const target = path.resolve(runtimeDir, ...ref.slice('runtime/'.length).split('/'));
  if (!isInsidePath(runtimeDir, target)) throw new Error(`Loop Runtime ref escaped: ${ref}`);
  return target;
}

export function loopStorageRoot(paths: LoopProjectPaths, target: string): string {
  const absolute = path.resolve(target);
  if (isInsidePath(paths.runtimeDir, absolute)) return paths.runtimeDir;
  if (isInsidePath(paths.loopRoot, absolute)) return paths.loopRoot;
  throw new Error(`Path is outside Loop document and Runtime roots: ${target}`);
}

export function isInsidePath(parent: string, target: string): boolean {
  return inside(path.resolve(parent), path.resolve(target));
}

export async function resolveContainedLoopPath(root: string, target: string): Promise<string> {
  const lexicalRoot = path.resolve(root);
  const lexicalTarget = path.resolve(target);
  if (!inside(lexicalRoot, lexicalTarget)) {
    throw new Error(`Path is outside the Loop root: ${target}`);
  }
  if (await isSymbolicLink(lexicalRoot)) {
    throw new Error(`Loop root must not be a symbolic link: ${root}`);
  }
  const [physicalRoot, physicalTarget] = await Promise.all([
    physicalPath(lexicalRoot),
    physicalPath(lexicalTarget),
  ]);
  if (!inside(physicalRoot, physicalTarget)) {
    throw new Error(`Path resolves outside the Loop root: ${target}`);
  }
  return lexicalTarget;
}
