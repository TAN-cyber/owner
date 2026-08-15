import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';

import { spawnCommand } from '../../platform/process/spawn-command.js';
import { terminateProcessTree } from '../../platform/process/terminate-process-tree.js';

import { loopChangeDir, readLoopChange } from './loop-change.js';
import { settleLoopChangeJournalsLocked } from './loop-change-recovery.js';
import type { LoopCheckReceipt } from './loop-check-receipt.js';
import { readLoopCheckReceipt } from './loop-check-receipt-storage.js';
import { collectLoopContractFiles } from './loop-contract-files.js';
import {
  listLoopVerificationReceiptRefs,
  readLoopImplementationScopeBundle,
  readLoopVerificationReceipt,
  writeLoopVerificationReceipt,
} from './loop-evidence-storage.js';
import type { LoopChangeState, LoopProjectPaths } from './loop-types.js';
import { withLoopMutationLock } from './loop-mutation-lock.js';
import { redactLoopCredentialText } from './loop-redaction.js';
import {
  LoopReceiptScopeStaleError,
  type LoopReceiptFenceChangedPath,
  type LoopReceiptScopeRecovery,
} from './loop-receipt-errors.js';
import { withLoopTransitionLock } from './loop-transition-journal.js';
import type { LoopContentSnapshotManifest } from './loop-types.js';
import { createLoopCurrentContentSnapshot } from './loop-snapshot.js';
import {
  buildLoopVerificationReceipt,
  loopArtifactBindingHash,
  type LoopVerificationReceipt,
  type LoopVerificationReceiptBindings,
} from './loop-verification-receipt.js';
import {
  buildLoopImplementationScopeBundle,
  deriveLoopImplementationChanges,
  type LoopImplementationScopeBundle,
  type LoopSnapshotProjection,
} from './loop-verification-scope.js';

const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
export const MAX_LOOP_AUTOMATED_COMMAND_TIMEOUT_MS = 60 * 60 * 1_000;
const AUTOMATED_COMMAND_TERMINATION_WAIT_MS = 4_000;
const LOOP_MANUAL_EVIDENCE_ACTOR = 'loop-runtime:manual-evidence';
const execFileAsync = promisify(execFile);
async function withLoopReceiptIssuanceLock<T>(options: {
  paths: LoopProjectPaths;
  name: string;
  operation: string;
  issue: (state: LoopChangeState) => Promise<T>;
}): Promise<T> {
  return withLoopMutationLock(options.paths, options.operation, () =>
    withLoopTransitionLock(options.paths, options.name, options.operation, async () => {
      await settleLoopChangeJournalsLocked(options.paths, options.name);
      return options.issue(await readLoopChange(options.paths, options.name));
    }),
  );
}

export interface LoopVerificationReceiptContext {
  bindings: LoopVerificationReceiptBindings;
  acceptanceIds: string[];
  implementationAuthor: string;
  implementationExecutionId: string;
  scope: LoopImplementationScopeBundle;
}

export interface LoopReceiptFenceInspection {
  matched: boolean;
  expectedScopeHash: string;
  actualScopeHash: string;
  expectedSnapshotHash: string;
  actualSnapshotHash: string;
  changedPaths: LoopReceiptFenceChangedPath[];
  changedPathCount: number;
  changedPathsTruncated: boolean;
}

export interface LoopIssuedVerificationReceipt {
  receipt: LoopVerificationReceipt;
  ref: string;
  recovery?: LoopReceiptScopeRecovery;
}

function boundedText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || Buffer.byteLength(normalized, 'utf8') > MAX_COMMAND_OUTPUT_BYTES) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function normalizeAcceptanceIds(values: readonly string[], expected: readonly string[]): string[] {
  const acceptanceIds = [...values].sort();
  if (
    acceptanceIds.length === 0 ||
    new Set(acceptanceIds).size !== acceptanceIds.length ||
    acceptanceIds.some((id) => !expected.includes(id))
  ) {
    throw new Error('Loop receipt acceptance IDs do not match the current contract');
  }
  return acceptanceIds;
}

export async function loadLoopVerificationReceiptContext(
  paths: LoopProjectPaths,
  state: LoopChangeState,
): Promise<LoopVerificationReceiptContext> {
  if (state.phase !== 'verify') {
    throw new Error(`Loop verification receipt issuance requires Verify, got ${state.phase}`);
  }
  if (!state.implementation_scope) {
    throw new Error('Loop verification receipt issuance requires an implementation scope');
  }
  const [scope, contract] = await Promise.all([
    readLoopImplementationScopeBundle(paths, state.name, state.implementation_scope),
    collectLoopContractFiles({
      changeDir: loopChangeDir(paths, state.name),
      briefRef: state.brief,
      specChanges: state.spec_changes,
    }),
  ]);
  if (scope.scope.contractHash !== contract.contract.contractHash) {
    throw new Error('Loop verification receipt contract/scope mismatch');
  }
  const implementationExecutionId = state.run_id
    ? `run:${state.run_id}`
    : `scope:${scope.scope.scopeHash}`;
  return {
    bindings: {
      change: state.name,
      sourceRevision: state.revision,
      contractHash: contract.contract.contractHash,
      scopeHash: scope.scope.scopeHash,
      snapshotHash: scope.scope.currentProjectionHash,
      artifactHash: loopArtifactBindingHash(scope.scope.declaredArtifacts),
    },
    acceptanceIds: contract.contract.acceptance.map((criterion) => criterion.id).sort(),
    implementationAuthor: `loop-implementation:${implementationExecutionId}`,
    implementationExecutionId,
    scope,
  };
}

const LOOP_RECEIPT_BINDING_FIELDS = [
  'change',
  'sourceRevision',
  'contractHash',
  'scopeHash',
  'snapshotHash',
  'artifactHash',
] as const satisfies readonly (keyof LoopVerificationReceiptBindings)[];

export interface LoopReceiptBindingComparison {
  ok: boolean;
  mismatches: string[];
}

/**
 * Compare a receipt's bindings against the expected bindings field-by-field.
 *
 * Unlike a coarse {@link loopReceiptBindingsMatch} boolean check, this returns
 * a per-field mismatch description so callers can surface exactly which binding
 * diverged (e.g. "sourceRevision: expected 6, got 5") instead of an opaque
 * "invalid" error. This is the diagnostic foundation that lets an Agent recover
 * from a stale receipt without user intervention.
 */
export function compareLoopReceiptBindings(
  receipt: Pick<LoopVerificationReceipt, 'bindings'>,
  expected: LoopVerificationReceiptBindings,
): LoopReceiptBindingComparison {
  const mismatches: string[] = [];
  for (const field of LOOP_RECEIPT_BINDING_FIELDS) {
    const actual = receipt.bindings[field];
    const wanted = expected[field];
    if (actual !== wanted) {
      mismatches.push(
        `${field}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`,
      );
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

export function loopReceiptBindingsMatch(
  receipt: Pick<LoopVerificationReceipt, 'bindings'>,
  expected: LoopVerificationReceiptBindings,
): boolean {
  return compareLoopReceiptBindings(receipt, expected).ok;
}

export async function persistLoopStaticInspectionReceipt(options: {
  paths: LoopProjectPaths;
  state: LoopChangeState;
  checkReceipt: LoopCheckReceipt;
  checkReceiptRef: string;
}): Promise<{ receipt: LoopVerificationReceipt; ref: string }> {
  const context = await loadLoopVerificationReceiptContext(options.paths, options.state);
  const blocked =
    options.checkReceipt.stale ||
    options.checkReceipt.issues.some((issue) =>
      ['scan-limit', 'scope-mismatch', 'unsafe-file', 'binary-skipped'].includes(issue.kind),
    );
  const status =
    options.checkReceipt.status === 'passed' ? 'passed' : blocked ? 'blocked' : 'failed';
  const receipt = buildLoopVerificationReceipt({
    kind: 'static-inspection',
    role: 'required-check',
    status,
    bindings: context.bindings,
    acceptanceIds: [],
    actor: `loop-runtime:${options.checkReceipt.checker.policy}`,
    issuedAt: options.checkReceipt.endedAt,
    evidence: {
      subjects: deriveLoopImplementationChanges({
        baseline: context.scope.baseline,
        current: context.scope.current,
        declaredArtifacts: context.scope.scope.declaredArtifacts,
      })
        .filter((change) => change.attributedTo.length > 0)
        .map((change) => change.path)
        .sort(),
      rule: options.checkReceipt.checker.policy,
      resultSummary:
        status === 'passed'
          ? 'The built-in scoped inspection passed without skipped or blocking input.'
          : `The built-in scoped inspection recorded ${options.checkReceipt.counts.issueCount} blocking issue(s).`,
      checkReceiptRef: options.checkReceiptRef,
      checkReceiptHash: options.checkReceipt.receiptHash,
    },
  });
  const ref = await writeLoopVerificationReceipt({
    paths: options.paths,
    name: options.state.name,
    receipt,
  });
  return { receipt, ref };
}

export interface LoopReusableRequiredCheckReceipt {
  receipt: LoopVerificationReceipt;
  ref: string;
  checkReceipt: LoopCheckReceipt;
  checkReceiptRef: string;
}

function isReusableRequiredCheck(options: {
  receipt: LoopVerificationReceipt;
  checkReceipt: LoopCheckReceipt;
  context: LoopVerificationReceiptContext;
}): boolean {
  const { receipt, checkReceipt, context } = options;
  if (
    receipt.kind !== 'static-inspection' ||
    receipt.role !== 'required-check' ||
    receipt.status !== 'passed' ||
    !loopReceiptBindingsMatch(receipt, context.bindings) ||
    checkReceipt.status !== 'passed' ||
    checkReceipt.stale
  ) {
    return false;
  }
  const selectedFiles = deriveLoopImplementationChanges({
    baseline: context.scope.baseline,
    current: context.scope.current,
    declaredArtifacts: context.scope.scope.declaredArtifacts,
  }).filter((change) => change.attributedTo.length > 0 && change.after !== null);
  const selectedBytes = selectedFiles.reduce((total, change) => total + change.after!.size, 0);
  return (
    checkReceipt.change === context.bindings.change &&
    checkReceipt.sourceRevision === context.bindings.sourceRevision &&
    checkReceipt.contract.expectedHash === context.bindings.contractHash &&
    checkReceipt.contract.beforeHash === context.bindings.contractHash &&
    checkReceipt.contract.afterHash === context.bindings.contractHash &&
    checkReceipt.implementation.scopeHash === context.bindings.scopeHash &&
    checkReceipt.implementation.expectedSnapshotHash === context.bindings.snapshotHash &&
    checkReceipt.implementation.beforeSnapshotHash === context.bindings.snapshotHash &&
    checkReceipt.implementation.afterSnapshotHash === context.bindings.snapshotHash &&
    checkReceipt.counts.filesSelected === selectedFiles.length &&
    checkReceipt.counts.filesScanned + checkReceipt.counts.binaryFilesSkipped ===
      selectedFiles.length &&
    checkReceipt.counts.bytesScanned === selectedBytes &&
    checkReceipt.counts.issueCount === 0 &&
    checkReceipt.counts.recordedIssueCount === 0 &&
    checkReceipt.issues.length === 0 &&
    !checkReceipt.issuesTruncated
  );
}

/**
 * Find a passed required-check receipt that still proves the current Verify
 * scope. The directory scan is deliberately skipped when no typed receipts
 * exist, keeping the first Verify pass on the existing fast path.
 */
export async function findLoopReusableRequiredCheckReceipt(options: {
  paths: LoopProjectPaths;
  state: LoopChangeState;
}): Promise<LoopReusableRequiredCheckReceipt | null> {
  const refs = await listLoopVerificationReceiptRefs(options.paths, options.state.name);
  if (refs.length === 0) return null;

  const candidates: Array<{
    ref: string;
    receipt: Extract<LoopVerificationReceipt, { kind: 'static-inspection' }>;
  }> = [];
  for (const ref of refs) {
    try {
      const receipt = await readLoopVerificationReceipt(options.paths, options.state.name, ref);
      if (
        receipt.kind === 'static-inspection' &&
        receipt.role === 'required-check' &&
        receipt.status === 'passed'
      ) {
        candidates.push({ ref, receipt });
      }
    } catch {
      // A stale, deleted, or malformed historical receipt is not reusable.
    }
  }
  if (candidates.length === 0) return null;

  let context: LoopVerificationReceiptContext;
  try {
    context = await loadLoopVerificationReceiptContext(options.paths, options.state);
    const fence = await currentReceiptFence({ paths: options.paths, context });
    if (!fence.matched) return null;
  } catch {
    return null;
  }

  let reusable: LoopReusableRequiredCheckReceipt | null = null;
  for (const { ref, receipt } of candidates) {
    try {
      const checkReceipt = await validateLoopStaticReceiptDependency({
        paths: options.paths,
        state: options.state,
        receipt,
      });
      if (checkReceipt === null || !isReusableRequiredCheck({ receipt, checkReceipt, context })) {
        continue;
      }
      const candidate = {
        receipt,
        ref,
        checkReceipt,
        checkReceiptRef: receipt.evidence.checkReceiptRef,
      };
      if (
        reusable === null ||
        candidate.receipt.issuedAt > reusable.receipt.issuedAt ||
        (candidate.receipt.issuedAt === reusable.receipt.issuedAt && candidate.ref > reusable.ref)
      ) {
        reusable = candidate;
      }
    } catch {
      // A stale, deleted, or malformed historical receipt is not reusable;
      // execute a fresh required check instead.
    }
  }
  return reusable;
}

export async function issueLoopManualEvidenceReceipt(options: {
  paths: LoopProjectPaths;
  name: string;
  acceptanceIds: readonly string[];
  steps: readonly string[];
  observations: readonly string[];
  now?: Date;
}): Promise<{ receipt: LoopVerificationReceipt; ref: string }> {
  return withLoopReceiptIssuanceLock({
    paths: options.paths,
    name: options.name,
    operation: `issue manual receipt ${options.name}`,
    issue: (state) => issueLoopManualEvidenceReceiptLocked({ ...options, state }),
  });
}

async function issueLoopManualEvidenceReceiptLocked(options: {
  paths: LoopProjectPaths;
  state: LoopChangeState;
  acceptanceIds: readonly string[];
  steps: readonly string[];
  observations: readonly string[];
  now?: Date;
}): Promise<{ receipt: LoopVerificationReceipt; ref: string }> {
  const context = await loadLoopVerificationReceiptContext(options.paths, options.state);
  await assertLoopReceiptScopeCurrent({
    paths: options.paths,
    state: options.state,
    context,
  });
  const receipt = buildLoopVerificationReceipt({
    kind: 'manual-evidence',
    role: 'acceptance-evidence',
    status: 'passed',
    bindings: context.bindings,
    acceptanceIds: normalizeAcceptanceIds(options.acceptanceIds, context.acceptanceIds),
    actor: LOOP_MANUAL_EVIDENCE_ACTOR,
    issuedAt: (options.now ?? new Date()).toISOString(),
    evidence: {
      steps: [...options.steps],
      observations: [...options.observations],
    },
  });
  return {
    receipt,
    ref: await writeLoopVerificationReceipt({
      paths: options.paths,
      name: options.state.name,
      receipt,
    }),
  };
}

function projectionManifest(projection: LoopSnapshotProjection): LoopContentSnapshotManifest {
  return {
    schema: 'owner.loop.content-snapshot.v1',
    origin: projection.origin,
    ...(projection.capture ? { capture: projection.capture } : {}),
    createdAt: '1970-01-01T00:00:00.000Z',
    complete: projection.complete,
    limits: projection.limits,
    ...(projection.policy ? { policy: projection.policy } : {}),
    entries: projection.entries,
    omitted: projection.omitted,
    omittedCount: projection.omittedCount,
    ...(projection.omissionOverflow ? { omissionOverflow: projection.omissionOverflow } : {}),
  };
}

const MAX_LOOP_RECEIPT_FENCE_CHANGED_PATHS = 20;

function inspectLoopReceiptFenceChanges(
  expected: LoopSnapshotProjection,
  actual: LoopSnapshotProjection,
): Pick<LoopReceiptFenceInspection, 'changedPaths' | 'changedPathCount' | 'changedPathsTruncated'> {
  const changedPaths: LoopReceiptFenceChangedPath[] = [];
  let changedPathCount = 0;
  let expectedIndex = 0;
  let actualIndex = 0;
  while (expectedIndex < expected.entries.length || actualIndex < actual.entries.length) {
    const expectedEntry = expected.entries[expectedIndex];
    const actualEntry = actual.entries[actualIndex];
    const order =
      expectedEntry === undefined
        ? 1
        : actualEntry === undefined
          ? -1
          : expectedEntry.path < actualEntry.path
            ? -1
            : expectedEntry.path > actualEntry.path
              ? 1
              : 0;
    const before = order <= 0 ? expectedEntry : undefined;
    const after = order >= 0 ? actualEntry : undefined;
    if (order <= 0) expectedIndex += 1;
    if (order >= 0) actualIndex += 1;
    if (before && after && before.hash === after.hash && before.size === after.size) continue;
    const pathValue = before?.path ?? after?.path;
    if (!pathValue) continue;
    changedPathCount += 1;
    if (changedPaths.length < MAX_LOOP_RECEIPT_FENCE_CHANGED_PATHS) {
      changedPaths.push({
        path: pathValue,
        kind: before ? (after ? 'modified' : 'removed') : 'added',
      });
    }
  }
  return {
    changedPaths,
    changedPathCount,
    changedPathsTruncated: changedPaths.length !== changedPathCount,
  };
}

function loopReceiptScopeRecovery(
  change: string,
  inspection: LoopReceiptFenceInspection,
  commandExecuted: boolean,
): LoopReceiptScopeRecovery {
  return {
    reason: commandExecuted
      ? 'implementation-changed-during-command'
      : 'implementation-scope-stale',
    commandExecuted,
    expectedScopeHash: inspection.expectedScopeHash,
    actualScopeHash: inspection.actualScopeHash,
    expectedSnapshotHash: inspection.expectedSnapshotHash,
    actualSnapshotHash: inspection.actualSnapshotHash,
    changedPaths: inspection.changedPaths,
    changedPathCount: inspection.changedPathCount,
    changedPathsTruncated: inspection.changedPathsTruncated,
    requiredAction: 'return-to-build-and-refresh-implementation-scope',
    nextCommand: `owner loop next ${change} --summary "Implementation changed after Build; return to Build and refresh scope"`,
    requiresUserDecision: false,
  };
}

function loopReceiptScopeStaleError(
  change: string,
  inspection: LoopReceiptFenceInspection,
): LoopReceiptScopeStaleError {
  const recovery = loopReceiptScopeRecovery(change, inspection, false);
  const changed = recovery.changedPaths.map((entry) => `${entry.kind}: ${entry.path}`).join(', ');
  return new LoopReceiptScopeStaleError(
    `Loop receipt stopped before command execution because the implementation scope changed after Build${changed ? ` (${changed}${recovery.changedPathsTruncated ? ', ...' : ''})` : ''}. Return to Build with \`${recovery.nextCommand}\`, re-freeze the implementation scope, and then issue fresh receipts.`,
    recovery,
  );
}

async function currentReceiptFence(options: {
  paths: LoopProjectPaths;
  context: LoopVerificationReceiptContext;
  now?: Date;
}): Promise<LoopReceiptFenceInspection> {
  const baseline = projectionManifest(options.context.scope.baseline);
  const current = await createLoopCurrentContentSnapshot(options.paths, baseline, {
    origin: 'explicit',
    now: options.now,
  });
  const bundle = buildLoopImplementationScopeBundle({
    baseline,
    current,
    contractHash: options.context.bindings.contractHash,
    declaredArtifacts: options.context.scope.scope.declaredArtifacts,
    noCodeReason: options.context.scope.scope.noCodeReason,
    gitChangedPaths: options.context.scope.authority.gitChangedPaths,
    externalDrift: options.context.scope.authority.externalDrift,
  });
  const changes = inspectLoopReceiptFenceChanges(options.context.scope.current, bundle.current);
  return {
    expectedScopeHash: options.context.bindings.scopeHash,
    actualScopeHash: bundle.scope.scopeHash,
    expectedSnapshotHash: options.context.bindings.snapshotHash,
    actualSnapshotHash: bundle.scope.currentProjectionHash,
    matched:
      bundle.scope.currentProjectionHash === options.context.bindings.snapshotHash &&
      bundle.scope.scopeHash === options.context.bindings.scopeHash,
    ...changes,
  };
}

export async function assertLoopReceiptScopeCurrent(options: {
  paths: LoopProjectPaths;
  state: LoopChangeState;
  context?: LoopVerificationReceiptContext;
}): Promise<LoopVerificationReceiptContext> {
  const context =
    options.context ?? (await loadLoopVerificationReceiptContext(options.paths, options.state));
  const inspection = await currentReceiptFence({ paths: options.paths, context });
  if (!inspection.matched) {
    throw loopReceiptScopeStaleError(options.state.name, inspection);
  }
  return context;
}

async function gitWorktreeIdentity(projectRoot: string): Promise<{
  provider: 'git' | 'none';
  root: string;
  commit: string | null;
}> {
  try {
    const [{ stdout: rootOutput }, { stdout: commitOutput }] = await Promise.all([
      execFileAsync('git', ['-C', projectRoot, 'rev-parse', '--show-toplevel'], {
        windowsHide: true,
        timeout: 10_000,
      }),
      execFileAsync('git', ['-C', projectRoot, 'rev-parse', 'HEAD'], {
        windowsHide: true,
        timeout: 10_000,
      }),
    ]);
    const absoluteRoot = path.resolve(rootOutput.trim());
    const relativeRoot = path.relative(projectRoot, absoluteRoot).replaceAll('\\', '/');
    if (
      relativeRoot === '..' ||
      relativeRoot.startsWith('../') ||
      path.posix.isAbsolute(relativeRoot)
    ) {
      throw new Error('Git worktree is outside the Loop project root');
    }
    const commit = commitOutput.trim().toLowerCase();
    if (!/^[a-f0-9]{40,64}$/u.test(commit)) throw new Error('Git commit identity is invalid');
    return { provider: 'git', root: relativeRoot || '.', commit };
  } catch {
    return { provider: 'none', root: '.', commit: null };
  }
}

export async function issueLoopAutomatedCheckReceipt(options: {
  paths: LoopProjectPaths;
  name: string;
  acceptanceIds: readonly string[];
  command: string;
  args: readonly string[];
  timeoutMs?: number;
  now?: () => Date;
}): Promise<LoopIssuedVerificationReceipt> {
  return withLoopReceiptIssuanceLock({
    paths: options.paths,
    name: options.name,
    operation: `issue automated receipt ${options.name}`,
    issue: (state) => issueLoopAutomatedCheckReceiptLocked({ ...options, state }),
  });
}

async function issueLoopAutomatedCheckReceiptLocked(options: {
  paths: LoopProjectPaths;
  state: LoopChangeState;
  acceptanceIds: readonly string[];
  command: string;
  args: readonly string[];
  timeoutMs?: number;
  now?: () => Date;
}): Promise<LoopIssuedVerificationReceipt> {
  const context = await loadLoopVerificationReceiptContext(options.paths, options.state);
  await assertLoopReceiptScopeCurrent({
    paths: options.paths,
    state: options.state,
    context,
  });
  const beforeWorktree = await gitWorktreeIdentity(options.paths.projectRoot);
  const startedAt = (options.now?.() ?? new Date()).toISOString();
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_LOOP_AUTOMATED_COMMAND_TIMEOUT_MS
  ) {
    throw new Error(
      `Loop automated command timeout must be an integer from 1 through ${MAX_LOOP_AUTOMATED_COMMAND_TIMEOUT_MS}`,
    );
  }
  const output: Buffer[] = [];
  let outputBytes = 0;
  let totalOutputBytes = 0;
  const outputHasher = createHash('sha256');
  let timedOut = false;
  const child = spawnCommand(options.command, options.args, {
    cwd: options.paths.projectRoot,
    env: { ...process.env },
  });
  const collect = (chunk: Buffer): void => {
    outputHasher.update(chunk);
    totalOutputBytes += chunk.byteLength;
    if (outputBytes >= MAX_COMMAND_OUTPUT_BYTES) return;
    const remaining = MAX_COMMAND_OUTPUT_BYTES - outputBytes;
    const bounded = chunk.subarray(0, remaining);
    output.push(Buffer.from(bounded));
    outputBytes += bounded.byteLength;
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const outcome = await new Promise<{ exitCode: number; signal: string | null }>(
    (resolve, reject) => {
      let finished = false;
      let termination: Promise<void> | null = null;
      let terminationTimer: NodeJS.Timeout | null = null;
      const finish = (result: { exitCode: number; signal: string | null }): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (terminationTimer) clearTimeout(terminationTimer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        termination = terminateProcessTree(child).catch(() => {
          child.kill('SIGKILL');
          child.stdout?.destroy();
          child.stderr?.destroy();
        });
        terminationTimer = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish({ exitCode: 124, signal: 'SIGKILL' });
        }, AUTOMATED_COMMAND_TERMINATION_WAIT_MS);
      }, timeoutMs);
      child.once('error', (error) => {
        if (timedOut) {
          void (termination ?? Promise.resolve()).then(() =>
            finish({ exitCode: 124, signal: 'SIGKILL' }),
          );
          return;
        }
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (terminationTimer) clearTimeout(terminationTimer);
        reject(error);
      });
      child.once('close', (code, signal) => {
        void (termination ?? Promise.resolve()).then(() =>
          finish({
            exitCode: timedOut ? 124 : (code ?? 1),
            signal: signal ?? (timedOut ? 'SIGKILL' : null),
          }),
        );
      });
    },
  );
  const endedAt = (options.now?.() ?? new Date()).toISOString();
  const [afterWorktree, afterFence] = await Promise.all([
    gitWorktreeIdentity(options.paths.projectRoot),
    currentReceiptFence({
      paths: options.paths,
      context,
      now: options.now?.(),
    }),
  ]);
  const capture = context.scope.current.capture;
  const requiresGitIdentity =
    capture?.provider === 'git' ||
    (capture?.provider === 'physical-tree' && capture.projection?.provider === 'git');
  const worktreeMatched =
    (!requiresGitIdentity || beforeWorktree.provider === 'git') &&
    beforeWorktree.provider === afterWorktree.provider &&
    beforeWorktree.root === afterWorktree.root &&
    beforeWorktree.commit === afterWorktree.commit;
  const status =
    timedOut || !afterFence.matched || !worktreeMatched
      ? 'blocked'
      : outcome.exitCode === 0
        ? 'passed'
        : 'failed';
  const summary = Buffer.concat(output, outputBytes).toString('utf8').trim();
  const receipt = buildLoopVerificationReceipt({
    kind: 'automated-check',
    role: 'acceptance-evidence',
    status,
    bindings: context.bindings,
    acceptanceIds: normalizeAcceptanceIds(options.acceptanceIds, context.acceptanceIds),
    actor: `loop-runtime:command:${options.command}`,
    issuedAt: endedAt,
    evidence: {
      executable: options.command,
      args: [...options.args],
      cwd: '.',
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      timedOut,
      timeoutMs,
      startedAt,
      endedAt,
      worktree: {
        provider: beforeWorktree.provider,
        root: beforeWorktree.root,
        beforeCommit: beforeWorktree.commit,
        afterCommit: afterWorktree.commit,
      },
      afterFence: {
        snapshotHash: afterFence.actualSnapshotHash,
        scopeHash: afterFence.actualScopeHash,
        matched: afterFence.matched && worktreeMatched,
      },
      outputHash: outputHasher.digest('hex'),
      outputSummary: boundedText(
        redactLoopCredentialText(summary || `(exit ${outcome.exitCode})`),
        'Loop command output summary',
      ),
      outputTruncated: totalOutputBytes > outputBytes,
    },
  });
  return {
    receipt,
    ref: await writeLoopVerificationReceipt({
      paths: options.paths,
      name: options.state.name,
      receipt,
    }),
    ...(!afterFence.matched || !worktreeMatched
      ? { recovery: loopReceiptScopeRecovery(options.state.name, afterFence, true) }
      : {}),
  };
}

export async function validateLoopStaticReceiptDependency(options: {
  paths: LoopProjectPaths;
  state: LoopChangeState;
  receipt: LoopVerificationReceipt;
}): Promise<LoopCheckReceipt | null> {
  if (options.receipt.kind !== 'static-inspection') return null;
  const check = await readLoopCheckReceipt(
    options.paths,
    options.state.name,
    options.receipt.evidence.checkReceiptRef,
  );
  if (check.receiptHash !== options.receipt.evidence.checkReceiptHash) {
    throw new Error('Loop static receipt dependency hash mismatch');
  }
  return check;
}
