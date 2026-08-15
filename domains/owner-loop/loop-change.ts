import { promises as fs } from 'fs';
import path from 'path';
import { parseDocument, stringify } from 'yaml';

import { listGitWorktreeRoots } from '../../platform/paths/git-worktree.js';

import { readLoopBoundedTextFile } from './loop-bounded-file.js';
import { atomicWriteText } from './loop-atomic-file.js';
import {
  assertNoPendingLoopRootMove,
  DEFAULT_LOOP_SNAPSHOT_CONFIG,
  readProjectConfig,
  writeProjectConfig,
} from './loop-config.js';
import { withLoopMutationLock } from './loop-mutation-lock.js';
import {
  isInsidePath,
  loopChangeRuntimeDir,
  loopPreferredChangeRuntimeDir,
  loopProjectPaths,
  resolveContainedLoopPath,
} from './loop-paths.js';
import { readLoopProtectedDirectory } from './loop-protected-file.js';
import { compareAndSwapLoopRevision } from './loop-revision.js';
import {
  createLoopContentSnapshot,
  inspectLoopContentSnapshotHealth,
  readLoopBaselineManifest,
  writeLoopBaselineManifest,
} from './loop-snapshot.js';
import { assertLoopTrajectoryHealthy } from './loop-trajectory-recovery.js';
import {
  assertLoopWorkspaceBindingCurrent,
  assertLoopWorkspaceBinding,
  inspectLoopWorkspaceAdvisory,
  inspectLoopWorkspaceBinding,
  readLoopWorkspaceIdentity,
  writeLoopWorkspaceIdentity,
  type LoopWorkspaceBinding,
} from './loop-workspace.js';
import type {
  LoopApproval,
  LoopChangeSchemaInspection,
  LoopChangeState,
  OwnerProjectConfig,
  LoopContentSnapshotManifest,
  LoopContentAddressedRef,
  LoopLegacyChangeState,
  LoopPhase,
  LoopProjectPaths,
  LoopSpecChange,
  LoopVerificationResult,
  LoopVerificationProtocol,
  LoopV2ChangeState,
} from './loop-types.js';
import {
  LOOP_CHANGE_SCHEMA,
  LOOP_LEGACY_CHANGE_SCHEMA,
  LOOP_RUNTIME_PROTOCOL_VERSION,
  LOOP_V2_CHANGE_SCHEMA,
} from './loop-types.js';

const CHANGE_KEYS = [
  'schema',
  'name',
  'language',
  'phase',
  'brief',
  'approval',
  'spec_changes',
  'verification_result',
  'verification_report',
  'archived',
  'created_at',
  'run_id',
] as const;
const LEGACY_CHANGE_KEYS = new Set<string>(CHANGE_KEYS);
const V2_CHANGE_KEYS = new Set<string>([...CHANGE_KEYS, 'minimum_runtime_version', 'revision']);
const CURRENT_CHANGE_KEYS = new Set<string>([
  ...V2_CHANGE_KEYS,
  'approved_contract_hash',
  'implementation_scope',
  'verification_evidence',
  'partial_allowance',
  'verification_protocol',
]);
const SPEC_CHANGE_KEYS = new Set(['capability', 'operation', 'source', 'base_hash']);
const PHASES = new Set<LoopPhase>(['shape', 'build', 'verify', 'archive']);
const APPROVALS = new Set<Exclude<LoopApproval, null>>(['implicit', 'confirmed']);
const VERIFY_RESULTS = new Set<LoopVerificationResult>(['pending', 'pass', 'fail']);

export const LOOP_CHANGE_STATE_FILE = 'owner-state.yaml';
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const CONTENT_ADDRESSED_REF_PATTERN =
  /^runtime\/evidence\/(scopes|allowances|verifications)\/([a-f0-9]{64})\.json$/u;

export class LoopSchemaMigrationRequiredError extends Error {
  readonly code = 'loop-schema-migration-required';

  constructor(
    readonly change: string,
    readonly schema: string,
  ) {
    super(
      `Loop change ${change} uses ${schema}; run owner loop doctor ${change} --repair before mutating it`,
    );
    this.name = 'LoopSchemaMigrationRequiredError';
  }
}

export class LoopRuntimeCompatibilityError extends Error {
  readonly code = 'loop-runtime-incompatible';

  constructor(
    readonly schema: string,
    readonly minimumRuntimeVersion: number | null,
  ) {
    super(
      schema !== LOOP_CHANGE_SCHEMA || minimumRuntimeVersion === null
        ? `Unsupported Loop change schema ${schema} for runtime protocol ${LOOP_RUNTIME_PROTOCOL_VERSION}`
        : `Loop change ${schema} requires runtime protocol ${minimumRuntimeVersion}; current protocol is ${LOOP_RUNTIME_PROTOCOL_VERSION}`,
    );
    this.name = 'LoopRuntimeCompatibilityError';
  }
}

export class LoopChangeRevisionConflictError extends Error {
  readonly code = 'loop-change-revision-conflict';

  constructor(
    readonly change: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Loop change ${change} revision conflict: expected ${expectedRevision}, actual ${actualRevision}`,
    );
    this.name = 'LoopChangeRevisionConflictError';
  }
}

export class LoopWorkspaceIsolationRequiredError extends Error {
  readonly code = 'loop-workspace-isolation-required';

  constructor(
    readonly requestedIsolation: LoopWorkspaceBinding['isolation'],
    readonly activeChanges: string[],
  ) {
    super(
      `Loop working directory already contains active change${activeChanges.length === 1 ? '' : 's'} ${activeChanges.join(', ')}; create the new change in a separate worktree`,
    );
    this.name = 'LoopWorkspaceIsolationRequiredError';
  }
}

export class LoopBaselineIncompleteError extends Error {
  readonly code = 'loop-baseline-incomplete';

  constructor(
    readonly change: string,
    readonly omittedCount: number,
    readonly omittedByReason: Record<string, number>,
    readonly samplePaths: string[],
    readonly sampleTruncated: boolean,
    readonly effectiveLimits: LoopContentSnapshotManifest['limits'] | null = null,
    readonly policyHash: string | null = null,
  ) {
    super(
      `Loop change ${change} baseline is incomplete (${omittedCount} omitted entr${omittedCount === 1 ? 'y' : 'ies'}). Adjust loop.snapshot scope or resource budgets in .owner/config.yaml, then retry.`,
    );
    this.name = 'LoopBaselineIncompleteError';
  }
}

export const LOOP_BRIEF_TEMPLATE = [
  '# Outcome',
  '',
  '# Scope',
  '',
  '# Non-goals',
  '',
  '# Acceptance examples',
  '',
  '# Constraints and invariants',
  '',
  '# Decisions',
  '',
  '# Open questions',
  '',
  '# Verification expectations',
  '',
].join('\n');

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, known: Set<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !known.has(key));
  if (unknown.length > 0) throw new Error(`${label} has unknown field(s): ${unknown.join(', ')}`);
}

export function assertLoopName(value: string): void {
  if (!NAME_PATTERN.test(value)) throw new Error(`Invalid Loop change name: ${value}`);
}

export function assertCapabilityId(value: string): void {
  if (!NAME_PATTERN.test(value)) throw new Error(`Invalid Loop capability id: ${value}`);
}

function assertRelativeRef(value: string, label: string): void {
  if (
    value.length === 0 ||
    path.isAbsolute(value) ||
    /^(?:[A-Za-z]:|~|[\\/])/u.test(value) ||
    value.split(/[\\/]/u).includes('..')
  ) {
    throw new Error(`${label} must stay inside the Loop change`);
  }
}

function parseSpecChange(value: unknown, index: number): LoopSpecChange {
  const item = record(value, `spec_changes[${index}]`);
  rejectUnknown(item, SPEC_CHANGE_KEYS, `spec_changes[${index}]`);
  if (typeof item.capability !== 'string') throw new Error('spec change capability is required');
  assertCapabilityId(item.capability);
  if (item.operation !== 'create' && item.operation !== 'replace' && item.operation !== 'remove') {
    throw new Error(`Invalid spec operation for ${item.capability}`);
  }
  const source = item.source;
  const baseHash = item.base_hash;
  if (source !== undefined && typeof source !== 'string') {
    throw new Error(`Spec source for ${item.capability} must be a string`);
  }
  if (typeof source === 'string') assertRelativeRef(source, `Spec source for ${item.capability}`);
  if (item.operation === 'create') {
    if (!source) throw new Error(`Create spec ${item.capability} requires source`);
    if (baseHash !== null)
      throw new Error(`Create spec ${item.capability} requires null base_hash`);
  } else if (item.operation === 'replace') {
    if (!source) throw new Error(`Replace spec ${item.capability} requires source`);
    if (typeof baseHash !== 'string' || !HASH_PATTERN.test(baseHash)) {
      throw new Error(`Replace spec ${item.capability} requires a SHA-256 base_hash`);
    }
  } else {
    if (source !== undefined) throw new Error(`Remove spec ${item.capability} forbids source`);
    if (typeof baseHash !== 'string' || !HASH_PATTERN.test(baseHash)) {
      throw new Error(`Remove spec ${item.capability} requires a SHA-256 base_hash`);
    }
  }
  return {
    capability: item.capability,
    operation: item.operation,
    ...(typeof source === 'string' ? { source } : {}),
    base_hash: baseHash as string | null,
  };
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

type ParsedChangeFields = Omit<LoopLegacyChangeState, 'schema'>;

function parseChangeFields(
  root: Record<string, unknown>,
  knownKeys: Set<string>,
): ParsedChangeFields {
  rejectUnknown(root, knownKeys, LOOP_CHANGE_STATE_FILE);
  if (typeof root.name !== 'string') throw new Error('Loop change name is required');
  assertLoopName(root.name);
  if (root.language !== 'en' && root.language !== 'zh-CN') {
    throw new Error('Loop change language must be en or zh-CN');
  }
  if (typeof root.phase !== 'string' || !PHASES.has(root.phase as LoopPhase)) {
    throw new Error('Loop change phase is invalid');
  }
  if (root.brief !== 'brief.md') throw new Error('Loop change brief must be brief.md');
  if (root.approval !== null && !APPROVALS.has(root.approval as Exclude<LoopApproval, null>)) {
    throw new Error('Loop change approval is invalid');
  }
  if (!Array.isArray(root.spec_changes)) throw new Error('Loop spec_changes must be an array');
  const specChanges = root.spec_changes.map(parseSpecChange);
  const duplicates = specChanges
    .map((change) => change.capability)
    .filter((capability, index, all) => all.indexOf(capability) !== index);
  if (duplicates.length > 0) {
    throw new Error(`Duplicate Loop capability operation: ${[...new Set(duplicates)].join(', ')}`);
  }
  if (
    typeof root.verification_result !== 'string' ||
    !VERIFY_RESULTS.has(root.verification_result as LoopVerificationResult)
  ) {
    throw new Error('Loop verification_result is invalid');
  }
  if (root.verification_report !== null && typeof root.verification_report !== 'string') {
    throw new Error('Loop verification_report must be a string or null');
  }
  if (typeof root.verification_report === 'string') {
    assertRelativeRef(root.verification_report, 'Loop verification_report');
  }
  if (typeof root.archived !== 'boolean') throw new Error('Loop archived must be boolean');
  if (typeof root.created_at !== 'string' || !validDate(root.created_at)) {
    throw new Error('Loop created_at must be a valid YYYY-MM-DD date');
  }
  if (root.run_id !== null && (typeof root.run_id !== 'string' || root.run_id.length === 0)) {
    throw new Error('Loop run_id must be a non-empty string or null');
  }
  return {
    name: root.name,
    language: root.language,
    phase: root.phase as LoopPhase,
    brief: 'brief.md',
    approval: root.approval as LoopApproval,
    spec_changes: specChanges,
    verification_result: root.verification_result as LoopVerificationResult,
    verification_report: root.verification_report as string | null,
    archived: root.archived,
    created_at: root.created_at,
    run_id: root.run_id as string | null,
  };
}

export function parseLegacyLoopChangeValue(value: unknown): LoopLegacyChangeState {
  const root = record(value, LOOP_CHANGE_STATE_FILE);
  if (root.schema !== LOOP_LEGACY_CHANGE_SCHEMA) {
    throw new Error(`Expected ${LOOP_LEGACY_CHANGE_SCHEMA}`);
  }
  return {
    schema: LOOP_LEGACY_CHANGE_SCHEMA,
    ...parseChangeFields(root, LEGACY_CHANGE_KEYS),
  };
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value as number;
}

function contentAddressedRef(
  value: unknown,
  label: string,
  kind: 'scopes' | 'allowances' | 'verifications',
): LoopContentAddressedRef | null {
  if (value === null) return null;
  const match = typeof value === 'string' ? CONTENT_ADDRESSED_REF_PATTERN.exec(value) : null;
  if (!match || match[1] !== kind) {
    throw new Error(
      `${label} must be null or runtime/evidence/${kind}/<sha256>.json relative to the Loop change`,
    );
  }
  return value as LoopContentAddressedRef;
}

function approvedContractHash(value: unknown): string | null {
  // Early v3 files predate approval binding. Treat the absent field as an
  // unbound approval so status/transition guards can require confirmation.
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    throw new Error('Loop approved_contract_hash must be null or a SHA-256 hash');
  }
  return value;
}

function verificationProtocol(value: unknown): LoopVerificationProtocol {
  if (value === undefined) return 'legacy-v1';
  if (value !== 'legacy-v1') {
    throw new Error('Loop verification_protocol must be legacy-v1');
  }
  return value;
}

export function parseV2LoopChangeValue(value: unknown): LoopV2ChangeState {
  const root = record(value, LOOP_CHANGE_STATE_FILE);
  if (root.schema !== LOOP_V2_CHANGE_SCHEMA) {
    throw new Error(`Expected ${LOOP_V2_CHANGE_SCHEMA}`);
  }
  const minimumRuntimeVersion = positiveInteger(
    root.minimum_runtime_version,
    'Loop v2 minimum_runtime_version',
  );
  if (minimumRuntimeVersion !== 2) {
    throw new Error(`Loop ${LOOP_V2_CHANGE_SCHEMA} minimum_runtime_version must be 2`);
  }
  return {
    schema: LOOP_V2_CHANGE_SCHEMA,
    minimum_runtime_version: 2,
    revision: positiveInteger(root.revision, 'Loop v2 revision'),
    ...parseChangeFields(root, V2_CHANGE_KEYS),
  };
}

export function parseLoopChangeValue(value: unknown): LoopChangeState {
  const root = record(value, LOOP_CHANGE_STATE_FILE);
  if (root.schema !== LOOP_CHANGE_SCHEMA) {
    if (root.schema === LOOP_LEGACY_CHANGE_SCHEMA || root.schema === LOOP_V2_CHANGE_SCHEMA) {
      const previous =
        root.schema === LOOP_LEGACY_CHANGE_SCHEMA
          ? parseLegacyLoopChangeValue(root)
          : parseV2LoopChangeValue(root);
      throw new LoopSchemaMigrationRequiredError(previous.name, previous.schema);
    }
    throw new LoopRuntimeCompatibilityError(
      typeof root.schema === 'string' ? root.schema : '(missing)',
      typeof root.minimum_runtime_version === 'number' ? root.minimum_runtime_version : null,
    );
  }
  const minimumRuntimeVersion = positiveInteger(
    root.minimum_runtime_version,
    'Loop minimum_runtime_version',
  );
  if (minimumRuntimeVersion > LOOP_RUNTIME_PROTOCOL_VERSION) {
    throw new LoopRuntimeCompatibilityError(root.schema, minimumRuntimeVersion);
  }
  if (minimumRuntimeVersion !== LOOP_RUNTIME_PROTOCOL_VERSION) {
    throw new Error(
      `Loop ${root.schema} minimum_runtime_version must be ${LOOP_RUNTIME_PROTOCOL_VERSION}`,
    );
  }
  const revision = positiveInteger(root.revision, 'Loop revision');
  const fields = parseChangeFields(root, CURRENT_CHANGE_KEYS);
  const approvalHash = approvedContractHash(root.approved_contract_hash);
  if (fields.approval === null && approvalHash !== null) {
    throw new Error('Loop approved_contract_hash requires an approval');
  }
  return {
    schema: LOOP_CHANGE_SCHEMA,
    minimum_runtime_version: LOOP_RUNTIME_PROTOCOL_VERSION,
    revision,
    verification_protocol: verificationProtocol(root.verification_protocol),
    ...fields,
    approved_contract_hash: approvalHash,
    implementation_scope: contentAddressedRef(
      root.implementation_scope,
      'Loop implementation_scope',
      'scopes',
    ),
    verification_evidence: contentAddressedRef(
      root.verification_evidence,
      'Loop verification_evidence',
      'verifications',
    ),
    partial_allowance: contentAddressedRef(
      root.partial_allowance,
      'Loop partial_allowance',
      'allowances',
    ),
  };
}

export function inspectLoopChangeValue(value: unknown): LoopChangeSchemaInspection {
  const root = record(value, LOOP_CHANGE_STATE_FILE);
  if (root.schema === LOOP_LEGACY_CHANGE_SCHEMA) {
    const state = parseLegacyLoopChangeValue(root);
    return {
      status: 'migration-required',
      schema: state.schema,
      minimumRuntimeVersion: 1,
      state,
      message: `Loop change ${state.name} requires migration to ${LOOP_CHANGE_SCHEMA}`,
    };
  }
  if (root.schema === LOOP_V2_CHANGE_SCHEMA) {
    const state = parseV2LoopChangeValue(root);
    return {
      status: 'migration-required',
      schema: state.schema,
      minimumRuntimeVersion: state.minimum_runtime_version,
      state,
      message: `Loop change ${state.name} requires migration to ${LOOP_CHANGE_SCHEMA}`,
    };
  }
  if (root.schema !== LOOP_CHANGE_SCHEMA) {
    const minimumRuntimeVersion =
      typeof root.minimum_runtime_version === 'number' &&
      Number.isSafeInteger(root.minimum_runtime_version)
        ? root.minimum_runtime_version
        : null;
    return {
      status: 'runtime-incompatible',
      schema: typeof root.schema === 'string' ? root.schema : '(missing)',
      minimumRuntimeVersion,
      state: null,
      message: new LoopRuntimeCompatibilityError(
        typeof root.schema === 'string' ? root.schema : '(missing)',
        minimumRuntimeVersion,
      ).message,
    };
  }
  const minimumRuntimeVersion = positiveInteger(
    root.minimum_runtime_version,
    'Loop minimum_runtime_version',
  );
  if (minimumRuntimeVersion > LOOP_RUNTIME_PROTOCOL_VERSION) {
    return {
      status: 'runtime-incompatible',
      schema: root.schema,
      minimumRuntimeVersion,
      state: null,
      message: new LoopRuntimeCompatibilityError(root.schema, minimumRuntimeVersion).message,
    };
  }
  const state = parseLoopChangeValue(root);
  return {
    status: 'current',
    schema: state.schema,
    minimumRuntimeVersion: state.minimum_runtime_version,
    state,
  };
}

export function loopChangeDocument(state: LoopChangeState): Record<string, unknown> {
  const parsed = parseLoopChangeValue(state);
  return {
    schema: parsed.schema,
    minimum_runtime_version: parsed.minimum_runtime_version,
    revision: parsed.revision,
    verification_protocol: parsed.verification_protocol,
    name: parsed.name,
    language: parsed.language,
    phase: parsed.phase,
    brief: parsed.brief,
    approval: parsed.approval,
    approved_contract_hash: parsed.approved_contract_hash ?? null,
    spec_changes: parsed.spec_changes.map((change) => ({
      capability: change.capability,
      operation: change.operation,
      ...(change.source ? { source: change.source } : {}),
      base_hash: change.base_hash,
    })),
    verification_result: parsed.verification_result,
    verification_report: parsed.verification_report,
    implementation_scope: parsed.implementation_scope,
    verification_evidence: parsed.verification_evidence,
    partial_allowance: parsed.partial_allowance,
    archived: parsed.archived,
    created_at: parsed.created_at,
    run_id: parsed.run_id,
  };
}

export function loopV2ChangeDocument(state: LoopV2ChangeState): Record<string, unknown> {
  const parsed = parseV2LoopChangeValue(state);
  return {
    schema: parsed.schema,
    minimum_runtime_version: parsed.minimum_runtime_version,
    revision: parsed.revision,
    name: parsed.name,
    language: parsed.language,
    phase: parsed.phase,
    brief: parsed.brief,
    approval: parsed.approval,
    spec_changes: parsed.spec_changes.map((change) => ({
      capability: change.capability,
      operation: change.operation,
      ...(change.source ? { source: change.source } : {}),
      base_hash: change.base_hash,
    })),
    verification_result: parsed.verification_result,
    verification_report: parsed.verification_report,
    archived: parsed.archived,
    created_at: parsed.created_at,
    run_id: parsed.run_id,
  };
}

export function loopChangeDir(paths: LoopProjectPaths, name: string): string {
  assertLoopName(name);
  const target = path.join(paths.changesDir, name);
  if (!isInsidePath(paths.changesDir, target)) throw new Error('Loop change path escaped');
  return target;
}

export async function hasPendingLoopSchemaMigration(
  paths: LoopProjectPaths,
  name: string,
): Promise<boolean> {
  const runtimeDir = loopChangeRuntimeDir(paths, name);
  const file = path.join(runtimeDir, 'schema-migration.json');
  await resolveContainedLoopPath(
    isInsidePath(paths.runtimeDir, file) ? paths.runtimeDir : paths.loopRoot,
    file,
  );
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function hasPendingLoopCheckpointRecovery(
  paths: LoopProjectPaths,
  name: string,
): Promise<boolean> {
  const runtimeDir = loopChangeRuntimeDir(paths, name);
  const file = path.join(runtimeDir, 'checkpoint-journal.json');
  await resolveContainedLoopPath(
    isInsidePath(paths.runtimeDir, file) ? paths.runtimeDir : paths.loopRoot,
    file,
  );
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function createLoopChange(options: {
  paths: LoopProjectPaths;
  name: string;
  language: 'en' | 'zh-CN';
  verificationProtocol?: LoopVerificationProtocol;
  workspaceBinding?: LoopWorkspaceBinding;
  initialProjectConfig?: OwnerProjectConfig;
  now?: Date;
}): Promise<LoopChangeState> {
  return withLoopMutationLock(options.paths, `create change ${options.name}`, () =>
    createLoopChangeLocked(options),
  );
}

async function createLoopChangeLocked(options: {
  paths: LoopProjectPaths;
  name: string;
  language: 'en' | 'zh-CN';
  verificationProtocol?: LoopVerificationProtocol;
  workspaceBinding?: LoopWorkspaceBinding;
  initialProjectConfig?: OwnerProjectConfig;
  now?: Date;
}): Promise<LoopChangeState> {
  assertLoopName(options.name);
  if (
    options.initialProjectConfig &&
    (await readProjectConfig(options.paths.projectRoot)) === null
  ) {
    await writeProjectConfig(options.paths.projectRoot, options.initialProjectConfig);
  }
  if (options.workspaceBinding) {
    assertLoopWorkspaceBindingCurrent(options.paths.projectRoot, options.workspaceBinding);
    const activeChanges = await listActiveLoopChangesOwnedByWorkspace(options.paths);
    if (activeChanges.length > 0) {
      throw new LoopWorkspaceIsolationRequiredError(
        options.workspaceBinding.isolation,
        activeChanges,
      );
    }
  }
  const verificationProtocol = options.verificationProtocol ?? 'legacy-v1';
  const changeDir = loopChangeDir(options.paths, options.name);
  const runtimeDir = loopPreferredChangeRuntimeDir(options.paths, options.name);
  await resolveContainedLoopPath(options.paths.loopRoot, changeDir);
  await resolveContainedLoopPath(options.paths.runtimeDir, runtimeDir);
  let createdChangeDir = false;
  let createdRuntimeDir = false;
  try {
    try {
      await fs.mkdir(changeDir, { recursive: false });
      createdChangeDir = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await fs.mkdir(options.paths.changesDir, { recursive: true });
        try {
          await fs.mkdir(changeDir, { recursive: false });
          createdChangeDir = true;
        } catch (retryError) {
          if ((retryError as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new Error(`Loop change already exists: ${options.name}`, {
              cause: retryError,
            });
          }
          throw retryError;
        }
      } else if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`Loop change already exists: ${options.name}`, { cause: error });
      } else {
        throw error;
      }
    }
    try {
      await fs.mkdir(runtimeDir, { recursive: false });
      createdRuntimeDir = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await fs.mkdir(options.paths.changesRuntimeDir, { recursive: true });
        await fs.mkdir(runtimeDir, { recursive: false });
        createdRuntimeDir = true;
      } else if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`Loop change Runtime already exists: ${options.name}`, { cause: error });
      } else {
        throw error;
      }
    }
    const state: LoopChangeState = {
      schema: LOOP_CHANGE_SCHEMA,
      minimum_runtime_version: LOOP_RUNTIME_PROTOCOL_VERSION,
      revision: 1,
      verification_protocol: verificationProtocol,
      name: options.name,
      language: options.language,
      phase: 'shape',
      brief: 'brief.md',
      approval: null,
      approved_contract_hash: null,
      spec_changes: [],
      verification_result: 'pending',
      verification_report: null,
      implementation_scope: null,
      verification_evidence: null,
      partial_allowance: null,
      archived: false,
      created_at: (options.now ?? new Date()).toISOString().slice(0, 10),
      run_id: null,
    };
    await Promise.all([
      fs.mkdir(path.join(changeDir, 'specs'), { recursive: true }),
      fs.mkdir(path.join(runtimeDir, 'checkpoints'), { recursive: true }),
      atomicWriteText(path.join(changeDir, 'brief.md'), LOOP_BRIEF_TEMPLATE),
    ]);
    const projectConfig = await readProjectConfig(options.paths.projectRoot);
    const snapshot = projectConfig?.loop.snapshot ?? DEFAULT_LOOP_SNAPSHOT_CONFIG;
    const baseline = await createLoopContentSnapshot(options.paths, {
      now: options.now,
      origin: 'change-created',
      policy: snapshot,
      limits: {
        maxFiles: snapshot.max_files,
        maxFileBytes: snapshot.max_total_bytes,
        maxTotalBytes: snapshot.max_total_bytes,
        maxDurationMs: snapshot.max_duration_ms,
      },
      deadlineMs: snapshot.max_duration_ms,
    });
    if (!baseline.complete) {
      const health = inspectLoopContentSnapshotHealth(baseline);
      const omittedByReason = baseline.omitted.reduce<Record<string, number>>((counts, item) => {
        counts[item.reason] = (counts[item.reason] ?? 0) + 1;
        return counts;
      }, {});
      const overflowCount = baseline.omissionOverflow?.count ?? 0;
      if (overflowCount > 0) omittedByReason.overflow = overflowCount;
      throw new LoopBaselineIncompleteError(
        state.name,
        baseline.omittedCount,
        omittedByReason,
        health.samplePaths,
        health.sampleTruncated,
        baseline.limits,
        baseline.policy?.hash ?? null,
      );
    }
    await writeLoopBaselineManifest(options.paths, state.name, baseline);
    await createLoopChangeFile(options.paths, state);
    await writeLoopWorkspaceIdentity({
      paths: options.paths,
      name: state.name,
      revision: state.revision,
      now: options.now,
      ...(options.workspaceBinding ? { binding: options.workspaceBinding } : {}),
    });
    return state;
  } catch (error) {
    if (createdRuntimeDir) await fs.rm(runtimeDir, { recursive: true, force: true });
    if (createdChangeDir) await fs.rm(changeDir, { recursive: true, force: true });
    throw error;
  }
}

export const LOOP_CHANGE_DOCUMENT_MAX_BYTES = 256 * 1024;

async function readChangeDocumentFile(file: string, root = path.dirname(file)): Promise<unknown> {
  const ref = path.relative(root, file).split(path.sep).join('/');
  const source = await readLoopBoundedTextFile({
    root,
    ref,
    maxBytes: LOOP_CHANGE_DOCUMENT_MAX_BYTES,
  });
  const document = parseDocument(source.text, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(`Invalid Loop change file ${file}: ${document.errors[0].message}`);
  }
  return document.toJS();
}

export async function inspectLoopChange(
  paths: LoopProjectPaths,
  name: string,
): Promise<LoopChangeSchemaInspection> {
  const file = path.join(loopChangeDir(paths, name), LOOP_CHANGE_STATE_FILE);
  await resolveContainedLoopPath(paths.loopRoot, file);
  const inspection = inspectLoopChangeValue(await readChangeDocumentFile(file, paths.loopRoot));
  if (inspection.state && inspection.state.name !== name) {
    throw new Error(`Loop change directory/name mismatch: ${name}`);
  }
  if (await hasPendingLoopSchemaMigration(paths, name)) {
    return {
      status: 'migration-required',
      schema: inspection.schema,
      minimumRuntimeVersion: inspection.minimumRuntimeVersion,
      state: inspection.state,
      message: `Loop schema migration is incomplete for ${name}; run doctor --repair`,
    };
  }
  if (inspection.status === 'current' && inspection.state) {
    await assertLoopVerificationProtocolBinding(paths, inspection.state as LoopChangeState);
  }
  return inspection;
}

/**
 * Read only the change state document for lightweight candidate discovery.
 *
 * Unlike `inspectLoopChange`, this deliberately does not inspect schema-migration journals,
 * baselines, workspace identity, or any other Runtime artifact. Callers must use the full
 * inspection before resuming or mutating the selected change.
 */
export async function inspectLoopChangeStateDocument(
  paths: LoopProjectPaths,
  name: string,
): Promise<LoopChangeSchemaInspection> {
  const file = path.join(loopChangeDir(paths, name), LOOP_CHANGE_STATE_FILE);
  await resolveContainedLoopPath(paths.loopRoot, file);
  const inspection = inspectLoopChangeValue(await readChangeDocumentFile(file, paths.loopRoot));
  if (inspection.state && inspection.state.name !== name) {
    throw new Error(`Loop change directory/name mismatch: ${name}`);
  }
  return inspection;
}

async function assertLoopVerificationProtocolBinding(
  paths: LoopProjectPaths,
  state: LoopChangeState,
): Promise<void> {
  const baseline = await readLoopBaselineManifest(paths, state.name);
  if (baseline === null) return;
  if (state.verification_protocol !== 'legacy-v1') {
    throw new Error(`Loop verification protocol is unsupported: ${state.verification_protocol}`);
  }
}

export async function readLoopChange(
  paths: LoopProjectPaths,
  name: string,
): Promise<LoopChangeState> {
  const inspection = await inspectLoopChange(paths, name);
  if (inspection.status === 'migration-required') {
    throw new LoopSchemaMigrationRequiredError(name, inspection.schema);
  }
  if (inspection.status === 'runtime-incompatible' || !inspection.state) {
    throw new LoopRuntimeCompatibilityError(inspection.schema, inspection.minimumRuntimeVersion);
  }
  await assertLoopWorkspaceBinding(paths, name);
  return inspection.state as LoopChangeState;
}

export async function writeLoopChange(
  paths: LoopProjectPaths,
  state: LoopChangeState,
): Promise<LoopChangeState> {
  return compareAndSwapLoopChange(paths, state, state.revision);
}

async function createLoopChangeFile(
  paths: LoopProjectPaths,
  state: LoopChangeState,
): Promise<void> {
  const file = path.join(loopChangeDir(paths, state.name), LOOP_CHANGE_STATE_FILE);
  await resolveContainedLoopPath(paths.loopRoot, file);
  try {
    await fs.access(file);
    throw new Error(`Loop change state already exists: ${state.name}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (state.revision !== 1) throw new Error('New Loop change must start at revision 1');
  await atomicWriteText(file, stringify(loopChangeDocument(state)));
}

export async function compareAndSwapLoopChangeFile(
  file: string,
  state: LoopChangeState,
  expectedRevision: number,
): Promise<LoopChangeState> {
  const next = {
    ...state,
    schema: LOOP_CHANGE_SCHEMA,
    minimum_runtime_version: LOOP_RUNTIME_PROTOCOL_VERSION,
    revision: expectedRevision + 1,
  } satisfies LoopChangeState;
  const result = await compareAndSwapLoopRevision({
    expectedRevision,
    next,
    read: async () => {
      const current = parseLoopChangeValue(await readChangeDocumentFile(file));
      if (current.name !== state.name) {
        throw new Error(`Loop change file/name mismatch: ${state.name}`);
      }
      return current;
    },
    write: (value) => atomicWriteText(file, stringify(loopChangeDocument(value))),
    equals: (left, right) =>
      JSON.stringify(loopChangeDocument(left)) === JSON.stringify(loopChangeDocument(right)),
    conflict: (actualRevision) =>
      new LoopChangeRevisionConflictError(state.name, expectedRevision, actualRevision),
  });
  Object.assign(state, result);
  return result;
}

export async function compareAndSwapLoopChangeLocked(
  paths: LoopProjectPaths,
  state: LoopChangeState,
  expectedRevision: number,
  options?: { allowPendingCheckpointRecovery?: boolean },
): Promise<LoopChangeState> {
  await assertNoPendingLoopRootMove(paths.projectRoot);
  if (await hasPendingLoopSchemaMigration(paths, state.name)) {
    throw new LoopSchemaMigrationRequiredError(state.name, state.schema);
  }
  if (
    !options?.allowPendingCheckpointRecovery &&
    (await hasPendingLoopCheckpointRecovery(paths, state.name))
  ) {
    throw new Error(
      `Loop progress checkpoint recovery is required for ${state.name} before another state write`,
    );
  }
  const current = await readLoopChange(paths, state.name);
  if (current.verification_protocol !== state.verification_protocol) {
    throw new Error('Loop verification protocol changed outside a revisioned state transition');
  }
  await assertLoopTrajectoryHealthy(paths, state.name);
  const file = path.join(loopChangeDir(paths, state.name), LOOP_CHANGE_STATE_FILE);
  await resolveContainedLoopPath(paths.loopRoot, file);
  return compareAndSwapLoopChangeFile(file, state, expectedRevision);
}

export async function compareAndSwapLoopChange(
  paths: LoopProjectPaths,
  state: LoopChangeState,
  expectedRevision: number,
): Promise<LoopChangeState> {
  return withLoopMutationLock(paths, `write change ${state.name}`, () =>
    compareAndSwapLoopChangeLocked(paths, state, expectedRevision),
  );
}

export async function writeLoopChangeFile(
  file: string,
  state: LoopChangeState,
): Promise<LoopChangeState> {
  return compareAndSwapLoopChangeFile(file, state, state.revision);
}

export async function readLoopChangeFile(file: string): Promise<LoopChangeState> {
  return parseLoopChangeValue(await readChangeDocumentFile(file));
}

export async function listLoopChanges(paths: LoopProjectPaths): Promise<LoopChangeState[]> {
  const names = await listLoopChangeNames(paths);
  return Promise.all(names.map((name) => readLoopChange(paths, name)));
}

async function listLoopChangeNames(paths: LoopProjectPaths): Promise<string[]> {
  let entries;
  try {
    const directory = await readLoopProtectedDirectory({
      root: paths.loopRoot,
      directory: paths.changesDir,
      label: 'Loop changes directory',
      maxEntries: Number.MAX_SAFE_INTEGER,
    });
    await directory.verify();
    entries = directory.entries;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const names = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
  return names;
}

export async function listActiveLoopChangesOwnedByWorkspace(
  paths: LoopProjectPaths,
): Promise<string[]> {
  const owned: string[] = [];
  for (const name of await listLoopChangeNames(paths)) {
    const inspection = await inspectLoopChangeStateDocument(paths, name);
    if (!inspection.state) {
      if (await hasForeignRegisteredWorkspaceOwner(paths, name)) continue;
      owned.push(name);
      continue;
    }
    if (inspection.state.archived) continue;
    const identity = await readLoopWorkspaceIdentity(paths, name);
    if (!identity && (await hasForeignRegisteredWorkspaceOwner(paths, name))) continue;
    if (identity?.schema === 'owner.loop.workspace.v3') {
      const binding = await inspectLoopWorkspaceBinding({ paths, identity });
      if (binding.code === 'workspace-binding-root-changed') continue;
    } else if (identity) {
      const advisory = await inspectLoopWorkspaceAdvisory({ paths, identity });
      if (advisory.state === 'drifted') continue;
    }
    owned.push(name);
  }
  return owned;
}

function sameWorkspaceRoot(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function hasForeignRegisteredWorkspaceOwner(
  paths: LoopProjectPaths,
  name: string,
): Promise<boolean> {
  for (const root of listGitWorktreeRoots(paths.projectRoot)) {
    if (sameWorkspaceRoot(root, paths.projectRoot)) continue;
    try {
      const config = await readProjectConfig(root);
      if (!config) continue;
      const candidatePaths = await loopProjectPaths(root, config.loop.artifact_root);
      const changeDir = path.join(candidatePaths.changesDir, name);
      const portableStateFile = path.join(changeDir, 'owner-state.yaml');
      try {
        const portableSource = await fs.readFile(portableStateFile, 'utf8');
        if (/^schema:\s*owner\.loop\.v4\s*$/mu.test(portableSource)) {
          const localSource = await fs.readFile(
            path.join(loopPreferredChangeRuntimeDir(candidatePaths, name), 'state.json'),
            'utf8',
          );
          const local = JSON.parse(localSource) as {
            schema?: unknown;
            workspace?: { projectRoot?: unknown };
          };
          if (
            local.schema === 'owner.loop.local-execution.v4' &&
            typeof local.workspace?.projectRoot === 'string' &&
            sameWorkspaceRoot(local.workspace.projectRoot, root)
          ) {
            return true;
          }
          continue;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          // A malformed foreign portable overlay cannot prove ownership.
        }
      }
      await fs.access(path.join(changeDir, LOOP_CHANGE_STATE_FILE));
      const identity = await readLoopWorkspaceIdentity(candidatePaths, name);
      if (!identity) continue;
      if (identity.schema === 'owner.loop.workspace.v3') {
        const binding = await inspectLoopWorkspaceBinding({ paths: candidatePaths, identity });
        if (binding.state === 'aligned') return true;
        continue;
      }
      const advisory = await inspectLoopWorkspaceAdvisory({
        paths: candidatePaths,
        identity,
      });
      if (advisory.state !== 'drifted') return true;
    } catch {
      // A foreign worktree that cannot prove ownership must not suppress the local change.
    }
  }
  return false;
}
