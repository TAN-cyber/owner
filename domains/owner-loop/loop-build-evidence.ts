import { promises as fs } from 'node:fs';
import path from 'node:path';

import { LoopBaselineIncompleteError, loopChangeDir } from './loop-change.js';
import { collectLoopContractFiles, type LoopCollectedContract } from './loop-contract-files.js';
import {
  loopEvidenceRef,
  writeLoopImplementationScope,
  writeLoopPartialAllowance,
} from './loop-evidence-storage.js';
import { isInsidePath, resolveContainedLoopPath } from './loop-paths.js';
import { loopSensitiveArtifactReason } from './loop-sensitive-paths.js';
import { detectLoopGitExternalDrift } from './loop-git-provenance.js';
import {
  createLoopCurrentContentSnapshot,
  filterLoopContentSnapshotToProjectScope,
  readLoopBaselineManifest,
} from './loop-snapshot.js';
import type {
  LoopChangeState,
  LoopContentSnapshotManifest,
  LoopFinding,
  LoopProjectPaths,
} from './loop-types.js';
import {
  buildLoopImplementationScopeBundle,
  type LoopDeclaredArtifact,
  type LoopImplementationScopeBundle,
  type LoopSnapshotProjection,
  type LoopUnresolvedScope,
} from './loop-verification-scope.js';
import {
  buildLoopPartialAllowance,
  type LoopPartialAllowance,
} from './loop-verification-evidence.js';
import { readLoopWorkspaceIdentity } from './loop-workspace.js';

export const LOOP_BUILD_EVIDENCE_LIMITS = {
  maxDeclaredArtifacts: 128,
  maxArtifactPathBytes: 512,
} as const;

export interface LoopBuildEvidencePreparation {
  contract: LoopCollectedContract;
  bundle: LoopImplementationScopeBundle;
  scopeRef: string;
  allowance: LoopPartialAllowance | null;
  allowanceRef: string | null;
  findings: LoopFinding[];
  unresolvedScopes: LoopUnresolvedScope[];
}

export interface LoopBuildEvidenceOptions {
  paths: LoopProjectPaths;
  state: LoopChangeState;
  artifactRefs: readonly string[];
  noCodeReason?: string | null;
  allowPartialScopeHash?: string | null;
  partialReason?: string | null;
  confirmedSummary?: string | null;
  confirmed?: boolean;
  now?: Date;
}

function assertStableLoopSelection(
  snapshot: LoopContentSnapshotManifest,
  source: 'baseline projection' | 'current snapshot',
): void {
  if (snapshot.omitted.some((omission) => omission.reason === 'git-selection-changed')) {
    throw new Error(
      `Loop Git selection changed while capturing the ${source}; stabilize the Git index and retry Build evidence`,
    );
  }
  if (
    snapshot.omitted.some(
      (omission) =>
        omission.reason === 'physical-enumeration-limit' ||
        omission.reason === 'physical-selection-changed',
    )
  ) {
    throw new Error(
      `Loop physical selection was incomplete or changed while capturing the ${source}; retry Build evidence with a stable bounded project tree`,
    );
  }
}

function loopBaselineIncompleteError(
  change: string,
  baseline: LoopContentSnapshotManifest,
): LoopBaselineIncompleteError {
  const samplePaths = baseline.omitted.slice(0, 20).map((omission) => omission.path);
  const omittedByReason = baseline.omitted.reduce<Record<string, number>>((counts, item) => {
    counts[item.reason] = (counts[item.reason] ?? 0) + 1;
    return counts;
  }, {});
  const overflowCount = baseline.omissionOverflow?.count ?? 0;
  if (overflowCount > 0) omittedByReason.overflow = overflowCount;
  return new LoopBaselineIncompleteError(
    change,
    baseline.omittedCount,
    omittedByReason,
    samplePaths,
    baseline.omitted.length > samplePaths.length || overflowCount > 0,
  );
}

function loopBaselineProjectionIncompleteError(
  change: string,
  baseline: LoopContentSnapshotManifest,
  projection: LoopSnapshotProjection,
): LoopBaselineIncompleteError {
  const retained = new Set(projection.entries.map((entry) => entry.path));
  const removedPaths = baseline.entries
    .filter((entry) => !retained.has(entry.path))
    .slice(0, 20)
    .map((entry) => entry.path);
  return new LoopBaselineIncompleteError(
    change,
    projection.omittedCount,
    { 'manifest-size': projection.omittedCount },
    removedPaths,
    projection.omittedCount > removedPaths.length,
  );
}

function normalizeProjectRef(value: string, label: string): string {
  const normalized = value.replaceAll('\\', '/').trim();
  if (
    normalized.length === 0 ||
    normalized !== value.replaceAll('\\', '/') ||
    path.posix.isAbsolute(normalized) ||
    /^(?:[A-Za-z]:|~)/u.test(normalized) ||
    normalized.split('/').includes('..') ||
    path.posix.normalize(normalized) !== normalized ||
    normalized === '.' ||
    normalized.endsWith('/') ||
    Buffer.byteLength(normalized, 'utf8') > LOOP_BUILD_EVIDENCE_LIMITS.maxArtifactPathBytes ||
    Array.from(normalized).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new Error(`${label} must be a normalized project-relative path`);
  }
  return normalized;
}

function baselineArtifactKind(
  baseline: LoopContentSnapshotManifest,
  artifactRef: string,
): LoopDeclaredArtifact['kind'] | null {
  if (baseline.entries.some((entry) => entry.path === artifactRef)) return 'file';
  if (baseline.entries.some((entry) => entry.path.startsWith(`${artifactRef}/`))) {
    return 'directory';
  }
  return null;
}

async function inspectDeclaredArtifact(
  paths: LoopProjectPaths,
  baseline: LoopContentSnapshotManifest,
  rawRef: string,
): Promise<LoopDeclaredArtifact> {
  const artifactRef = normalizeProjectRef(rawRef, 'Loop build artifact');
  const sensitiveReason = loopSensitiveArtifactReason(paths, artifactRef);
  if (sensitiveReason) {
    throw new Error(`Loop build artifact is excluded as ${sensitiveReason}: ${artifactRef}`);
  }
  const target = path.resolve(paths.projectRoot, ...artifactRef.split('/'));
  if (!isInsidePath(paths.projectRoot, target)) {
    throw new Error(`Loop build artifact escapes the project: ${artifactRef}`);
  }
  await resolveContainedLoopPath(paths.projectRoot, target);
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) {
      throw new Error(`Loop build artifact must not be a symlink or junction: ${artifactRef}`);
    }
    const realTarget = await fs.realpath(target);
    const realProjectRoot = await fs.realpath(paths.projectRoot);
    if (!isInsidePath(realProjectRoot, realTarget)) {
      throw new Error(`Loop build artifact resolves outside the project: ${artifactRef}`);
    }
    if (stat.isFile()) return { path: artifactRef, kind: 'file' };
    if (stat.isDirectory()) return { path: artifactRef, kind: 'directory' };
    throw new Error(`Loop build artifact is not a file or directory: ${artifactRef}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const kind = baselineArtifactKind(baseline, artifactRef);
    if (kind === null) {
      throw new Error(`Loop build artifact does not exist: ${artifactRef}`, { cause: error });
    }
    return { path: artifactRef, kind };
  }
}

async function collectDeclaredArtifacts(options: {
  paths: LoopProjectPaths;
  baseline: LoopContentSnapshotManifest;
  refs: readonly string[];
}): Promise<LoopDeclaredArtifact[]> {
  if (options.refs.length > LOOP_BUILD_EVIDENCE_LIMITS.maxDeclaredArtifacts) {
    throw new Error('Loop build evidence exceeds its declared-artifact budget');
  }
  const artifacts = await Promise.all(
    options.refs.map((reference) =>
      inspectDeclaredArtifact(options.paths, options.baseline, reference),
    ),
  );
  artifacts.sort(
    (left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind),
  );
  if (new Set(artifacts.map((artifact) => artifact.path)).size !== artifacts.length) {
    throw new Error('Loop build evidence contains duplicate or conflicting artifacts');
  }
  return artifacts;
}

function partialFindings(unresolvedScopes: readonly LoopUnresolvedScope[]): LoopFinding[] {
  return unresolvedScopes.map((scope) => ({
    code: 'verification-scope-partial',
    message: `${scope.id}: ${scope.reason}`,
    ...(scope.path === null ? {} : { path: scope.path }),
  }));
}

function partialScopeHash(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error('Loop partial allowance requires a scope hash');
  }
  return value;
}

/**
 * Capture Build evidence from the real project and persist only content-addressed derived facts.
 *
 * A partial scope is persisted so its deterministic IDs can be shown and confirmed on a later
 * invocation, but it is not attached to change state until the caller commits a phase transition.
 */
export async function inspectLoopBuildEvidence(
  options: LoopBuildEvidenceOptions,
): Promise<LoopBuildEvidencePreparation> {
  if (options.state.phase !== 'build') {
    throw new Error(`Loop build evidence requires Build, got ${options.state.phase}`);
  }
  if ((options.noCodeReason ?? '').trim().length > 0 && options.artifactRefs.length > 0) {
    throw new Error('Loop build evidence cannot combine artifacts with a no-code reason');
  }
  const storedBaseline = await readLoopBaselineManifest(options.paths, options.state.name);
  if (storedBaseline === null) throw new Error('Loop change has no baseline content snapshot');
  const baseline = await filterLoopContentSnapshotToProjectScope(options.paths, storedBaseline);
  assertStableLoopSelection(baseline, 'baseline projection');
  if (!baseline.complete) {
    throw loopBaselineIncompleteError(options.state.name, baseline);
  }
  const contract = await collectLoopContractFiles({
    changeDir: loopChangeDir(options.paths, options.state.name),
    briefRef: options.state.brief,
    specChanges: options.state.spec_changes,
  });
  const declaredArtifacts = await collectDeclaredArtifacts({
    paths: options.paths,
    baseline,
    refs: options.artifactRefs,
  });
  const current = await createLoopCurrentContentSnapshot(options.paths, baseline, {
    origin: 'explicit',
    now: options.now,
  });
  assertStableLoopSelection(current, 'current snapshot');
  const baseBundle = buildLoopImplementationScopeBundle({
    baseline,
    current,
    contractHash: contract.contract.contractHash,
    declaredArtifacts,
    noCodeReason: options.noCodeReason ?? null,
  });
  const workspace = await readLoopWorkspaceIdentity(options.paths, options.state.name);
  const externalDrift =
    workspace?.git === undefined
      ? null
      : detectLoopGitExternalDrift({
          projectRoot: options.paths.projectRoot,
          provenance: workspace.git,
          baseline,
          current,
          declaredArtifacts,
        });
  const bundle =
    externalDrift === null
      ? baseBundle
      : buildLoopImplementationScopeBundle({
          baseline,
          current,
          contractHash: contract.contract.contractHash,
          declaredArtifacts,
          noCodeReason: options.noCodeReason ?? null,
          externalDrift,
        });
  if (!bundle.baseline.complete) {
    throw loopBaselineProjectionIncompleteError(options.state.name, baseline, bundle.baseline);
  }
  const scopeRef = loopEvidenceRef('scopes', bundle.scope.scopeHash);
  if (bundle.scope.complete) {
    if (
      (options.allowPartialScopeHash !== undefined && options.allowPartialScopeHash !== null) ||
      (options.partialReason !== undefined && options.partialReason !== null)
    ) {
      throw new Error('Complete Loop build evidence must not include a partial allowance');
    }
    return {
      contract,
      bundle,
      scopeRef,
      allowance: null,
      allowanceRef: null,
      findings: [],
      unresolvedScopes: [],
    };
  }
  if (options.allowPartialScopeHash === undefined || options.allowPartialScopeHash === null) {
    return {
      contract,
      bundle,
      scopeRef,
      allowance: null,
      allowanceRef: null,
      findings: partialFindings(bundle.scope.unresolvedScopes),
      unresolvedScopes: bundle.scope.unresolvedScopes,
    };
  }
  if (!options.confirmed) {
    throw new Error('Loop partial verification requires explicit confirmation');
  }
  const expectedScopeHash = partialScopeHash(options.allowPartialScopeHash);
  if (expectedScopeHash !== bundle.scope.scopeHash) {
    throw new Error('Loop partial allowance does not match the current implementation scope');
  }
  const allowance = buildLoopPartialAllowance({
    change: options.state.name,
    scopeBundle: bundle,
    allowedScopeIds: bundle.scope.unresolvedScopes.map((scope) => scope.id),
    reason: options.partialReason ?? '',
    confirmedSummary: options.confirmedSummary ?? '',
    sourceRevision: options.state.revision,
    now: options.now,
  });
  const allowanceRef = loopEvidenceRef('allowances', allowance.allowanceHash);
  return {
    contract,
    bundle,
    scopeRef,
    allowance,
    allowanceRef,
    findings: [],
    unresolvedScopes: bundle.scope.unresolvedScopes,
  };
}

export async function persistLoopBuildEvidence(
  options: Pick<LoopBuildEvidenceOptions, 'paths' | 'state'> & {
    preparation: LoopBuildEvidencePreparation;
    includeAllowance?: boolean;
  },
): Promise<void> {
  const scopeRef = await writeLoopImplementationScope({
    paths: options.paths,
    name: options.state.name,
    bundle: options.preparation.bundle,
  });
  if (scopeRef !== options.preparation.scopeRef) {
    throw new Error('Loop implementation scope persistence ref changed');
  }
  if (options.includeAllowance === false || options.preparation.allowance === null) return;
  const allowanceRef = await writeLoopPartialAllowance({
    paths: options.paths,
    name: options.state.name,
    allowance: options.preparation.allowance,
  });
  if (allowanceRef !== options.preparation.allowanceRef) {
    throw new Error('Loop partial allowance persistence ref changed');
  }
}

/** Backwards-compatible one-shot API for callers that intentionally persist a prepared scope. */
export async function prepareLoopBuildEvidence(
  options: LoopBuildEvidenceOptions,
): Promise<LoopBuildEvidencePreparation> {
  const preparation = await inspectLoopBuildEvidence(options);
  await persistLoopBuildEvidence({ paths: options.paths, state: options.state, preparation });
  return preparation;
}
