import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { inspectGitWorktree } from '../../platform/paths/git-worktree.js';

import { atomicWriteText } from './loop-atomic-file.js';
import { readLoopBoundedTextFile } from './loop-bounded-file.js';
import {
  hashLoopParentContract,
  inspectLoopChildren,
  readLoopChildrenContract,
} from './loop-children.js';
import {
  listActiveLoopChangesOwnedByWorkspace,
  LoopWorkspaceIsolationRequiredError,
} from './loop-change.js';
import {
  executeLoopCheck,
  loopCheckPlanKey,
  loopPortableArgvDisplay,
  resolveLoopCheckCwd,
  validateLoopCheckPlan,
  type LoopCheckPlan,
} from './loop-check-executor.js';
import {
  applyLoopVerifierEnvelope,
  confirmLoopSkillCoordinatedPass,
  confirmLoopPortableAcceptance,
  confirmLoopVerifierUnavailable,
  LOOP_MAX_REQUEST_CHECK_ROUNDS,
  LOOP_MAX_VERIFIER_EXECUTION_FAILURES,
  recordLoopVerifierUnavailable,
  recordLoopVerifierExecutionError,
  resolveLoopVerifierBlocker,
  returnLoopCandidateToBuild,
  reserveLoopVerifierAttempt,
  retryLoopVerifier,
  submitLoopBuilderCandidate,
  type LoopBuilderCandidateInput,
} from './loop-loop-runtime.js';
import {
  readLoopLocalExecution,
  readOrRebuildLoopLocalExecution,
  rebuildLoopLocalExecution,
  writeLoopLocalExecution,
} from './loop-local-execution.js';
import { withLoopMutationLock } from './loop-mutation-lock.js';
import {
  buildLoopPortableAcceptance,
  sameLoopPortableAcceptance,
} from './loop-portable-acceptance.js';
import {
  appendLoopPortableHistory,
  compareAndSwapLoopPortableState,
  createLoopPortableState,
  readLoopPortableState,
  writeLoopPortableState,
} from './loop-portable-state.js';
import { toLoopPortableText } from './loop-portable-text.js';
import type {
  LoopLocalCheckState,
  LoopLocalExecutionState,
  LoopPortableCheckSummary,
  LoopPortableSpecChange,
  LoopPortableState,
  LoopPortableWorkspace,
} from './loop-portable-types.js';
import {
  createLoopRunnerChannel,
  isLoopTrustedVerifierEnvelope,
  type LoopTrustedVerifierEnvelope,
} from './loop-runner-protocol.js';
import {
  parseLoopVerifierResponse,
  type LoopVerifierCheckRequest,
  type LoopVerifierResponse,
} from './loop-verifier-protocol.js';
import {
  inspectLoopVerificationReportAlignment,
  writeLoopVerificationReport,
} from './loop-verification-report-v2.js';
import {
  isInsidePath,
  loopPreferredChangeRuntimeDir,
  resolveContainedLoopPath,
} from './loop-paths.js';
import type { OwnerProjectConfig, LoopProjectPaths } from './loop-types.js';
import type { LoopWorkspaceBinding } from './loop-workspace.js';
import { readProjectConfig, writeProjectConfig } from './loop-config.js';

const NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
export const LOOP_PORTABLE_STATE_FILE = 'owner-state.yaml';
export const LOOP_LOCAL_EXECUTION_FILE = 'state.json';

export const LOOP_PORTABLE_BRIEF_TEMPLATE = `# Outcome

# Scope

# Non-goals

# Acceptance examples

# Constraints and invariants

# Decisions

# Open questions

# Verification expectations
`;

export function loopPortableChangeDir(paths: LoopProjectPaths, name: string): string {
  if (!NAME_PATTERN.test(name)) throw new Error(`Invalid Loop change name: ${name}`);
  const target = path.join(paths.changesDir, name);
  if (!isInsidePath(paths.changesDir, target)) throw new Error('Loop change path escaped');
  return target;
}

export function loopPortableStateFile(paths: LoopProjectPaths, name: string): string {
  return path.join(loopPortableChangeDir(paths, name), LOOP_PORTABLE_STATE_FILE);
}

export function loopLocalExecutionFile(paths: LoopProjectPaths, name: string): string {
  return path.join(loopPreferredChangeRuntimeDir(paths, name), LOOP_LOCAL_EXECUTION_FILE);
}

export async function isLoopPortableChange(
  paths: LoopProjectPaths,
  name: string,
): Promise<boolean> {
  try {
    const source = await fs.readFile(loopPortableStateFile(paths, name), 'utf8');
    return /^schema:\s*owner\.loop\.v4\s*$/mu.test(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function portableWorkspace(binding?: LoopWorkspaceBinding): LoopPortableWorkspace {
  return {
    isolation: binding?.isolation ?? 'current',
    change_branch: binding?.changeBranch ?? null,
    target_branch: binding?.targetBranch ?? null,
    finish: null,
  };
}

function currentBranch(projectRoot: string): string | null {
  const inspection = inspectGitWorktree(projectRoot);
  return inspection.currentBranch;
}

function assertPortableWorkspaceBindingCurrent(
  projectRoot: string,
  binding: LoopWorkspaceBinding | undefined,
): void {
  if (!binding) return;
  const inspection = inspectGitWorktree(projectRoot);
  if (
    binding.changeBranch !== null &&
    (!inspection.isGitWorktree || inspection.currentBranch !== binding.changeBranch)
  ) {
    throw new Error(
      `Loop workspace binding ${binding.changeBranch ?? '(missing)'} does not match the current branch ${inspection.currentBranch ?? '(detached)'}`,
    );
  }
  if (binding.isolation === 'worktree' && !inspection.isSecondaryWorktree) {
    throw new Error('Loop worktree isolation must use a linked Git worktree');
  }
}

export async function createLoopPortableChange(options: {
  paths: LoopProjectPaths;
  name: string;
  language: 'en' | 'zh-CN';
  workspaceBinding?: LoopWorkspaceBinding;
  initialProjectConfig?: OwnerProjectConfig;
  now?: Date;
}): Promise<LoopPortableState> {
  return withLoopMutationLock(options.paths, `create portable change ${options.name}`, async () => {
    if (!NAME_PATTERN.test(options.name))
      throw new Error(`Invalid Loop change name: ${options.name}`);
    if (
      options.initialProjectConfig &&
      (await readProjectConfig(options.paths.projectRoot)) === null
    ) {
      await writeProjectConfig(options.paths.projectRoot, options.initialProjectConfig);
    }
    assertPortableWorkspaceBindingCurrent(options.paths.projectRoot, options.workspaceBinding);
    const activeChanges = (await listActiveLoopChangesOwnedByWorkspace(options.paths)).filter(
      (name) => name !== options.name,
    );
    if (activeChanges.length > 0) {
      throw new LoopWorkspaceIsolationRequiredError(
        options.workspaceBinding?.isolation ?? 'current',
        activeChanges,
      );
    }
    const changeDir = loopPortableChangeDir(options.paths, options.name);
    const runtimeDir = loopPreferredChangeRuntimeDir(options.paths, options.name);
    await Promise.all([
      resolveContainedLoopPath(options.paths.loopRoot, changeDir),
      resolveContainedLoopPath(options.paths.runtimeDir, runtimeDir),
    ]);
    let createdChange = false;
    let createdRuntime = false;
    try {
      await fs.mkdir(options.paths.changesDir, { recursive: true });
      await fs.mkdir(changeDir, { recursive: false });
      createdChange = true;
      await fs.mkdir(options.paths.changesRuntimeDir, { recursive: true });
      await fs.mkdir(runtimeDir, { recursive: false });
      createdRuntime = true;
      await fs.mkdir(path.join(changeDir, 'specs'), { recursive: true });
      await atomicWriteText(path.join(changeDir, 'brief.md'), LOOP_PORTABLE_BRIEF_TEMPLATE);
      const state = createLoopPortableState({
        name: options.name,
        language: options.language,
        workspace: portableWorkspace(options.workspaceBinding),
        createdAt: options.now,
        nextAction: 'confirm-shape',
      });
      await writeLoopPortableState(loopPortableStateFile(options.paths, options.name), state, {
        containedRoot: options.paths.loopRoot,
      });
      await writeLoopLocalExecution(
        loopLocalExecutionFile(options.paths, options.name),
        rebuildLoopLocalExecution({
          portableState: state,
          projectRoot: options.paths.projectRoot,
          branch: currentBranch(options.paths.projectRoot),
        }),
        { containedRoot: options.paths.runtimeDir },
      );
      return state;
    } catch (error) {
      if (createdRuntime) await fs.rm(runtimeDir, { recursive: true, force: true });
      if (createdChange) await fs.rm(changeDir, { recursive: true, force: true });
      throw error;
    }
  });
}

export async function readLoopPortableChange(
  paths: LoopProjectPaths,
  name: string,
): Promise<LoopPortableState> {
  return readLoopPortableState(loopPortableStateFile(paths, name));
}

async function writePortableMutation(options: {
  paths: LoopProjectPaths;
  previous: LoopPortableState;
  next: LoopPortableState;
}): Promise<LoopPortableState> {
  const written = await compareAndSwapLoopPortableState({
    file: loopPortableStateFile(options.paths, options.previous.name),
    expectedStateVersion: options.previous.state_version,
    next: options.next,
    containedRoot: options.paths.loopRoot,
  });
  if (written.verification === null && written.verification_report === null) {
    const report = path.join(loopPortableChangeDir(options.paths, written.name), 'verification.md');
    await resolveContainedLoopPath(options.paths.loopRoot, report);
    await fs.rm(report, { force: true });
  }
  return written;
}

async function discoverLoopPortableSpecChanges(options: {
  paths: LoopProjectPaths;
  state: LoopPortableState;
}): Promise<LoopPortableSpecChange[]> {
  const changeDir = loopPortableChangeDir(options.paths, options.state.name);
  const specsDir = path.join(changeDir, 'specs');
  const removals = new Map(
    options.state.spec_changes
      .filter(({ operation }) => operation === 'remove')
      .map((entry) => [entry.capability, entry]),
  );
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(specsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') entries = [];
    else throw error;
  }
  const changes: LoopPortableSpecChange[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    if (entry.isSymbolicLink()) throw new Error(`Loop spec capability is unsafe: ${entry.name}`);
    if (!entry.isDirectory()) continue;
    if (!NAME_PATTERN.test(entry.name)) throw new Error(`Invalid Loop capability: ${entry.name}`);
    if (removals.has(entry.name)) {
      throw new Error(`Capability ${entry.name} cannot be proposed and removed together`);
    }
    const source = `specs/${entry.name}/spec.md`;
    const file = path.join(changeDir, ...source.split('/'));
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Loop proposed spec must be a regular file: ${source}`);
    }
    const canonical = path.join(options.paths.specsDir, entry.name, 'spec.md');
    let operation: 'create' | 'modify' = 'create';
    try {
      const canonicalStat = await fs.lstat(canonical);
      if (!canonicalStat.isFile() || canonicalStat.isSymbolicLink()) {
        throw new Error(`Canonical Loop spec is unsafe: ${entry.name}`);
      }
      operation = 'modify';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    changes.push({ capability: entry.name, operation, source });
  }
  changes.push(...removals.values());
  return changes.sort((left, right) => left.capability.localeCompare(right.capability, 'en'));
}

async function readLoopPortableAcceptance(options: {
  paths: LoopProjectPaths;
  state: LoopPortableState;
  specChanges: readonly LoopPortableSpecChange[];
}) {
  const changeDir = loopPortableChangeDir(options.paths, options.state.name);
  const brief = await readLoopBoundedTextFile({
    root: changeDir,
    ref: 'brief.md',
    maxBytes: null,
    includeHash: false,
  });
  const specs = [];
  for (const spec of options.specChanges) {
    if (spec.source === null) continue;
    const source = await readLoopBoundedTextFile({
      root: changeDir,
      ref: spec.source,
      maxBytes: null,
      includeHash: false,
    });
    specs.push({ capability: spec.capability, source: source.ref, markdown: source.text });
  }
  return buildLoopPortableAcceptance({ briefMarkdown: brief.text, specs });
}

export async function confirmLoopPortableShape(options: {
  paths: LoopProjectPaths;
  name: string;
}): Promise<LoopPortableState> {
  return withLoopMutationLock(options.paths, `confirm portable shape ${options.name}`, async () => {
    const state = await readLoopPortableChange(options.paths, options.name);
    const specChanges = await discoverLoopPortableSpecChanges({ paths: options.paths, state });
    const acceptance = await readLoopPortableAcceptance({
      paths: options.paths,
      state,
      specChanges,
    });
    const children = await readLoopChildrenContract({
      changeDir: loopPortableChangeDir(options.paths, state.name),
      acceptanceIds: acceptance.map(({ id }) => id),
    });
    if (children && state.workspace.change_branch === null) {
      throw new Error('Loop parent changes require a Git integration branch');
    }
    const next = confirmLoopPortableAcceptance({
      state: { ...state, spec_changes: specChanges },
      acceptance: acceptance.map((entry) => ({ ...entry })),
    });
    delete next.children_contract_hash;
    if (children) {
      next.children_contract_hash = hashLoopParentContract({
        acceptance: next.acceptance,
        children: children.contract,
      });
      const latestDecision = [...state.history]
        .reverse()
        .find(({ outcome }) => outcome === 'pass' || outcome === 'fail');
      if (latestDecision?.outcome === 'fail' && latestDecision.unresolved_ids.length > 0) {
        const inspection = await inspectLoopChildren({ paths: options.paths, state: next });
        const repairCoverage = new Set(
          (inspection?.children ?? [])
            .filter(({ status }) => status !== 'done')
            .flatMap(({ covers }) => covers),
        );
        const missing = latestDecision.unresolved_ids.filter((id) => !repairCoverage.has(id));
        if (missing.length > 0) {
          throw new Error(
            `Loop parent repair plan requires an unfinished child covering: ${missing.join(', ')}`,
          );
        }
      }
    }
    const written = await writePortableMutation({ paths: options.paths, previous: state, next });
    await writeLoopLocalExecution(
      loopLocalExecutionFile(options.paths, state.name),
      rebuildLoopLocalExecution({
        portableState: written,
        projectRoot: options.paths.projectRoot,
        branch: currentBranch(options.paths.projectRoot),
      }),
      { containedRoot: options.paths.runtimeDir },
    );
    return written;
  });
}

export async function inspectLoopPortableAcceptanceDrift(options: {
  paths: LoopProjectPaths;
  state: LoopPortableState;
  ignoreSpecOperationFor?: ReadonlySet<string>;
}): Promise<{ drifted: boolean; reason: string | null }> {
  const specChanges = await discoverLoopPortableSpecChanges(options);
  const ignoredOperations =
    options.ignoreSpecOperationFor ??
    (options.state.children_contract_hash
      ? new Set(options.state.spec_changes.map(({ capability }) => capability))
      : undefined);
  const declarationsMatch =
    specChanges.length === options.state.spec_changes.length &&
    specChanges.every((actual, index) => {
      const expected = options.state.spec_changes[index];
      return (
        expected !== undefined &&
        actual.capability === expected.capability &&
        actual.source === expected.source &&
        (actual.operation === expected.operation ||
          ignoredOperations?.has(actual.capability) === true)
      );
    });
  if (!declarationsMatch) {
    return { drifted: true, reason: 'Loop target specification declarations changed' };
  }
  const acceptance = await readLoopPortableAcceptance({ ...options, specChanges });
  const expected = options.state.acceptance.map(({ source, text }) => ({ source, text }));
  if (!sameLoopPortableAcceptance(expected, acceptance)) {
    return { drifted: true, reason: 'Loop confirmed acceptance criteria changed' };
  }
  let children;
  try {
    children = await readLoopChildrenContract({
      changeDir: loopPortableChangeDir(options.paths, options.state.name),
      acceptanceIds: acceptance.map(({ id }) => id),
    });
  } catch {
    return { drifted: true, reason: 'Loop child declarations changed' };
  }
  const currentHash = children
    ? hashLoopParentContract({ acceptance, children: children.contract })
    : null;
  return currentHash === (options.state.children_contract_hash ?? null)
    ? { drifted: false, reason: null }
    : { drifted: true, reason: 'Loop child declarations changed' };
}

export async function ensureLoopPortableAcceptanceCurrentLocked(options: {
  paths: LoopProjectPaths;
  state: LoopPortableState;
}): Promise<void> {
  const drift = await inspectLoopPortableAcceptanceDrift(options);
  if (!drift.drifted) return;
  const reason = drift.reason ?? 'Loop confirmed requirements changed';
  await returnLoopPortableStateToShapeLocked({
    paths: options.paths,
    state: options.state,
    reason,
  });
  throw new Error(`${reason}; Loop change returned to Shape and requires confirmation`);
}

export async function submitLoopPortableBuilderCandidate(options: {
  paths: LoopProjectPaths;
  name: string;
  input: LoopBuilderCandidateInput;
}): Promise<LoopPortableState> {
  return withLoopMutationLock(
    options.paths,
    `submit portable candidate ${options.name}`,
    async () => {
      const state = await readLoopPortableChange(options.paths, options.name);
      await ensureLoopPortableAcceptanceCurrentLocked({ paths: options.paths, state });
      const children = await readLoopChildrenContract({
        changeDir: loopPortableChangeDir(options.paths, state.name),
        acceptanceIds: state.acceptance.map(({ id }) => id),
      });
      if (children || state.children_contract_hash) {
        throw new Error('Loop parent Build advances child changes instead of a parent Builder');
      }
      const next = submitLoopBuilderCandidate({ state, input: options.input });
      const written = await writePortableMutation({ paths: options.paths, previous: state, next });
      await writeLoopLocalExecution(
        loopLocalExecutionFile(options.paths, state.name),
        rebuildLoopLocalExecution({
          portableState: written,
          projectRoot: options.paths.projectRoot,
          branch: currentBranch(options.paths.projectRoot),
        }),
        { containedRoot: options.paths.runtimeDir },
      );
      return written;
    },
  );
}

export async function completeLoopPortableParentBuild(options: {
  paths: LoopProjectPaths;
  name: string;
  summary: string;
}): Promise<LoopPortableState> {
  return withLoopMutationLock(
    options.paths,
    `complete portable parent Build ${options.name}`,
    async () => {
      const state = await readLoopPortableChange(options.paths, options.name);
      if (state.phase !== 'build' || state.status !== 'active') {
        throw new Error('Loop parent integration can only complete from active Build');
      }
      await ensureLoopPortableAcceptanceCurrentLocked({ paths: options.paths, state });
      const children = await inspectLoopChildren({ paths: options.paths, state });
      if (!children || !state.children_contract_hash) {
        throw new Error(`Loop change ${state.name} has no confirmed child contract`);
      }
      if (!children.confirmed) {
        throw new Error('Loop parent child declarations require Shape confirmation');
      }
      if (!children.allDone) {
        throw new Error('Loop parent cannot enter Verify before every child is merged');
      }
      if (state.loop.stage === 'repairing' && state.verification_result === 'fail') {
        throw new Error('Loop parent verification failed; add and confirm a repair child');
      }
      const runner = createLoopRunnerChannel();
      const identity = runner.captureExecutionIdentity({
        identityProvider: 'skill-coordinated',
        executionRef: `loop-parent-integration:${randomUUID()}`,
      });
      const next = submitLoopBuilderCandidate({
        state,
        input: {
          identity,
          summary: options.summary,
          addressedAcceptanceIds: state.acceptance.map(({ id }) => id),
          checks: [],
          knownLimits: [],
        },
      });
      const written = await writePortableMutation({ paths: options.paths, previous: state, next });
      await writeLoopLocalExecution(
        loopLocalExecutionFile(options.paths, state.name),
        rebuildLoopLocalExecution({
          portableState: written,
          projectRoot: options.paths.projectRoot,
          branch: currentBranch(options.paths.projectRoot),
        }),
        { containedRoot: options.paths.runtimeDir },
      );
      return written;
    },
  );
}

function localCheck(
  plan: LoopCheckPlan,
  operationId: string,
  projectRoot: string,
): LoopLocalCheckState {
  return {
    id: plan.id,
    name: plan.name,
    operationId,
    status: 'planned',
    repeatable: plan.repeatable,
    timeoutMs: plan.timeoutMs,
    executionCount: 0,
    argv: [plan.executable, ...plan.argv],
    cwd: resolveLoopCheckCwd(projectRoot, plan.cwdRef),
    exitCode: null,
    startedAt: null,
    completedAt: null,
    log: `logs/checks/${operationId}-${plan.id}.log`,
  };
}

function resetInterruptedCheck(
  previous: LoopLocalCheckState,
  plan: LoopCheckPlan,
  operationId: string,
  projectRoot: string,
): LoopLocalCheckState {
  if (!previous.repeatable) {
    throw new Error(
      `Loop check ${previous.id} was interrupted and is not repeatable; user resolution is required`,
    );
  }
  return {
    ...localCheck(plan, operationId, projectRoot),
    executionCount: previous.executionCount,
  };
}

function localCheckCwdRef(projectRoot: string, cwd: string): string {
  const relative = path.relative(path.resolve(projectRoot), path.resolve(cwd));
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error('Loop local check cwd escaped the project root');
  }
  const cwdRef = relative.length === 0 ? '.' : relative.split(path.sep).join('/');
  resolveLoopCheckCwd(projectRoot, cwdRef);
  return cwdRef;
}

function localCheckPlanKey(check: LoopLocalCheckState, projectRoot: string): string {
  const [executable, ...argv] = check.argv;
  if (!executable) throw new Error(`Loop local check ${check.id} has no executable`);
  return loopCheckPlanKey({
    id: check.id,
    name: check.id,
    executable,
    argv,
    cwdRef: localCheckCwdRef(projectRoot, check.cwd),
    timeoutMs: check.timeoutMs,
    repeatable: check.repeatable,
  });
}

function completedCheckDuration(check: LoopLocalCheckState): number {
  if (check.startedAt === null || check.completedAt === null) return 0;
  return Math.max(0, Date.parse(check.completedAt) - Date.parse(check.startedAt));
}

function authoritativePortableChecks(options: {
  local: LoopLocalExecutionState;
  projectRoot: string;
  supplied: readonly LoopPortableCheckSummary[];
  requestedNames?: ReadonlyMap<string, string>;
}): LoopPortableCheckSummary[] {
  const suppliedById = new Map<string, LoopPortableCheckSummary>();
  for (const check of options.supplied) {
    if (suppliedById.has(check.id)) {
      throw new Error(`Loop Runtime check summaries contain duplicate ID ${check.id}`);
    }
    suppliedById.set(check.id, check);
  }
  return options.local.checks.map((check) => {
    if (check.status === 'planned' || check.status === 'running') {
      throw new Error(`Loop Runtime check ${check.id} has not completed`);
    }
    const name = options.requestedNames?.get(check.id) ?? check.name;
    return {
      id: check.id,
      name: toLoopPortableText(name),
      argv_display: loopPortableArgvDisplay(check.argv.slice(1)).map((entry) =>
        toLoopPortableText(entry),
      ),
      argv_truncated: false,
      cwd_ref: localCheckCwdRef(options.projectRoot, check.cwd),
      status: check.status,
      exit_code: check.exitCode,
      duration_ms: completedCheckDuration(check),
    };
  });
}

function requestCheckPlan(request: LoopVerifierCheckRequest): LoopCheckPlan {
  return {
    id: request.id,
    name: request.name,
    executable: request.executable,
    argv: [...request.argv],
    cwdRef: request.cwdRef,
    timeoutMs: request.timeoutMs,
    repeatable: request.repeatable,
  };
}

function preservedLocalChecksForVersion(options: {
  local: LoopLocalExecutionState | null;
  state: LoopPortableState;
  projectRoot: string;
}): LoopLocalExecutionState {
  if (options.local === null || options.local.change !== options.state.name) {
    return rebuildLoopLocalExecution({
      portableState: options.state,
      projectRoot: options.projectRoot,
      branch: currentBranch(options.projectRoot),
    });
  }
  const operationId = options.local.execution?.operationId ?? randomUUID();
  return {
    ...options.local,
    basedOnStateVersion: options.state.state_version,
    execution: {
      operationId,
      stage: 'checking',
      actor: 'runtime',
      executionId: null,
      status: 'completed',
      startedAt: options.local.execution?.startedAt ?? new Date().toISOString(),
      requestCheckRounds: 0,
    },
    checks: options.local.checks.map((check) =>
      check.status === 'running' || check.status === 'planned'
        ? { ...check, operationId, status: 'interrupted' as const }
        : { ...check, operationId },
    ),
  };
}

async function readCurrentLocalExecution(options: {
  paths: LoopProjectPaths;
  state: LoopPortableState;
}): Promise<LoopLocalExecutionState | null> {
  try {
    const local = await readLoopLocalExecution(
      loopLocalExecutionFile(options.paths, options.state.name),
    );
    if (
      local === null ||
      local.change !== options.state.name ||
      local.basedOnStateVersion !== options.state.state_version
    ) {
      return null;
    }
    return local;
  } catch {
    return null;
  }
}

export interface LoopVerifierAttemptBinding {
  stateVersion: number;
  iteration: number;
  attempt: number;
  verifierExecutionRef: string;
}

function assertCurrentVerifierAttempt(options: {
  state: LoopPortableState;
  local: LoopLocalExecutionState | null;
  expected: LoopVerifierAttemptBinding;
}): LoopLocalExecutionState {
  const { state, local, expected } = options;
  if (
    state.state_version !== expected.stateVersion ||
    state.phase !== 'verify' ||
    state.status !== 'active' ||
    state.loop.next_action !== 'await-verifier-result' ||
    state.loop.iteration !== expected.iteration ||
    state.loop.attempt !== expected.attempt ||
    state.builder_handoff === null ||
    local === null ||
    local.basedOnStateVersion !== state.state_version ||
    local.execution === null ||
    local.execution.stage !== 'verifying' ||
    local.execution.actor !== 'verifier' ||
    local.execution.status !== 'running' ||
    local.execution.executionId !== expected.verifierExecutionRef
  ) {
    throw new Error('Loop Verifier execution message is stale for the current attempt');
  }
  return local;
}

function assertCurrentVerifierEnvelope(options: {
  state: LoopPortableState;
  local: LoopLocalExecutionState | null;
  envelope: LoopTrustedVerifierEnvelope<unknown> | unknown;
}): LoopTrustedVerifierEnvelope<unknown> {
  const { state, local, envelope } = options;
  if (!isLoopTrustedVerifierEnvelope(envelope)) {
    throw new Error('Loop Verifier result must come from the trusted Runner channel');
  }
  if (
    state.phase !== 'verify' ||
    state.status !== 'active' ||
    state.loop.next_action !== 'await-verifier-result' ||
    state.builder_handoff === null
  ) {
    throw new Error('Loop Verifier result is stale for the current workflow state');
  }
  if (
    envelope.candidateId !== state.builder_handoff.candidate_id ||
    envelope.identityProvider !== state.builder_handoff.identity_provider ||
    envelope.verifierExecutionRef === state.builder_handoff.builder_execution_ref
  ) {
    throw new Error('Loop Verifier result is stale for the current candidate or identity');
  }
  if (
    local === null ||
    local.execution === null ||
    local.execution.stage !== 'verifying' ||
    local.execution.actor !== 'verifier' ||
    local.execution.status !== 'running' ||
    (local.execution.executionId !== null &&
      local.execution.executionId !== envelope.verifierExecutionRef)
  ) {
    throw new Error('Loop Verifier result is stale for the active execution');
  }
  return envelope;
}

function loopVerifierResponsePosition(response: LoopVerifierResponse): {
  iteration: number;
  attempt: number;
} {
  return response.kind === 'final-result'
    ? { iteration: response.result.iteration, attempt: response.result.attempt }
    : { iteration: response.iteration, attempt: response.attempt };
}

async function persistVerifierExecutionError(options: {
  paths: LoopProjectPaths;
  state: LoopPortableState;
  summary: string;
}): Promise<LoopPortableState> {
  const local = await readCurrentLocalExecution({ paths: options.paths, state: options.state });
  const next = recordLoopVerifierExecutionError({
    state: options.state,
    summary: options.summary,
  });
  const written = await writePortableMutation({
    paths: options.paths,
    previous: options.state,
    next,
  });
  await writeLoopLocalExecution(
    loopLocalExecutionFile(options.paths, options.state.name),
    preservedLocalChecksForVersion({
      local,
      state: written,
      projectRoot: options.paths.projectRoot,
    }),
    { containedRoot: options.paths.runtimeDir },
  );
  return written;
}

function sameLoopCheckPlan(
  local: LoopLocalExecutionState,
  plans: readonly LoopCheckPlan[],
  projectRoot: string,
): boolean {
  if (local.checks.length !== plans.length) return false;
  return local.checks.every(
    (check, index) => localCheckPlanKey(check, projectRoot) === loopCheckPlanKey(plans[index]),
  );
}

async function reserveLoopPortableCheckPlan(options: {
  paths: LoopProjectPaths;
  name: string;
  plans: LoopCheckPlan[];
}): Promise<
  | {
      kind: 'execute';
      state: LoopPortableState;
      local: LoopLocalExecutionState;
      plans: LoopCheckPlan[];
    }
  | { kind: 'reuse'; state: LoopPortableState; checks: LoopPortableCheckSummary[] }
> {
  return withLoopMutationLock(
    options.paths,
    `reserve portable checks ${options.name}`,
    async () => {
      const state = await readLoopPortableChange(options.paths, options.name);
      await ensureLoopPortableAcceptanceCurrentLocked({ paths: options.paths, state });
      if (state.phase !== 'verify' || state.loop.stage !== 'verify-ready') {
        throw new Error('Loop checks require Verify ready state');
      }
      const file = loopLocalExecutionFile(options.paths, state.name);
      const local = (
        await readOrRebuildLoopLocalExecution({
          file,
          portableState: state,
          projectRoot: options.paths.projectRoot,
          branch: currentBranch(options.paths.projectRoot),
          containedRoot: options.paths.runtimeDir,
        })
      ).state;
      if (
        local.execution?.stage === 'checking' &&
        local.execution.actor === 'runtime' &&
        sameLoopCheckPlan(local, options.plans, options.paths.projectRoot)
      ) {
        const execution = local.execution;
        if (execution.status === 'running') {
          throw new Error('Loop check plan is already in progress');
        }
        const interrupted = local.checks.filter((check) => check.status === 'interrupted');
        if (interrupted.length === 0 && execution.status === 'completed') {
          const requestedNames = new Map(options.plans.map(({ id, name }) => [id, name] as const));
          return {
            kind: 'reuse',
            state,
            checks: authoritativePortableChecks({
              local,
              projectRoot: options.paths.projectRoot,
              supplied: [],
              requestedNames,
            }),
          };
        }
        if (interrupted.length > 0 && interrupted.some((check) => !check.repeatable)) {
          const next = returnLoopCandidateToBuild({
            state,
            reason: `A non-repeatable Runtime check was interrupted (${interrupted
              .filter((check) => !check.repeatable)
              .map(({ id }) => id)
              .join(', ')}); a new Builder candidate is required before it can run again.`,
          });
          const written = await writePortableMutation({
            paths: options.paths,
            previous: state,
            next,
          });
          await writeLoopLocalExecution(
            loopLocalExecutionFile(options.paths, state.name),
            rebuildLoopLocalExecution({
              portableState: written,
              projectRoot: options.paths.projectRoot,
              branch: currentBranch(options.paths.projectRoot),
            }),
            { containedRoot: options.paths.runtimeDir },
          );
          throw new Error(
            `Loop check ${interrupted.find((check) => !check.repeatable)!.id} was interrupted and is not repeatable; the change returned to Build for a new candidate`,
          );
        }
      }
      if (local.execution !== null && local.checks.length > 0) {
        const sameInterruptedPlan =
          local.execution.stage === 'checking' &&
          local.execution.actor === 'runtime' &&
          local.checks.some((check) => check.status === 'interrupted') &&
          sameLoopCheckPlan(local, options.plans, options.paths.projectRoot);
        if (!sameInterruptedPlan) {
          throw new Error('Loop check plan was already resolved with a different plan');
        }
      } else if (local.execution !== null || local.checks.length > 0) {
        throw new Error('Loop check plan was already resolved with a different plan');
      }
      const operationId = randomUUID();
      const operation: LoopLocalExecutionState = {
        ...local,
        execution: {
          operationId,
          stage: 'checking',
          actor: 'runtime',
          executionId: null,
          status: 'running',
          startedAt: new Date().toISOString(),
          requestCheckRounds: 0,
        },
        checks: options.plans.map((plan) => {
          const previous = local.checks.find((check) => check.id === plan.id);
          if (previous?.status === 'interrupted') {
            return resetInterruptedCheck(previous, plan, operationId, options.paths.projectRoot);
          }
          if (previous) return { ...previous, operationId };
          return localCheck(plan, operationId, options.paths.projectRoot);
        }),
      };
      await writeLoopLocalExecution(file, operation, { containedRoot: options.paths.runtimeDir });
      return {
        kind: 'execute',
        state,
        local: operation,
        plans: options.plans.filter((plan) => {
          const previous = local.checks.find((check) => check.id === plan.id);
          return previous === undefined || previous.status === 'interrupted';
        }),
      };
    },
  );
}

async function updateReservedLoopCheckPlan(options: {
  paths: LoopProjectPaths;
  state: LoopPortableState;
  operationId: string;
  update: (local: LoopLocalExecutionState) => LoopLocalExecutionState;
}): Promise<LoopLocalExecutionState> {
  return withLoopMutationLock(
    options.paths,
    `update portable checks ${options.state.name}`,
    async () => {
      const state = await readLoopPortableChange(options.paths, options.state.name);
      if (
        state.state_version !== options.state.state_version ||
        state.phase !== 'verify' ||
        state.loop.stage !== 'verify-ready'
      ) {
        throw new Error('Loop check plan state changed during execution');
      }
      const file = loopLocalExecutionFile(options.paths, state.name);
      const local = await readLoopLocalExecution(file);
      if (
        local === null ||
        local.basedOnStateVersion !== state.state_version ||
        local.execution?.operationId !== options.operationId ||
        local.execution.stage !== 'checking' ||
        local.execution.actor !== 'runtime' ||
        local.execution.status !== 'running'
      ) {
        throw new Error('Loop check plan reservation changed during execution');
      }
      const next = options.update(local);
      await writeLoopLocalExecution(file, next, { containedRoot: options.paths.runtimeDir });
      return next;
    },
  );
}

export async function executeLoopPortableCheckPlan(options: {
  paths: LoopProjectPaths;
  name: string;
  plans: LoopCheckPlan[];
}): Promise<{ state: LoopPortableState; checks: LoopPortableCheckSummary[] }> {
  if (new Set(options.plans.map(({ id }) => id)).size !== options.plans.length) {
    throw new Error('Loop check plan contains duplicate IDs');
  }
  const normalizedPlans: LoopCheckPlan[] = [];
  const seenPlanKeys = new Set<string>();
  for (const plan of options.plans) {
    validateLoopCheckPlan(options.paths.projectRoot, plan);
    const key = loopCheckPlanKey(plan);
    if (seenPlanKeys.has(key)) continue;
    seenPlanKeys.add(key);
    normalizedPlans.push(plan);
  }
  const reservation = await reserveLoopPortableCheckPlan({ ...options, plans: normalizedPlans });
  if (reservation.kind === 'reuse') return reservation;

  const operationId = reservation.local.execution!.operationId;
  const runtimeDir = loopPreferredChangeRuntimeDir(options.paths, reservation.state.name);
  try {
    for (const plan of reservation.plans) {
      const startedAt = new Date().toISOString();
      await updateReservedLoopCheckPlan({
        paths: options.paths,
        state: reservation.state,
        operationId,
        update: (local) => ({
          ...local,
          checks: local.checks.map((check) =>
            check.id === plan.id
              ? {
                  ...check,
                  status: 'running',
                  executionCount: check.executionCount + 1,
                  startedAt,
                }
              : check,
          ),
        }),
      });
      const result = await executeLoopCheck({
        projectRoot: options.paths.projectRoot,
        runtimeDir,
        operationId,
        plan,
      });
      await updateReservedLoopCheckPlan({
        paths: options.paths,
        state: reservation.state,
        operationId,
        update: (local) => ({
          ...local,
          checks: local.checks.map((check) =>
            check.id === plan.id
              ? {
                  ...check,
                  status: result.status,
                  exitCode: result.exitCode,
                  startedAt: result.startedAt,
                  completedAt: result.completedAt,
                  log: result.logRef,
                }
              : check,
          ),
        }),
      });
    }
    await updateReservedLoopCheckPlan({
      paths: options.paths,
      state: reservation.state,
      operationId,
      update: (local) => ({
        ...local,
        execution: { ...local.execution!, status: 'completed' },
      }),
    });
  } catch (error) {
    try {
      await updateReservedLoopCheckPlan({
        paths: options.paths,
        state: reservation.state,
        operationId,
        update: (local) => ({
          ...local,
          execution: { ...local.execution!, status: 'interrupted' },
          checks: local.checks.map((check) =>
            check.status === 'planned' || check.status === 'running'
              ? { ...check, status: 'interrupted' as const }
              : check,
          ),
        }),
      });
    } catch {
      // Preserve the original execution failure; recovery will inspect the overlay.
    }
    throw error;
  }
  const finalLocal = await readLoopLocalExecution(
    loopLocalExecutionFile(options.paths, reservation.state.name),
  );
  if (finalLocal === null) throw new Error('Loop Runtime check state disappeared after execution');
  return {
    state: reservation.state,
    checks: authoritativePortableChecks({
      local: finalLocal,
      projectRoot: options.paths.projectRoot,
      supplied: [],
    }),
  };
}

export interface LoopPortableRequestChecksOutcome {
  round: number;
  reusedCheckIds: string[];
  executedCheckIds: string[];
}

interface LoopVerifierRequestedCheckReservation {
  state: LoopPortableState;
  local: LoopLocalExecutionState;
  verifierExecutionRef: string;
  round: number;
  novelPlans: LoopCheckPlan[];
  requestedNames: ReadonlyMap<string, string>;
  reusedCheckIds: string[];
  suppliedChecks: readonly LoopPortableCheckSummary[];
}

async function reserveVerifierRequestedChecks(options: {
  paths: LoopProjectPaths;
  state: LoopPortableState;
  local: LoopLocalExecutionState;
  envelope: LoopTrustedVerifierEnvelope<unknown>;
  response: Extract<LoopVerifierResponse, { kind: 'request-checks' }>;
  suppliedChecks: readonly LoopPortableCheckSummary[];
}): Promise<LoopVerifierRequestedCheckReservation> {
  const file = loopLocalExecutionFile(options.paths, options.state.name);
  const local = options.local;
  if (
    local === null ||
    local.change !== options.state.name ||
    local.basedOnStateVersion !== options.state.state_version ||
    local.execution === null ||
    local.execution.stage !== 'verifying' ||
    local.execution.actor !== 'verifier' ||
    local.execution.status !== 'running'
  ) {
    throw new Error('Loop Verifier request-checks has no active local execution');
  }
  if (
    local.execution.executionId !== null &&
    local.execution.executionId !== options.envelope.verifierExecutionRef
  ) {
    throw new Error('Loop Verifier request-checks changed execution within the same attempt');
  }
  if (local.execution.requestCheckRounds >= LOOP_MAX_REQUEST_CHECK_ROUNDS) {
    throw new Error(
      `Loop Verifier request-checks exceeded ${LOOP_MAX_REQUEST_CHECK_ROUNDS} rounds for this attempt`,
    );
  }

  const existingByKey = new Map<string, LoopLocalCheckState>();
  const existingByKeyAll = new Map<string, LoopLocalCheckState>();
  const existingKeyById = new Map<string, string>();
  for (const check of local.checks) {
    const key = localCheckPlanKey(check, options.paths.projectRoot);
    existingByKeyAll.set(key, check);
    if (check.status !== 'interrupted') existingByKey.set(key, check);
    existingKeyById.set(check.id, key);
  }

  const requestedByKey = new Map<string, LoopCheckPlan>();
  const requestedKeyById = new Map<string, string>();
  for (const request of options.response.checks) {
    const plan = requestCheckPlan(request);
    validateLoopCheckPlan(options.paths.projectRoot, plan);
    const key = loopCheckPlanKey(plan);
    const previousRequestKey = requestedKeyById.get(plan.id);
    if (previousRequestKey !== undefined && previousRequestKey !== key) {
      throw new Error(`Loop Verifier check ID ${plan.id} refers to conflicting commands`);
    }
    const existingKey = existingKeyById.get(plan.id);
    if (existingKey !== undefined && existingKey !== key) {
      throw new Error(`Loop Verifier check ID ${plan.id} conflicts with a Runtime check`);
    }
    requestedKeyById.set(plan.id, key);
    const existing = existingByKeyAll.get(key);
    if (existing?.status === 'interrupted' && !existing.repeatable) {
      throw new Error(
        `Loop check ${existing.id} was interrupted and is not repeatable; user resolution is required`,
      );
    }
    if (!requestedByKey.has(key)) requestedByKey.set(key, plan);
  }

  const requested = [...requestedByKey.entries()];
  const novel = requested.filter(([key]) => !existingByKey.has(key));
  if (local.execution.requestCheckRounds > 0 && novel.length === 0) {
    throw new Error('Loop Verifier repeatedly requested only equivalent checks');
  }

  const round = local.execution.requestCheckRounds + 1;
  const requestedNames = new Map(requested.map(([, plan]) => [plan.id, plan.name] as const));
  const operation: LoopLocalExecutionState = {
    ...local,
    execution: {
      ...local.execution,
      stage: 'checking',
      actor: 'runtime',
      executionId: options.envelope.verifierExecutionRef,
      requestCheckRounds: round,
    },
    checks: [
      ...local.checks.map((check) => {
        const key = localCheckPlanKey(check, options.paths.projectRoot);
        const plan = requestedByKey.get(key);
        return plan && check.status === 'interrupted'
          ? resetInterruptedCheck(
              check,
              plan,
              local.execution!.operationId,
              options.paths.projectRoot,
            )
          : check;
      }),
      ...novel
        .filter(([key]) => !existingByKeyAll.has(key))
        .map(([, plan]) =>
          localCheck(plan, local.execution!.operationId, options.paths.projectRoot),
        ),
    ],
  };
  await writeLoopLocalExecution(file, operation, { containedRoot: options.paths.runtimeDir });

  return {
    state: options.state,
    local: operation,
    verifierExecutionRef: options.envelope.verifierExecutionRef,
    round,
    novelPlans: novel.map(([, plan]) => plan),
    requestedNames,
    reusedCheckIds: requested.filter(([key]) => existingByKey.has(key)).map(([, plan]) => plan.id),
    suppliedChecks: options.suppliedChecks,
  };
}

async function updateReservedVerifierRequestedChecks(options: {
  paths: LoopProjectPaths;
  reservation: LoopVerifierRequestedCheckReservation;
  update: (local: LoopLocalExecutionState) => LoopLocalExecutionState;
}): Promise<LoopLocalExecutionState> {
  return withLoopMutationLock(
    options.paths,
    `update Verifier-requested checks ${options.reservation.state.name}`,
    async () => {
      const state = await readLoopPortableChange(options.paths, options.reservation.state.name);
      if (
        state.state_version !== options.reservation.state.state_version ||
        state.phase !== 'verify' ||
        state.loop.next_action !== 'await-verifier-result'
      ) {
        throw new Error('Loop Verifier request-checks state changed during execution');
      }
      const file = loopLocalExecutionFile(options.paths, state.name);
      const local = await readLoopLocalExecution(file);
      const execution = local?.execution;
      if (
        local === null ||
        local.basedOnStateVersion !== state.state_version ||
        execution === null ||
        execution === undefined ||
        execution.operationId !== options.reservation.local.execution?.operationId ||
        execution.stage !== 'checking' ||
        execution.actor !== 'runtime' ||
        execution.status !== 'running' ||
        execution.executionId !== options.reservation.verifierExecutionRef ||
        execution.requestCheckRounds !== options.reservation.round
      ) {
        throw new Error('Loop Verifier request-checks reservation changed during execution');
      }
      const next = options.update(local);
      await writeLoopLocalExecution(file, next, { containedRoot: options.paths.runtimeDir });
      return next;
    },
  );
}

async function executeReservedVerifierRequestedChecks(options: {
  paths: LoopProjectPaths;
  reservation: LoopVerifierRequestedCheckReservation;
}): Promise<{
  checks: LoopPortableCheckSummary[];
  requestChecks: LoopPortableRequestChecksOutcome;
}> {
  let operation: LoopLocalExecutionState;
  try {
    for (const plan of options.reservation.novelPlans) {
      const startedAt = new Date().toISOString();
      operation = await updateReservedVerifierRequestedChecks({
        paths: options.paths,
        reservation: options.reservation,
        update: (local) => ({
          ...local,
          checks: local.checks.map((check) =>
            check.id === plan.id
              ? {
                  ...check,
                  status: 'running',
                  executionCount: check.executionCount + 1,
                  startedAt,
                }
              : check,
          ),
        }),
      });
      const result = await executeLoopCheck({
        projectRoot: options.paths.projectRoot,
        runtimeDir: loopPreferredChangeRuntimeDir(options.paths, options.reservation.state.name),
        operationId: options.reservation.local.execution!.operationId,
        plan,
      });
      operation = await updateReservedVerifierRequestedChecks({
        paths: options.paths,
        reservation: options.reservation,
        update: (local) => ({
          ...local,
          checks: local.checks.map((check) =>
            check.id === plan.id
              ? {
                  ...check,
                  status: result.status,
                  exitCode: result.exitCode,
                  startedAt: result.startedAt,
                  completedAt: result.completedAt,
                  log: result.logRef,
                }
              : check,
          ),
        }),
      });
    }

    operation = await updateReservedVerifierRequestedChecks({
      paths: options.paths,
      reservation: options.reservation,
      update: (local) => ({
        ...local,
        execution: {
          ...local.execution!,
          stage: 'verifying',
          actor: 'verifier',
          executionId: options.reservation.verifierExecutionRef,
        },
      }),
    });
  } catch (error) {
    try {
      await updateReservedVerifierRequestedChecks({
        paths: options.paths,
        reservation: options.reservation,
        update: (local) => ({
          ...local,
          execution: { ...local.execution!, status: 'interrupted' },
          checks: local.checks.map((check) =>
            check.status === 'planned' || check.status === 'running'
              ? { ...check, status: 'interrupted' as const }
              : check,
          ),
        }),
      });
    } catch {
      // Preserve the original execution failure; recovery will inspect the overlay.
    }
    throw error;
  }
  return {
    checks: authoritativePortableChecks({
      local: operation,
      projectRoot: options.paths.projectRoot,
      supplied: options.reservation.suppliedChecks,
      requestedNames: options.reservation.requestedNames,
    }),
    requestChecks: {
      round: options.reservation.round,
      reusedCheckIds: options.reservation.reusedCheckIds,
      executedCheckIds: options.reservation.novelPlans.map(({ id }) => id),
    },
  };
}

export async function dispatchLoopPortableVerifier(options: {
  paths: LoopProjectPaths;
  name: string;
  checks: LoopPortableCheckSummary[];
  verifierExecutionId?: string | null;
}): Promise<LoopPortableState> {
  return withLoopMutationLock(
    options.paths,
    `dispatch portable verifier ${options.name}`,
    async () => {
      const state = await readLoopPortableChange(options.paths, options.name);
      await ensureLoopPortableAcceptanceCurrentLocked({ paths: options.paths, state });
      const localBeforeDispatch = (
        await readOrRebuildLoopLocalExecution({
          file: loopLocalExecutionFile(options.paths, state.name),
          portableState: state,
          projectRoot: options.paths.projectRoot,
          branch: currentBranch(options.paths.projectRoot),
          containedRoot: options.paths.runtimeDir,
        })
      ).state;
      if (
        localBeforeDispatch.execution?.stage !== 'checking' ||
        localBeforeDispatch.execution.actor !== 'runtime' ||
        localBeforeDispatch.execution.status !== 'completed'
      ) {
        throw new Error('Loop check plan must be explicitly resolved before Verifier dispatch');
      }
      authoritativePortableChecks({
        local: localBeforeDispatch,
        projectRoot: options.paths.projectRoot,
        supplied: options.checks,
      });
      const next = reserveLoopVerifierAttempt(state);
      const written = await writePortableMutation({ paths: options.paths, previous: state, next });
      const file = loopLocalExecutionFile(options.paths, state.name);
      const operationId = randomUUID();
      await writeLoopLocalExecution(
        file,
        {
          ...localBeforeDispatch,
          basedOnStateVersion: written.state_version,
          execution: {
            operationId,
            stage: 'verifying',
            actor: 'verifier',
            executionId: options.verifierExecutionId ?? null,
            status: 'running',
            startedAt: new Date().toISOString(),
            requestCheckRounds: 0,
          },
          checks: localBeforeDispatch.checks.map((check) => ({ ...check, operationId })),
        },
        { containedRoot: options.paths.runtimeDir },
      );
      return written;
    },
  );
}

export async function submitLoopPortableVerifierResult(options: {
  paths: LoopProjectPaths;
  name: string;
  envelope: LoopTrustedVerifierEnvelope<unknown> | unknown;
  checks: LoopPortableCheckSummary[];
  maxVerifyFailures: number;
}): Promise<{
  state: LoopPortableState;
  response: LoopVerifierResponse;
  checks: LoopPortableCheckSummary[];
  requestChecks: LoopPortableRequestChecksOutcome | null;
}> {
  if (!Number.isSafeInteger(options.maxVerifyFailures) || options.maxVerifyFailures < 1) {
    throw new Error('Loop max Verify failures must be a positive integer');
  }
  const prepared = await withLoopMutationLock(
    options.paths,
    `apply portable verifier ${options.name}`,
    async () => {
      const state = await readLoopPortableChange(options.paths, options.name);
      await ensureLoopPortableAcceptanceCurrentLocked({ paths: options.paths, state });
      const local = await readCurrentLocalExecution({ paths: options.paths, state });
      const trustedEnvelope = assertCurrentVerifierEnvelope({
        state,
        local,
        envelope: options.envelope,
      });
      let parsedResponse: LoopVerifierResponse;
      try {
        parsedResponse = parseLoopVerifierResponse(trustedEnvelope.payload);
      } catch (error) {
        const summary = `Loop Verifier response was invalid: ${(error as Error).message}`;
        const failed = await persistVerifierExecutionError({
          paths: options.paths,
          state,
          summary,
        });
        throw new Error(
          `${summary}; execution error ${failed.loop.execution_failure_count}/${LOOP_MAX_VERIFIER_EXECUTION_FAILURES} was recorded`,
          { cause: error },
        );
      }
      const position = loopVerifierResponsePosition(parsedResponse);
      if (position.iteration !== state.loop.iteration || position.attempt !== state.loop.attempt) {
        throw new Error('Loop Verifier result is stale for the current iteration or attempt');
      }
      let runtimeChecks: LoopPortableCheckSummary[] = [];
      let finalResult: ReturnType<typeof applyLoopVerifierEnvelope>;
      try {
        if (local !== null) {
          runtimeChecks = authoritativePortableChecks({
            local,
            projectRoot: options.paths.projectRoot,
            supplied: options.checks,
          });
        }
        const result = applyLoopVerifierEnvelope({
          state,
          envelope: trustedEnvelope,
          checks: runtimeChecks,
          maxVerifyFailures: options.maxVerifyFailures,
        });
        if (result.response.kind === 'request-checks') {
          if (local === null) {
            throw new Error('Loop Verifier request-checks has no active local execution');
          }
          const reservation = await reserveVerifierRequestedChecks({
            paths: options.paths,
            state,
            local,
            envelope: trustedEnvelope,
            response: result.response,
            suppliedChecks: runtimeChecks,
          });
          return {
            kind: 'request-checks' as const,
            state,
            response: result.response,
            reservation,
          };
        }
        if (
          local === null ||
          local.execution === null ||
          local.execution.stage !== 'verifying' ||
          local.execution.actor !== 'verifier' ||
          local.execution.status !== 'running'
        ) {
          throw new Error('Loop Verifier final result has no active local execution');
        }
        if (
          local.execution.executionId !== null &&
          local.execution.executionId !== trustedEnvelope.verifierExecutionRef
        ) {
          throw new Error('Loop Verifier final result changed execution within the same attempt');
        }
        finalResult = result;
      } catch (error) {
        const summary = `Loop Verifier response was invalid: ${(error as Error).message}`;
        const failed = await persistVerifierExecutionError({
          paths: options.paths,
          state,
          summary,
        });
        throw new Error(
          `${summary}; execution error ${failed.loop.execution_failure_count}/${LOOP_MAX_VERIFIER_EXECUTION_FAILURES} was recorded`,
          { cause: error },
        );
      }
      const written = await writePortableMutation({
        paths: options.paths,
        previous: state,
        next: finalResult.state,
      });
      await writeLoopLocalExecution(
        loopLocalExecutionFile(options.paths, state.name),
        written.loop.next_action === 'resolve-verifier-blocker'
          ? preservedLocalChecksForVersion({
              local,
              state: written,
              projectRoot: options.paths.projectRoot,
            })
          : rebuildLoopLocalExecution({
              portableState: written,
              projectRoot: options.paths.projectRoot,
              branch: currentBranch(options.paths.projectRoot),
            }),
        { containedRoot: options.paths.runtimeDir },
      );
      if (written.verification !== null) {
        await writeLoopVerificationReport({
          file: path.join(loopPortableChangeDir(options.paths, state.name), 'verification.md'),
          state: written,
        });
      }
      return {
        kind: 'final-result' as const,
        result: {
          state: written,
          response: finalResult.response,
          checks: runtimeChecks,
          requestChecks: null,
        },
      };
    },
  );
  if (prepared.kind === 'final-result') return prepared.result;

  try {
    const requested = await executeReservedVerifierRequestedChecks({
      paths: options.paths,
      reservation: prepared.reservation,
    });
    return {
      state: prepared.state,
      response: prepared.response,
      checks: requested.checks,
      requestChecks: requested.requestChecks,
    };
  } catch (error) {
    const summary = `Loop Verifier response was invalid: ${(error as Error).message}`;
    const failed = await withLoopMutationLock(
      options.paths,
      `record Verifier-requested check failure ${options.name}`,
      async () => {
        const current = await readLoopPortableChange(options.paths, options.name);
        if (current.state_version !== prepared.state.state_version) return null;
        return persistVerifierExecutionError({
          paths: options.paths,
          state: current,
          summary,
        });
      },
    );
    throw new Error(
      failed
        ? `${summary}; execution error ${failed.loop.execution_failure_count}/${LOOP_MAX_VERIFIER_EXECUTION_FAILURES} was recorded`
        : `${summary}; the portable state changed before the execution error could be recorded`,
      { cause: error },
    );
  }
}

export async function recordLoopPortableVerifierFailure(options: {
  paths: LoopProjectPaths;
  name: string;
  summary: string;
  expected: LoopVerifierAttemptBinding;
  requireSkillCoordination?: boolean;
}): Promise<LoopPortableState> {
  return withLoopMutationLock(
    options.paths,
    `record portable verifier failure ${options.name}`,
    async () => {
      const state = await readLoopPortableChange(options.paths, options.name);
      const local = await readCurrentLocalExecution({ paths: options.paths, state });
      assertCurrentVerifierAttempt({ state, local, expected: options.expected });
      if (
        options.requireSkillCoordination &&
        state.builder_handoff?.identity_provider !== 'skill-coordinated'
      ) {
        throw new Error('Loop Skill coordination has no current generic Builder candidate');
      }
      return persistVerifierExecutionError({
        paths: options.paths,
        state,
        summary: options.summary,
      });
    },
  );
}

export async function recordLoopPortableVerifierUnavailable(options: {
  paths: LoopProjectPaths;
  name: string;
  summary: string;
  expected: LoopVerifierAttemptBinding;
  requireSkillCoordination?: boolean;
}): Promise<LoopPortableState> {
  return withLoopMutationLock(
    options.paths,
    `record unavailable portable verifier ${options.name}`,
    async () => {
      const state = await readLoopPortableChange(options.paths, options.name);
      await ensureLoopPortableAcceptanceCurrentLocked({ paths: options.paths, state });
      const local = await readCurrentLocalExecution({ paths: options.paths, state });
      const activeLocal = assertCurrentVerifierAttempt({
        state,
        local,
        expected: options.expected,
      });
      if (
        options.requireSkillCoordination &&
        state.builder_handoff?.identity_provider !== 'skill-coordinated'
      ) {
        throw new Error('Loop Skill coordination has no current generic Builder candidate');
      }
      const checks = authoritativePortableChecks({
        local: activeLocal,
        projectRoot: options.paths.projectRoot,
        supplied: [],
      });
      const next = recordLoopVerifierUnavailable({
        state,
        checks,
        verifierExecutionRef: activeLocal.execution!.executionId!,
        summary: options.summary,
      });
      const written = await writePortableMutation({ paths: options.paths, previous: state, next });
      await writeLoopLocalExecution(
        loopLocalExecutionFile(options.paths, state.name),
        preservedLocalChecksForVersion({
          local: activeLocal,
          state: written,
          projectRoot: options.paths.projectRoot,
        }),
        { containedRoot: options.paths.runtimeDir },
      );
      await writeLoopVerificationReport({
        file: path.join(loopPortableChangeDir(options.paths, state.name), 'verification.md'),
        state: written,
      });
      return written;
    },
  );
}

export async function confirmLoopPortableSkillCoordinatedPass(options: {
  paths: LoopProjectPaths;
  name: string;
}): Promise<LoopPortableState> {
  return withLoopMutationLock(
    options.paths,
    `confirm portable Skill-coordinated pass ${options.name}`,
    async () => {
      const state = await readLoopPortableChange(options.paths, options.name);
      await ensureLoopPortableAcceptanceCurrentLocked({ paths: options.paths, state });
      const next = confirmLoopSkillCoordinatedPass(state);
      const written = await writePortableMutation({ paths: options.paths, previous: state, next });
      await writeLoopLocalExecution(
        loopLocalExecutionFile(options.paths, state.name),
        rebuildLoopLocalExecution({
          portableState: written,
          projectRoot: options.paths.projectRoot,
          branch: currentBranch(options.paths.projectRoot),
        }),
        { containedRoot: options.paths.runtimeDir },
      );
      await writeLoopVerificationReport({
        file: path.join(loopPortableChangeDir(options.paths, state.name), 'verification.md'),
        state: written,
      });
      return written;
    },
  );
}

export async function confirmLoopPortableVerifierUnavailable(options: {
  paths: LoopProjectPaths;
  name: string;
  summary: string;
}): Promise<LoopPortableState> {
  return withLoopMutationLock(
    options.paths,
    `confirm unavailable portable verifier ${options.name}`,
    async () => {
      const state = await readLoopPortableChange(options.paths, options.name);
      await ensureLoopPortableAcceptanceCurrentLocked({ paths: options.paths, state });
      const next = confirmLoopVerifierUnavailable({ state, summary: options.summary });
      const written = await writePortableMutation({ paths: options.paths, previous: state, next });
      await writeLoopLocalExecution(
        loopLocalExecutionFile(options.paths, state.name),
        rebuildLoopLocalExecution({
          portableState: written,
          projectRoot: options.paths.projectRoot,
          branch: currentBranch(options.paths.projectRoot),
        }),
        { containedRoot: options.paths.runtimeDir },
      );
      await writeLoopVerificationReport({
        file: path.join(loopPortableChangeDir(options.paths, state.name), 'verification.md'),
        state: written,
      });
      return written;
    },
  );
}

export async function resolveLoopPortableVerifierBlocker(options: {
  paths: LoopProjectPaths;
  name: string;
}): Promise<LoopPortableState> {
  return withLoopMutationLock(
    options.paths,
    `resolve portable verifier blocker ${options.name}`,
    async () => {
      const state = await readLoopPortableChange(options.paths, options.name);
      await ensureLoopPortableAcceptanceCurrentLocked({ paths: options.paths, state });
      const local = await readCurrentLocalExecution({ paths: options.paths, state });
      const next = resolveLoopVerifierBlocker(state);
      const written = await writePortableMutation({ paths: options.paths, previous: state, next });
      await writeLoopLocalExecution(
        loopLocalExecutionFile(options.paths, state.name),
        preservedLocalChecksForVersion({
          local,
          state: written,
          projectRoot: options.paths.projectRoot,
        }),
        { containedRoot: options.paths.runtimeDir },
      );
      return written;
    },
  );
}

export async function retryLoopPortableVerifier(options: {
  paths: LoopProjectPaths;
  name: string;
}): Promise<LoopPortableState> {
  return withLoopMutationLock(
    options.paths,
    `retry portable verifier ${options.name}`,
    async () => {
      const state = await readLoopPortableChange(options.paths, options.name);
      const local = await readCurrentLocalExecution({ paths: options.paths, state });
      const next = retryLoopVerifier(state);
      const written = await writePortableMutation({ paths: options.paths, previous: state, next });
      await writeLoopLocalExecution(
        loopLocalExecutionFile(options.paths, state.name),
        preservedLocalChecksForVersion({
          local,
          state: written,
          projectRoot: options.paths.projectRoot,
        }),
        { containedRoot: options.paths.runtimeDir },
      );
      return written;
    },
  );
}

export async function returnLoopPortableChangeToBuild(options: {
  paths: LoopProjectPaths;
  name: string;
  reason: string;
}): Promise<LoopPortableState> {
  return withLoopMutationLock(
    options.paths,
    `return portable change ${options.name} to Build`,
    async () => {
      const state = await readLoopPortableChange(options.paths, options.name);
      if (state.phase === 'build') return state;
      const next = returnLoopCandidateToBuild({ state, reason: options.reason });
      const written = await writePortableMutation({ paths: options.paths, previous: state, next });
      await writeLoopLocalExecution(
        loopLocalExecutionFile(options.paths, state.name),
        rebuildLoopLocalExecution({
          portableState: written,
          projectRoot: options.paths.projectRoot,
          branch: currentBranch(options.paths.projectRoot),
        }),
        { containedRoot: options.paths.runtimeDir },
      );
      return written;
    },
  );
}

export async function markLoopPortableSpecRemoval(options: {
  paths: LoopProjectPaths;
  name: string;
  capability: string;
}): Promise<LoopPortableState> {
  if (!NAME_PATTERN.test(options.capability)) {
    throw new Error(`Invalid Loop capability: ${options.capability}`);
  }
  return withLoopMutationLock(
    options.paths,
    `remove portable spec ${options.capability}`,
    async () => {
      const state = await readLoopPortableChange(options.paths, options.name);
      if (state.archived) throw new Error(`Loop change ${state.name} is already archived`);
      const existing = state.spec_changes.filter(
        ({ capability }) => capability !== options.capability,
      );
      const next: LoopPortableState = {
        ...state,
        phase: 'shape',
        status: 'active',
        state_version: state.state_version + 1,
        spec_changes: [
          ...existing,
          { capability: options.capability, operation: 'remove', source: null } as const,
        ].sort((left, right) => left.capability.localeCompare(right.capability, 'en')),
        acceptance: [],
        builder_handoff: null,
        blockers: [],
        verification: null,
        verification_result: 'pending',
        verification_report: null,
        history: [],
        history_overflow: {
          dropped_entries: 0,
          first_dropped_at: null,
          last_dropped_at: null,
          outcome_counts: {
            pass: 0,
            fail: 0,
            blocked: 0,
            'execution-error': 0,
            recovery: 0,
          },
        },
        loop: {
          stage: 'shape',
          goal_cycle: state.loop.goal_cycle + (state.phase === 'shape' ? 0 : 1),
          iteration: 0,
          attempt: 0,
          retry_epoch: 0,
          failed_iteration_count: 0,
          no_progress_count: 0,
          execution_failure_count: 0,
          previous_unresolved_ids: [],
          next_action: 'confirm-shape',
        },
      };
      delete next.children_contract_hash;
      const written = await writePortableMutation({ paths: options.paths, previous: state, next });
      await writeLoopLocalExecution(
        loopLocalExecutionFile(options.paths, state.name),
        rebuildLoopLocalExecution({
          portableState: written,
          projectRoot: options.paths.projectRoot,
          branch: currentBranch(options.paths.projectRoot),
        }),
        { containedRoot: options.paths.runtimeDir },
      );
      return written;
    },
  );
}

export async function setLoopPortableWorkspaceFinish(options: {
  paths: LoopProjectPaths;
  name: string;
  finish: NonNullable<LoopPortableWorkspace['finish']>;
}): Promise<LoopPortableState> {
  return withLoopMutationLock(
    options.paths,
    `set portable workspace finish ${options.name}`,
    async () => {
      const state = await readLoopPortableChange(options.paths, options.name);
      if (state.workspace.isolation === 'current') {
        throw new Error('Loop current-workspace isolation does not accept a finish action');
      }
      const next: LoopPortableState = {
        ...state,
        state_version: state.state_version + 1,
        workspace: { ...state.workspace, finish: options.finish },
      };
      const written = await writePortableMutation({ paths: options.paths, previous: state, next });
      await writeLoopLocalExecution(
        loopLocalExecutionFile(options.paths, state.name),
        rebuildLoopLocalExecution({
          portableState: written,
          projectRoot: options.paths.projectRoot,
          branch: currentBranch(options.paths.projectRoot),
        }),
        { containedRoot: options.paths.runtimeDir },
      );
      if (written.verification !== null) {
        await writeLoopVerificationReport({
          file: path.join(loopPortableChangeDir(options.paths, state.name), 'verification.md'),
          state: written,
        });
      }
      return written;
    },
  );
}

export async function returnLoopPortableChangeToShape(options: {
  paths: LoopProjectPaths;
  name: string;
  reason: string;
}): Promise<LoopPortableState> {
  return withLoopMutationLock(
    options.paths,
    `return portable change ${options.name} to Shape`,
    async () => {
      const state = await readLoopPortableChange(options.paths, options.name);
      if (state.phase === 'shape') return state;
      return returnLoopPortableStateToShapeLocked({
        paths: options.paths,
        state,
        reason: options.reason,
      });
    },
  );
}

export async function returnLoopPortableStateToShapeLocked(options: {
  paths: LoopProjectPaths;
  state: LoopPortableState;
  reason: string;
}): Promise<LoopPortableState> {
  const { state } = options;
  if (state.archived) throw new Error(`Loop change ${state.name} is already archived`);
  const withHistory = appendLoopPortableHistory(state, {
    goal_cycle: state.loop.goal_cycle,
    iteration: state.loop.iteration,
    attempt: state.loop.attempt,
    outcome: 'recovery',
    unresolved_ids: [],
    summary: toLoopPortableText(options.reason),
    completed_at: new Date().toISOString(),
  });
  const next: LoopPortableState = {
    ...withHistory,
    phase: 'shape',
    status: 'active',
    state_version: state.state_version + 1,
    acceptance: [],
    builder_handoff: null,
    blockers: [],
    verification: null,
    verification_result: 'pending',
    verification_report: null,
    loop: {
      stage: 'shape',
      goal_cycle: state.loop.goal_cycle + 1,
      iteration: 0,
      attempt: 0,
      retry_epoch: 0,
      failed_iteration_count: 0,
      no_progress_count: 0,
      execution_failure_count: 0,
      previous_unresolved_ids: [],
      next_action: 'confirm-shape',
    },
  };
  delete next.children_contract_hash;
  const written = await writePortableMutation({ paths: options.paths, previous: state, next });
  await writeLoopLocalExecution(
    loopLocalExecutionFile(options.paths, state.name),
    rebuildLoopLocalExecution({
      portableState: written,
      projectRoot: options.paths.projectRoot,
      branch: currentBranch(options.paths.projectRoot),
    }),
    { containedRoot: options.paths.runtimeDir },
  );
  return written;
}

export async function ensureLoopPortableReport(options: {
  paths: LoopProjectPaths;
  state: LoopPortableState;
}): Promise<'aligned' | 'rebuilt' | 'not-applicable'> {
  if (options.state.verification === null) return 'not-applicable';
  const file = path.join(
    loopPortableChangeDir(options.paths, options.state.name),
    'verification.md',
  );
  const alignment = await inspectLoopVerificationReportAlignment({
    file,
    stateVersion: options.state.state_version,
  });
  if (alignment === 'aligned') return 'aligned';
  await writeLoopVerificationReport({ file, state: options.state });
  return 'rebuilt';
}

export async function readLoopPortableRuntime(options: {
  paths: LoopProjectPaths;
  name: string;
}): Promise<{
  state: LoopPortableState;
  local: LoopLocalExecutionState | null;
  localStatus: 'available' | 'missing' | 'invalid' | 'stale';
}> {
  const state = await readLoopPortableChange(options.paths, options.name);
  const file = loopLocalExecutionFile(options.paths, options.name);
  try {
    const local = await readLoopLocalExecution(file);
    if (local === null) return { state, local: null, localStatus: 'missing' };
    if (local.change !== state.name || local.basedOnStateVersion !== state.state_version) {
      return { state, local: null, localStatus: 'stale' };
    }
    return { state, local, localStatus: 'available' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { state, local: null, localStatus: 'missing' };
    }
    return { state, local: null, localStatus: 'invalid' };
  }
}
