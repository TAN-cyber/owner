import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  inspectGitWorktree,
  isLocalGitBranch,
  resolveGitRef,
} from '../../platform/paths/git-worktree.js';

import { atomicWriteJson } from './loop-atomic-file.js';
import { readLoopBoundedTextFile } from './loop-bounded-file.js';
import { withLoopMutationLock } from './loop-mutation-lock.js';
import { loopChangeRuntimeDir, loopStorageRoot, resolveContainedLoopPath } from './loop-paths.js';
import type { LoopProjectPaths, LoopWorkspaceProjection } from './loop-types.js';

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const GIT_COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const MAX_WORKSPACE_IDENTITY_BYTES = 16 * 1024;
const HOST_PLATFORM = process.platform;

export type LoopWorkspaceIsolation = 'current' | 'branch' | 'worktree';
export type LoopWorkspaceFinish = 'merge' | 'push' | 'pull-request' | 'keep';

export interface LoopWorkspaceBinding {
  isolation: LoopWorkspaceIsolation;
  changeBranch: string | null;
  targetBranch: string | null;
}

export interface LoopWorkspaceGitProvenance {
  provider: 'git';
  baseCommit: string;
  targetBranch: string;
  targetCommit: string;
}

interface LoopWorkspaceIdentityFields {
  capturedAt: string;
  capturedRevision: number;
  loopRootRef: string;
  projectRootId: string;
  loopRootId: string;
  /** Stable real-path hashes used for root drift decisions. */
  projectRootPathId?: string;
  loopRootPathId?: string;
  sessionHash?: string;
  git?: LoopWorkspaceGitProvenance;
}

export interface LoopWorkspaceIdentityV2 extends LoopWorkspaceIdentityFields {
  schema: 'owner.loop.workspace.v2';
}

export interface LoopWorkspaceIdentityV3 extends LoopWorkspaceIdentityFields, LoopWorkspaceBinding {
  schema: 'owner.loop.workspace.v3';
  finish: LoopWorkspaceFinish | null;
}

export type LoopWorkspaceIdentity = LoopWorkspaceIdentityV2 | LoopWorkspaceIdentityV3;

export interface LoopWorkspaceBindingInspection {
  state: 'legacy' | 'aligned' | 'drifted';
  code:
    | 'workspace-binding-legacy'
    | 'workspace-binding-root-changed'
    | 'workspace-branch-changed'
    | 'workspace-kind-changed'
    | 'workspace-vcs-unavailable'
    | null;
  message: string | null;
}

export type LoopWorkspaceDriftComponent =
  | 'loop-root-ref'
  | 'project-root-path'
  | 'loop-root-path'
  | 'project-root-legacy-identity'
  | 'loop-root-legacy-identity';

export type LoopWorkspaceFindingCode =
  | 'workspace-root-changed'
  | 'workspace-inspection-unavailable';

export const LOOP_WORKSPACE_ADVISORY_CODES: ReadonlySet<LoopWorkspaceFindingCode> = new Set([
  'workspace-root-changed',
  'workspace-inspection-unavailable',
]);

export function isLoopWorkspaceAdvisoryCode(code: string): code is LoopWorkspaceFindingCode {
  return LOOP_WORKSPACE_ADVISORY_CODES.has(code as LoopWorkspaceFindingCode);
}

export interface LoopWorkspaceAdvisory {
  state: 'aligned' | 'drifted' | 'unknown';
  findingCodes: LoopWorkspaceFindingCode[];
  driftComponents: LoopWorkspaceDriftComponent[];
}

export interface CaptureLoopWorkspaceOptions {
  paths: LoopProjectPaths;
  name: string;
  revision: number;
  now?: Date;
  sessionId?: string;
  binding?: LoopWorkspaceBinding;
  finish?: LoopWorkspaceFinish;
}

export interface ResolveLoopWorkspaceBindingOptions {
  projectRoot: string;
  isolation: LoopWorkspaceIsolation;
  changeBranch?: string;
  targetBranch?: string;
}

function portableRelative(parent: string, target: string): string | null {
  const relative = path.relative(parent, target);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    return null;
  }
  return relative.replaceAll('\\', '/') || '.';
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
}

function normalizedPortableRef(value: string, label: string): string {
  if (
    value.length === 0 ||
    hasControlCharacter(value) ||
    value.includes('\\') ||
    path.posix.isAbsolute(value) ||
    /^(?:[A-Za-z]:|~)/u.test(value) ||
    value.split('/').includes('..')
  ) {
    throw new Error(`${label} must be a portable project-relative path`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`${label} must be a normalized project-relative path`);
  }
  return normalized;
}

function identityHash(tag: string, value: string): string {
  return createHash('sha256').update(`${tag}\n${value}`).digest('hex');
}

async function physicalDirectoryIdentity(tag: string, value: string): Promise<string> {
  const realPath = await fs.realpath(value);
  const stat = await fs.lstat(realPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Loop workspace identity requires a real directory');
  }
  const normalizedPath =
    HOST_PLATFORM === 'win32' ? path.normalize(realPath).toLowerCase() : realPath;
  return identityHash(tag, `${normalizedPath}\n${stat.dev}\n${stat.ino}\n${stat.birthtimeMs}`);
}

async function directoryPathIdentity(tag: string, value: string): Promise<string> {
  const realPath = await fs.realpath(value);
  const stat = await fs.lstat(realPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Loop workspace identity requires a real directory');
  }
  const normalizedPath =
    HOST_PLATFORM === 'win32' ? path.normalize(realPath).toLowerCase() : realPath;
  return identityHash(tag, normalizedPath);
}

function isoTimestamp(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Loop workspace capturedAt is invalid');
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error('Loop workspace capturedAt is invalid');
  }
  return value;
}

function optionalBranch(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    hasControlCharacter(value)
  ) {
    throw new Error(`${label} must be a non-empty branch name or null`);
  }
  return value;
}

function assertBinding(value: LoopWorkspaceBinding): void {
  if (!new Set<LoopWorkspaceIsolation>(['current', 'branch', 'worktree']).has(value.isolation)) {
    throw new Error('Loop workspace isolation must be current, branch, or worktree');
  }
  optionalBranch(value.changeBranch, 'Loop workspace change branch');
  optionalBranch(value.targetBranch, 'Loop workspace target branch');
  if (
    (value.isolation === 'branch' || value.isolation === 'worktree') &&
    (value.changeBranch === null || value.targetBranch === null)
  ) {
    throw new Error('Loop isolated workspace requires change and target branches');
  }
}

function assertGitProvenance(value: unknown): asserts value is LoopWorkspaceGitProvenance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Loop workspace Git provenance must be an object');
  }
  const root = value as Record<string, unknown>;
  const allowed = new Set(['provider', 'baseCommit', 'targetBranch', 'targetCommit']);
  const unknown = Object.keys(root).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`Loop workspace Git provenance has unknown field(s): ${unknown.join(', ')}`);
  }
  if (
    root.provider !== 'git' ||
    typeof root.baseCommit !== 'string' ||
    !GIT_COMMIT_PATTERN.test(root.baseCommit) ||
    typeof root.targetCommit !== 'string' ||
    !GIT_COMMIT_PATTERN.test(root.targetCommit)
  ) {
    throw new Error('Loop workspace Git provenance is invalid');
  }
  optionalBranch(root.targetBranch, 'Loop workspace Git target branch');
}

function assertIdentity(value: unknown): asserts value is LoopWorkspaceIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Loop workspace identity must be an object');
  }
  const root = value as Record<string, unknown>;
  const allowed = new Set([
    'schema',
    'capturedAt',
    'capturedRevision',
    'loopRootRef',
    'projectRootId',
    'loopRootId',
    'projectRootPathId',
    'loopRootPathId',
    'sessionHash',
    'git',
    'isolation',
    'changeBranch',
    'targetBranch',
    'finish',
  ]);
  const unknown = Object.keys(root).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`Loop workspace identity has unknown field(s): ${unknown.join(', ')}`);
  }
  if (root.schema !== 'owner.loop.workspace.v2' && root.schema !== 'owner.loop.workspace.v3') {
    throw new Error('Unsupported Loop workspace identity');
  }
  if (
    !Number.isSafeInteger(root.capturedRevision) ||
    (root.capturedRevision as number) < 1 ||
    typeof root.loopRootRef !== 'string' ||
    !HASH_PATTERN.test(String(root.projectRootId)) ||
    !HASH_PATTERN.test(String(root.loopRootId))
  ) {
    throw new Error('Loop workspace identity is invalid');
  }
  isoTimestamp(root.capturedAt);
  normalizedPortableRef(root.loopRootRef, 'Loop workspace root ref');
  const hasProjectPathId = root.projectRootPathId !== undefined;
  const hasLoopPathId = root.loopRootPathId !== undefined;
  if (hasProjectPathId !== hasLoopPathId) {
    throw new Error('Loop workspace path identities must be provided together');
  }
  if (
    (hasProjectPathId && !HASH_PATTERN.test(String(root.projectRootPathId))) ||
    (hasLoopPathId && !HASH_PATTERN.test(String(root.loopRootPathId)))
  ) {
    throw new Error('Loop workspace path identity is invalid');
  }
  if (root.sessionHash !== undefined && !HASH_PATTERN.test(String(root.sessionHash))) {
    throw new Error('Loop workspace session hash is invalid');
  }
  if (root.git !== undefined) assertGitProvenance(root.git);
  if (root.schema === 'owner.loop.workspace.v2') {
    if (
      root.isolation !== undefined ||
      root.changeBranch !== undefined ||
      root.targetBranch !== undefined ||
      root.finish !== undefined
    ) {
      throw new Error('Loop workspace v2 identity cannot contain a workspace binding');
    }
    return;
  }
  if (
    typeof root.isolation !== 'string' ||
    root.changeBranch === undefined ||
    root.targetBranch === undefined ||
    root.finish === undefined
  ) {
    throw new Error('Loop workspace v3 identity requires a workspace binding');
  }
  assertBinding(root as unknown as LoopWorkspaceBinding);
  if (
    root.finish !== null &&
    !new Set<LoopWorkspaceFinish>(['merge', 'push', 'pull-request', 'keep']).has(
      root.finish as LoopWorkspaceFinish,
    )
  ) {
    throw new Error('Loop workspace finish must be merge, push, pull-request, keep, or null');
  }
}

export function resolveLoopWorkspaceBinding(
  options: ResolveLoopWorkspaceBindingOptions,
): LoopWorkspaceBinding {
  const context = inspectGitWorktree(options.projectRoot);
  if (!context.isGitWorktree) {
    if (
      options.isolation !== 'current' ||
      options.changeBranch !== undefined ||
      options.targetBranch !== undefined
    ) {
      throw new Error('Loop branch and worktree isolation require a Git working directory');
    }
    return { isolation: 'current', changeBranch: null, targetBranch: null };
  }
  if (context.currentBranch === null) {
    throw new Error('Loop workspace binding requires a branch; detached HEAD is not supported');
  }
  if (options.changeBranch !== undefined && options.changeBranch !== context.currentBranch) {
    throw new Error(
      `Loop change branch ${options.changeBranch} does not match the current branch ${context.currentBranch}`,
    );
  }
  if (options.isolation === 'worktree' && !context.isSecondaryWorktree) {
    throw new Error('Loop worktree isolation must be created in a linked Git worktree');
  }
  if (
    (options.isolation === 'branch' || options.isolation === 'worktree') &&
    options.targetBranch === undefined
  ) {
    throw new Error(`Loop ${options.isolation} isolation requires --target-branch`);
  }
  if (
    options.targetBranch !== undefined &&
    !isLocalGitBranch(options.projectRoot, options.targetBranch)
  ) {
    throw new Error(`Loop target branch is not a verified local branch: ${options.targetBranch}`);
  }
  const binding: LoopWorkspaceBinding = {
    isolation: options.isolation,
    changeBranch: context.currentBranch,
    targetBranch: options.targetBranch ?? context.currentBranch,
  };
  assertBinding(binding);
  return binding;
}

export function assertLoopWorkspaceBindingCurrent(
  projectRoot: string,
  expected: LoopWorkspaceBinding,
): void {
  const current = resolveLoopWorkspaceBinding({
    projectRoot,
    isolation: expected.isolation,
    ...(expected.changeBranch !== null ? { changeBranch: expected.changeBranch } : {}),
    ...(expected.isolation !== 'current' && expected.targetBranch !== null
      ? { targetBranch: expected.targetBranch }
      : {}),
  });
  if (
    current.isolation !== expected.isolation ||
    current.changeBranch !== expected.changeBranch ||
    current.targetBranch !== expected.targetBranch
  ) {
    throw new Error('Loop workspace binding changed before change creation');
  }
}

export function loopWorkspaceFile(paths: LoopProjectPaths, name: string): string {
  return path.join(loopChangeRuntimeDir(paths, name), 'workspace.json');
}

function loopWorkspaceRef(paths: LoopProjectPaths, name: string): { root: string; ref: string } {
  const file = loopWorkspaceFile(paths, name);
  const root = loopStorageRoot(paths, file);
  const relative = portableRelative(root, file);
  if (!relative || relative === '.') throw new Error('Loop workspace file escaped its root');
  return { root, ref: normalizedPortableRef(relative, 'Loop workspace file ref') };
}

async function readLoopWorkspaceValue(
  paths: LoopProjectPaths,
  name: string,
): Promise<unknown | null> {
  try {
    const workspace = loopWorkspaceRef(paths, name);
    const artifact = await readLoopBoundedTextFile({
      root: workspace.root,
      ref: workspace.ref,
      maxBytes: MAX_WORKSPACE_IDENTITY_BYTES,
    });
    return JSON.parse(artifact.text) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function inspectLoopWorkspaceSchema(
  paths: LoopProjectPaths,
  name: string,
): Promise<
  'owner.loop.workspace.v1' | 'owner.loop.workspace.v2' | 'owner.loop.workspace.v3' | null
> {
  const value = await readLoopWorkspaceValue(paths, name);
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Loop workspace identity must be an object');
  }
  const schema = (value as { schema?: unknown }).schema;
  if (
    schema === 'owner.loop.workspace.v1' ||
    schema === 'owner.loop.workspace.v2' ||
    schema === 'owner.loop.workspace.v3'
  ) {
    if (schema !== 'owner.loop.workspace.v1') assertIdentity(value);
    return schema;
  }
  throw new Error('Unsupported Loop workspace identity');
}

export async function projectLoopWorkspace(
  paths: LoopProjectPaths,
  name: string,
): Promise<LoopWorkspaceProjection> {
  const context = inspectGitWorktree(paths.projectRoot);
  const base = {
    projectRoot: path.resolve(paths.projectRoot),
    currentBranch: context.currentBranch,
    isSecondaryWorktree: context.isSecondaryWorktree,
  };
  try {
    const identity = await readLoopWorkspaceIdentity(paths, name);
    if (identity === null) {
      return {
        ...base,
        bindingState: 'missing',
        isolation: null,
        changeBranch: null,
        targetBranch: null,
        finish: null,
      };
    }
    if (identity.schema !== 'owner.loop.workspace.v3') {
      return {
        ...base,
        bindingState: 'legacy',
        isolation: null,
        changeBranch: null,
        targetBranch: identity.git?.targetBranch ?? null,
        finish: null,
      };
    }
    const inspection = await inspectLoopWorkspaceBinding({ paths, identity });
    return {
      ...base,
      bindingState: inspection.state === 'aligned' ? 'aligned' : 'drifted',
      isolation: identity.isolation,
      changeBranch: identity.changeBranch,
      targetBranch: identity.targetBranch,
      finish: identity.finish,
    };
  } catch {
    return {
      ...base,
      bindingState: 'invalid',
      isolation: null,
      changeBranch: null,
      targetBranch: null,
      finish: null,
    };
  }
}

export async function loopWorkspaceIdentityNeedsMigration(
  paths: LoopProjectPaths,
  name: string,
): Promise<boolean> {
  const value = await readLoopWorkspaceValue(paths, name);
  if (value === null) return false;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Loop workspace identity must be an object');
  }
  if ((value as { schema?: unknown }).schema === 'owner.loop.workspace.v1') return true;
  assertIdentity(value);
  if (value.schema === 'owner.loop.workspace.v3') return false;
  return value.projectRootPathId === undefined || value.loopRootPathId === undefined;
}

export async function inspectLoopWorkspaceIdentity(
  options: CaptureLoopWorkspaceOptions,
): Promise<LoopWorkspaceIdentity> {
  if (!Number.isSafeInteger(options.revision) || options.revision < 1) {
    throw new Error('Loop workspace revision must be a positive integer');
  }
  const loopRootRef = portableRelative(options.paths.projectRoot, options.paths.loopRoot);
  if (!loopRootRef) throw new Error('Loop root is outside the project root');
  const gitContext = inspectGitWorktree(options.paths.projectRoot);
  const baseCommit = gitContext.isGitWorktree
    ? resolveGitRef(options.paths.projectRoot, 'HEAD')
    : null;
  const targetBranch = options.binding?.targetBranch ?? gitContext.currentBranch;
  const targetCommit =
    targetBranch === null || targetBranch === undefined
      ? null
      : resolveGitRef(options.paths.projectRoot, targetBranch);
  const git =
    baseCommit !== null &&
    targetBranch !== null &&
    targetBranch !== undefined &&
    targetCommit !== null
      ? {
          provider: 'git' as const,
          baseCommit,
          targetBranch,
          targetCommit,
        }
      : undefined;
  const [projectRootId, loopRootId, projectRootPathId, loopRootPathId] = await Promise.all([
    physicalDirectoryIdentity('owner.loop.workspace-project-root.v2', options.paths.projectRoot),
    physicalDirectoryIdentity('owner.loop.workspace-loop-root.v2', options.paths.loopRoot),
    directoryPathIdentity('owner.loop.workspace-project-root-path.v2', options.paths.projectRoot),
    directoryPathIdentity('owner.loop.workspace-loop-root-path.v2', options.paths.loopRoot),
  ]);
  const capturedAt = (options.now ?? new Date()).toISOString();
  if (options.finish && !options.binding) {
    throw new Error('Loop workspace finish requires a workspace binding');
  }
  if (options.binding) assertBinding(options.binding);
  const fields: LoopWorkspaceIdentityFields = {
    capturedAt,
    capturedRevision: options.revision,
    loopRootRef,
    projectRootId,
    loopRootId,
    projectRootPathId,
    loopRootPathId,
    ...(git ? { git } : {}),
    ...(options.sessionId
      ? {
          sessionHash: identityHash(
            'owner.loop.workspace-session.v2',
            `${projectRootId}\n${loopRootId}\n${options.sessionId}`,
          ),
        }
      : {}),
  };
  const identity: LoopWorkspaceIdentity = options.binding
    ? {
        schema: 'owner.loop.workspace.v3',
        ...fields,
        ...options.binding,
        finish: options.finish ?? null,
      }
    : { schema: 'owner.loop.workspace.v2', ...fields };
  assertIdentity(identity);
  return identity;
}

export async function writeLoopWorkspaceIdentity(
  options: CaptureLoopWorkspaceOptions,
): Promise<LoopWorkspaceIdentity> {
  const identity = await inspectLoopWorkspaceIdentity(options);
  const file = loopWorkspaceFile(options.paths, options.name);
  const storageRoot = loopStorageRoot(options.paths, file);
  await resolveContainedLoopPath(storageRoot, file);
  await atomicWriteJson(file, identity, { containedRoot: storageRoot });
  return identity;
}

export async function setLoopWorkspaceFinish(
  paths: LoopProjectPaths,
  name: string,
  finish: LoopWorkspaceFinish,
): Promise<LoopWorkspaceIdentityV3> {
  return withLoopMutationLock(paths, `set workspace finish for ${name}`, async () => {
    const identity = await assertLoopWorkspaceBinding(paths, name);
    if (identity === null || identity.schema !== 'owner.loop.workspace.v3') {
      throw new Error(`Loop change ${name} has no workspace finishing contract`);
    }
    if (identity.isolation === 'current') {
      throw new Error('Loop current isolation does not use a workspace finishing action');
    }
    const updated: LoopWorkspaceIdentityV3 = { ...identity, finish };
    assertIdentity(updated);
    const file = loopWorkspaceFile(paths, name);
    const storageRoot = loopStorageRoot(paths, file);
    await resolveContainedLoopPath(storageRoot, file);
    await atomicWriteJson(file, updated, { containedRoot: storageRoot });
    return updated;
  });
}

export async function readLoopWorkspaceIdentity(
  paths: LoopProjectPaths,
  name: string,
): Promise<LoopWorkspaceIdentity | null> {
  const value = await readLoopWorkspaceValue(paths, name);
  if (value === null) return null;
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as { schema?: unknown }).schema === 'owner.loop.workspace.v1'
  ) {
    // v1 depended on an external Git probe. It is ignored as advisory-only legacy data.
    return null;
  }
  assertIdentity(value);
  return value;
}

export async function migrateLegacyLoopWorkspaceIdentity(options: {
  paths: LoopProjectPaths;
  name: string;
  revision: number;
  now?: Date;
}): Promise<LoopWorkspaceIdentity | null> {
  if (!(await loopWorkspaceIdentityNeedsMigration(options.paths, options.name))) {
    return null;
  }
  return writeLoopWorkspaceIdentity(options);
}

export async function inspectLoopWorkspaceAdvisory(options: {
  paths: LoopProjectPaths;
  identity: LoopWorkspaceIdentity;
}): Promise<LoopWorkspaceAdvisory> {
  assertIdentity(options.identity);
  const current = await inspectLoopWorkspaceIdentity({
    paths: options.paths,
    name: 'workspace-advisory',
    revision: options.identity.capturedRevision,
  });
  const driftComponents: LoopWorkspaceDriftComponent[] = [];
  const codes: LoopWorkspaceFindingCode[] = [];
  if (current.loopRootRef !== options.identity.loopRootRef) {
    driftComponents.push('loop-root-ref');
  }
  if (options.identity.projectRootPathId && options.identity.loopRootPathId) {
    if (current.projectRootPathId !== options.identity.projectRootPathId) {
      driftComponents.push('project-root-path');
    }
    if (current.loopRootPathId !== options.identity.loopRootPathId) {
      driftComponents.push('loop-root-path');
    }
  } else {
    if (current.projectRootId !== options.identity.projectRootId) {
      driftComponents.push('project-root-legacy-identity');
    }
    if (current.loopRootId !== options.identity.loopRootId) {
      driftComponents.push('loop-root-legacy-identity');
    }
  }
  const onlyUnstableWindowsLegacyHashes =
    HOST_PLATFORM === 'win32' &&
    driftComponents.length > 0 &&
    driftComponents.every(
      (component) =>
        component === 'project-root-legacy-identity' || component === 'loop-root-legacy-identity',
    );
  if (onlyUnstableWindowsLegacyHashes) {
    codes.push('workspace-inspection-unavailable');
  } else if (driftComponents.length > 0) {
    codes.push('workspace-root-changed');
  }
  return {
    state:
      codes.length === 0
        ? 'aligned'
        : codes.includes('workspace-root-changed')
          ? 'drifted'
          : 'unknown',
    findingCodes: codes,
    driftComponents,
  };
}

export async function inspectLoopWorkspaceBinding(options: {
  paths: LoopProjectPaths;
  identity: LoopWorkspaceIdentity;
}): Promise<LoopWorkspaceBindingInspection> {
  assertIdentity(options.identity);
  if (options.identity.schema === 'owner.loop.workspace.v2') {
    return {
      state: 'legacy',
      code: 'workspace-binding-legacy',
      message: 'Legacy Loop workspace metadata has no isolation binding',
    };
  }
  const advisory = await inspectLoopWorkspaceAdvisory(options);
  if (advisory.state === 'drifted') {
    return {
      state: 'drifted',
      code: 'workspace-binding-root-changed',
      message: 'Loop change is being accessed from a different working directory',
    };
  }
  const context = inspectGitWorktree(options.paths.projectRoot);
  if (options.identity.changeBranch === null) {
    return context.isGitWorktree
      ? {
          state: 'drifted',
          code: 'workspace-branch-changed',
          message: 'Loop change was created outside Git but is now being accessed inside Git',
        }
      : { state: 'aligned', code: null, message: null };
  }
  if (!context.isGitWorktree) {
    return {
      state: 'drifted',
      code: 'workspace-vcs-unavailable',
      message: 'Loop change requires its bound Git working directory',
    };
  }
  if (context.currentBranch !== options.identity.changeBranch) {
    return {
      state: 'drifted',
      code: 'workspace-branch-changed',
      message: `Loop change is bound to branch ${options.identity.changeBranch}, but the current branch is ${context.currentBranch ?? 'detached HEAD'}`,
    };
  }
  if (options.identity.isolation === 'worktree' && !context.isSecondaryWorktree) {
    return {
      state: 'drifted',
      code: 'workspace-kind-changed',
      message: 'Loop change is bound to a linked Git worktree',
    };
  }
  return { state: 'aligned', code: null, message: null };
}

export async function assertLoopWorkspaceBinding(
  paths: LoopProjectPaths,
  name: string,
): Promise<LoopWorkspaceIdentity | null> {
  const identity = await readLoopWorkspaceIdentity(paths, name);
  if (identity === null) return null;
  const inspection = await inspectLoopWorkspaceBinding({ paths, identity });
  if (inspection.state === 'drifted') {
    throw new Error(`${inspection.code}: ${inspection.message}`);
  }
  return identity;
}
