import { spawnSync } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { Document, parseDocument } from 'yaml';
import type { PipelineCommandHandler, PipelineCommandResult } from './pipeline-cli.js';
import {
  clearCurrentChange,
  resolveCurrentChange,
  selectCurrentChange,
} from './pipeline-current-change.js';
import {
  driftBlockedMessage,
  evaluateBranchBinding,
  healBoundBranch,
  isGitWorkTree,
  liveGitBranch,
  requiresBranchBinding,
  resolveBranchBinding,
  unboundDetachedMessage,
} from './pipeline-branch-binding.js';
import { collectPipelineEvidence } from './pipeline-evidence.js';
import {
  ensurePipelineActiveChangeDirectory,
  openSpecChangeNameError,
  resolvePipelineChangeDirectory,
} from './pipeline-paths.js';
import { assertPipelineLayoutWritable, assertPipelineLayoutReadable } from './pipeline-layout.js';
import {
  pipelineCommandInvocationCwd,
  pipelineCommandProjectRoot,
  withPipelineCommandContext,
} from './pipeline-command-context.js';
import { resolvePipelineStepId } from './pipeline-resolver.js';
import {
  transitionPipelineRuntimeRun,
  validatePipelineRuntimeRun,
} from './pipeline-runtime-run.js';
import { appendPipelineStateEvent } from './pipeline-state-events.js';
import {
  PIPELINE_WIRE_KEYS,
  RUN_WIRE_KEYS,
  parsePipelineStateDocument,
  type PipelineState,
} from './pipeline-state.js';
import { readPipelineState, writePipelineState } from './pipeline-store.js';
import {
  PIPELINE_TRANSITION_EVENTS,
  applyPipelineTransition,
  type PipelineTransitionEvent,
} from './pipeline-transitions.js';
import { readRunState } from '../../domains/engine/state.js';
import { appendTrajectory, readTrajectory } from '../../domains/engine/run-store.js';
import { recordCommandCheck, type CommandCheckScope } from './pipeline-command-checks.js';
import { readPipelineConfigValue } from './pipeline-project-config.js';
import {
  pipelineProjectFileNonempty,
  pipelineProjectTargetExists,
  inspectPipelineProjectTarget,
  readPipelineProjectFile,
  writePipelineProjectText,
} from './pipeline-protected-path.js';
import {
  inspectPipelinePlanReadiness,
  type PipelinePlanReadiness,
} from './pipeline-plan-readiness.js';
import { resolvePipelineWorkspace } from './pipeline-workspace.js';

const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const YELLOW = '\u001b[33m';
const RESET = '\u001b[0m';
const PROFILES = ['full', 'hotfix', 'tweak'] as const;
const PHASES = ['open', 'design', 'build', 'verify', 'archive'] as const;
const ARTIFACT_LANGUAGES = ['en', 'zh-CN'] as const;
const EVENTS = PIPELINE_TRANSITION_EVENTS;
const MACHINE_OWNED_FIELDS = new Set<string>([
  ...RUN_WIRE_KEYS,
  'archive_confirmation',
  'verify_failures',
  'pipeline_profile',
  'pipeline_migration',
  'bound_branch',
]);
const SETTABLE_FIELDS = new Set<string>(
  PIPELINE_WIRE_KEYS.filter((field) => !MACHINE_OWNED_FIELDS.has(field)),
);

const FIELD_ENUMS: Record<string, readonly string[]> = {
  workflow: PROFILES,
  phase: PHASES,
  context_compression: ['off', 'beta'],
  build_mode: ['subagent-driven-development', 'executing-plans', 'direct'],
  build_pause: ['null', 'plan-ready'],
  subagent_dispatch: ['null', 'confirmed'],
  tdd_mode: ['tdd', 'direct'],
  review_mode: ['off', 'standard', 'thorough'],
  isolation: ['current', 'branch', 'worktree'],
  verify_mode: ['light', 'full'],
  auto_transition: ['true', 'false'],
  verify_result: ['pending', 'pass', 'fail'],
  branch_status: ['pending', 'handled'],
  archive_confirmation: ['pending', 'confirmed'],
  archived: ['true', 'false'],
  direct_override: ['true', 'false'],
  pipeline_profile: PROFILES,
  pipeline_migration: ['1'],
};

const PATH_FIELDS = new Set(['design_doc', 'plan', 'verification_report', 'handoff_context']);
const PIPELINE_FIELD_WIRE_NAMES: Partial<Record<keyof PipelineState, string>> = {
  archived: 'archived',
  branchStatus: 'branch_status',
  pipelineProfile: 'pipeline_profile',
  designDoc: 'design_doc',
  language: 'language',
  phase: 'phase',
  verificationReport: 'verification_report',
  verifiedAt: 'verified_at',
  archiveConfirmation: 'archive_confirmation',
  verifyResult: 'verify_result',
  verifyFailures: 'verify_failures',
  workflow: 'workflow',
};

class CommandFailure extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

class CommandOutput {
  stdout: string[] = [];
  stderr: string[] = [];

  result(exitCode = 0): PipelineCommandResult {
    return {
      exitCode,
      ...(this.stdout.length > 0 ? { stdout: this.stdout.join('\n') + '\n' } : {}),
      ...(this.stderr.length > 0 ? { stderr: this.stderr.join('\n') } : {}),
    };
  }
}

function green(message: string): string {
  return `${GREEN}${message}${RESET}`;
}

function red(message: string): string {
  return `${RED}${message}${RESET}`;
}

function yellow(message: string): string {
  return `${YELLOW}${message}${RESET}`;
}

function fail(message: string): never {
  throw new CommandFailure(message);
}

function validateChangeName(name: string | undefined): asserts name is string {
  const error = openSpecChangeNameError(name);
  if (error) fail(`ERROR: ${error}`);
}

function validateEnum(value: string, values: readonly string[]): void {
  if (!values.includes(value)) {
    fail(`ERROR: Invalid value: '${value}'\nValid values: ${values.join(' ')}`);
  }
}

function validateLanguage(value: string, source: string): string {
  if (ARTIFACT_LANGUAGES.includes(value as (typeof ARTIFACT_LANGUAGES)[number])) {
    return value;
  }
  fail(`ERROR: Invalid language from ${source}: '${value}'\nValid values: en, zh-CN`);
}

function validateRelativePath(value: string, field: string): void {
  if (!value || value === 'null') return;
  if (/^(?:[A-Za-z]:|[\\/]|~)/u.test(value)) {
    fail(`ERROR: ${field} must be a relative path within the repo: '${value}'`);
  }
  if (value.split(/[\\/]/u).includes('..')) {
    fail(`ERROR: ${field} cannot contain '..' (path traversal not allowed): '${value}'`);
  }
}

async function exists(file: string): Promise<boolean> {
  const projectRoot = pipelineCommandProjectRoot();
  return pipelineProjectTargetExists(projectRoot, file, {
    label: `Pipeline project path ${path.relative(projectRoot, path.resolve(projectRoot, file)).replaceAll('\\', '/')}`,
  });
}

async function nonempty(file: string): Promise<boolean> {
  const projectRoot = pipelineCommandProjectRoot();
  return pipelineProjectFileNonempty(
    projectRoot,
    file,
    `Pipeline project file ${path.relative(projectRoot, path.resolve(projectRoot, file)).replaceAll('\\', '/')}`,
  );
}

async function changeDirectory(name: string): Promise<{ label: string; directory: string }> {
  return resolvePipelineChangeDirectory(name, pipelineCommandProjectRoot());
}

async function readDocument(file: string): Promise<Document> {
  let source: string;
  const projectRoot = pipelineCommandProjectRoot();
  try {
    source = await readPipelineProjectFile(projectRoot, file, {
      label: `Pipeline state ${path.relative(projectRoot, file).replaceAll('\\', '/')}`,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      fail(
        `ERROR: .owner.yaml not found at ${path.relative(projectRoot, file).replaceAll('\\', '/')}`,
      );
    }
    throw error;
  }
  const document = parseDocument(source, { uniqueKeys: false });
  if (document.errors.length > 0) fail(`ERROR: Invalid .owner.yaml: ${document.errors[0].message}`);
  return document;
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await writePipelineProjectText(pipelineCommandProjectRoot(), file, content, {
    label: 'Pipeline state write target',
  });
}

function scalar(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function wireField(field: keyof PipelineState): string {
  return PIPELINE_FIELD_WIRE_NAMES[field] ?? String(field);
}

function wireValue(value: unknown): string {
  return value === null ? 'null' : scalar(value);
}

function enumRecordValue<const T extends readonly string[]>(
  record: Record<string, unknown>,
  field: string,
  values: T,
  fallback: T[number] | null,
): T[number] | null {
  const value = record[field];
  return typeof value === 'string' && values.includes(value as T[number])
    ? (value as T[number])
    : fallback;
}

function nullableRecordString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  if (value === null || value === undefined || value === '') return null;
  return typeof value === 'string' ? value : String(value);
}

function nullableRecordBoolean(record: Record<string, unknown>, field: string): boolean | null {
  const value = record[field];
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function nonNegativeRecordInteger(
  record: Record<string, unknown>,
  field: string,
  fallback = 0,
): number {
  const value = record[field];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function sparsePipelineState(record: Record<string, unknown>): PipelineState {
  const workflow = enumRecordValue(record, 'workflow', PROFILES, 'full')!;
  return {
    workflow,
    language: enumRecordValue(record, 'language', ARTIFACT_LANGUAGES, null),
    phase: enumRecordValue(record, 'phase', PHASES, 'open')!,
    contextCompression: enumRecordValue(
      record,
      'context_compression',
      ['off', 'beta'] as const,
      null,
    ),
    buildMode: enumRecordValue(
      record,
      'build_mode',
      ['subagent-driven-development', 'executing-plans', 'direct'] as const,
      null,
    ),
    buildPause: enumRecordValue(record, 'build_pause', ['plan-ready'] as const, null),
    subagentDispatch: enumRecordValue(record, 'subagent_dispatch', ['confirmed'] as const, null),
    tddMode: enumRecordValue(record, 'tdd_mode', ['tdd', 'direct'] as const, null),
    reviewMode: enumRecordValue(
      record,
      'review_mode',
      ['off', 'standard', 'thorough'] as const,
      null,
    ),
    isolation: enumRecordValue(
      record,
      'isolation',
      ['current', 'branch', 'worktree'] as const,
      null,
    ),
    boundBranch: nullableRecordString(record, 'bound_branch'),
    verifyMode: enumRecordValue(record, 'verify_mode', ['light', 'full'] as const, null),
    autoTransition: nullableRecordBoolean(record, 'auto_transition'),
    baseRef: nullableRecordString(record, 'base_ref'),
    designDoc: nullableRecordString(record, 'design_doc'),
    plan: nullableRecordString(record, 'plan'),
    verifyResult: enumRecordValue(
      record,
      'verify_result',
      ['pending', 'pass', 'fail'] as const,
      'pending',
    )!,
    verifyFailures: nonNegativeRecordInteger(record, 'verify_failures'),
    verificationReport: nullableRecordString(record, 'verification_report'),
    branchStatus: enumRecordValue(record, 'branch_status', ['pending', 'handled'] as const, null),
    createdAt: nullableRecordString(record, 'created_at'),
    verifiedAt: nullableRecordString(record, 'verified_at'),
    archiveConfirmation: enumRecordValue(
      record,
      'archive_confirmation',
      ['pending', 'confirmed'] as const,
      null,
    ),
    archived: nullableRecordBoolean(record, 'archived') ?? false,
    directOverride: nullableRecordBoolean(record, 'direct_override'),
    handoffContext: nullableRecordString(record, 'handoff_context'),
    handoffHash: nullableRecordString(record, 'handoff_hash'),
    pipelineProfile: enumRecordValue(record, 'pipeline_profile', PROFILES, workflow),
    pipelineMigration:
      typeof record.pipeline_migration === 'number' ? record.pipeline_migration : null,
  };
}

async function projectConfigValue(
  field: 'context_compression' | 'auto_transition' | 'review_mode' | 'language',
): Promise<string | null> {
  return (
    (await readPipelineConfigValue(field, { cwd: pipelineCommandProjectRoot() }))?.value ?? null
  );
}

async function projectLanguageDefault(): Promise<string> {
  if (process.env.OWNER_LANGUAGE)
    return validateLanguage(process.env.OWNER_LANGUAGE, 'OWNER_LANGUAGE');
  const configured = await readPipelineConfigValue('language', {
    cwd: pipelineCommandProjectRoot(),
  });
  if (configured) return validateLanguage(configured.value, configured.source);
  return 'en';
}

async function contextCompression(): Promise<string> {
  const value =
    process.env.OWNER_CONTEXT_COMPRESSION ??
    (await projectConfigValue('context_compression')) ??
    'off';
  if (!['off', 'beta'].includes(value)) {
    fail(`ERROR: Invalid context_compression: '${value}'\nValid values: off, beta`);
  }
  return value;
}

async function autoTransition(): Promise<string> {
  const value =
    process.env.OWNER_AUTO_TRANSITION ?? (await projectConfigValue('auto_transition')) ?? 'true';
  if (!['true', 'false'].includes(value)) {
    fail(`ERROR: Invalid auto_transition: '${value}'\nValid values: true, false`);
  }
  return value;
}

async function reviewModeDefault(): Promise<string | null> {
  const value =
    process.env.OWNER_REVIEW_MODE ?? (await projectConfigValue('review_mode')) ?? 'standard';
  if (!['null', 'off', 'standard', 'thorough'].includes(value)) {
    fail(`ERROR: Invalid review_mode: '${value}'\nValid values: off, standard, thorough`);
  }
  return value === 'null' ? null : value;
}

function gitOutput(args: string[]): string | null {
  const result = spawnSync('git', args, {
    cwd: pipelineCommandProjectRoot(),
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

async function stateFile(
  name: string,
): Promise<{ file: string; label: string; directory: string }> {
  const change = await changeDirectory(name);
  await inspectPipelineProjectTarget(
    pipelineCommandProjectRoot(),
    path.join(change.directory, '.owner'),
    {
      label: `Pipeline runtime directory for ${name}`,
      expected: 'directory',
    },
  );
  return {
    ...change,
    file: path.join(change.directory, '.owner.yaml'),
  };
}

async function readField(name: string, field: string): Promise<string> {
  const { file } = await stateFile(name);
  const document = await readDocument(file);
  // Read via toJS so an explicit `field: null` round-trips as JS null (-> "null"),
  // matching the shell `yaml_field` grep contract. A bare Document#get returns
  // undefined for null-valued keys, erasing the distinction between "present but
  // null" and "absent" that the frozen 0.3.8 behavior preserves.
  const record = document.toJS() as Record<string, unknown>;
  const value = record[field];
  if (field === 'language') {
    if (value === null || value === undefined || value === '') return projectLanguageDefault();
    return validateLanguage(scalar(value), '.owner.yaml');
  }
  if (field === 'auto_transition' && (value === null || value === undefined || value === '')) {
    return autoTransition();
  }
  return scalar(value);
}

function parsedValue(field: string, value: string): unknown {
  const document = parseDocument(`${field}: ${value}\n`);
  if (document.errors.length > 0) fail(`ERROR: Invalid value: '${value}'`);
  return document.get(field);
}

async function validateSetValue(field: string, value: string): Promise<void> {
  if (field === 'language') {
    validateLanguage(value, 'language');
    return;
  }
  const enumValues = FIELD_ENUMS[field];
  if (enumValues) validateEnum(value, enumValues);
  if (PATH_FIELDS.has(field)) {
    validateRelativePath(value, field);
    if (value && value !== 'null') {
      await inspectPipelineProjectTarget(pipelineCommandProjectRoot(), value, {
        label: `${field} artifact pointer`,
        expected: 'file',
      });
    }
  }
  if ((field === 'skill_hash' || field === 'handoff_hash') && !/^[a-f0-9]{64}$/u.test(value)) {
    fail(`ERROR: ${field} must be a sha256 hex digest`);
  }
  if (field === 'iteration' && !/^[0-9]+$/u.test(value)) {
    fail('ERROR: iteration must be a non-negative integer');
  }
}

async function setField(
  output: CommandOutput,
  name: string,
  field: string,
  value: string,
  options: { internal?: boolean; machineOwned?: boolean } = {},
): Promise<void> {
  if (MACHINE_OWNED_FIELDS.has(field) && !options.machineOwned) {
    fail(`ERROR: '${field}' is a machine-owned field and cannot be set directly`);
  }
  if (!SETTABLE_FIELDS.has(field) && !MACHINE_OWNED_FIELDS.has(field)) {
    fail(`ERROR: Unknown field: '${field}'`);
  }
  if (field === 'phase' && !options.internal && process.env.OWNER_FORCE_PHASE !== '1') {
    fail(
      "ERROR: Setting 'phase' directly is not allowed; it bypasses state machine evidence checks.\n" +
        '  Use: owner-state.mjs transition <change-name> <event>\n' +
        '  Repair-only escape hatch: OWNER_FORCE_PHASE=1 owner-state.mjs set <change-name> phase <value>',
    );
  }
  await validateSetValue(field, value);
  const { file, directory } = await stateFile(name);
  const document = await readDocument(file);
  const previousRecord = (document.toJS() ?? {}) as Record<string, unknown>;
  document.set(field, parsedValue(field, value));
  if (field === 'isolation') {
    if (requiresBranchBinding(value)) {
      const previousIsolation =
        typeof previousRecord.isolation === 'string' ? previousRecord.isolation : null;
      const existing = previousRecord.bound_branch;
      const alreadyBound = typeof existing === 'string' && existing !== '';
      // Switching between workspace modes is an explicit new workspace
      // decision and re-points the binding; repeating the same mode keeps
      // the sticky binding that drift checks rely on.
      if (!alreadyBound || previousIsolation !== value) {
        const invocationCwd = pipelineCommandInvocationCwd();
        const currentBranch = liveGitBranch(invocationCwd);
        const verdict = evaluateBranchBinding({
          isolation: value,
          boundBranch: null,
          currentBranch,
          gitWorkTree: currentBranch === null ? isGitWorkTree(invocationCwd) : true,
        });
        if (verdict.status === 'needs-heal') {
          document.set('bound_branch', verdict.branch);
        } else if (verdict.status === 'unbound-detached') {
          fail(
            `ERROR: cannot bind isolation=${value} while HEAD is detached; checkout a branch first`,
          );
        } else {
          document.set('bound_branch', null);
        }
      }
    } else {
      document.set('bound_branch', null);
    }
  }
  const run = await readRunState(directory);
  const projection = parsePipelineStateDocument(document.toJS() as Record<string, unknown>, run);
  if (projection.run) {
    if (!projection.pipeline) fail('ERROR: migrated Run is missing its Pipeline projection');
    const evidence = await collectPipelineEvidence(directory, projection);
    const currentStep = resolvePipelineStepId(projection.pipeline, evidence);
    const stepChanged = currentStep !== projection.run.currentStep;
    const run = {
      ...projection.run,
      currentStep,
      iteration: projection.run.iteration + (stepChanged ? 1 : 0),
      status: currentStep === 'completed' ? ('completed' as const) : ('running' as const),
    };
    await writePipelineState(directory, {
      pipeline: projection.pipeline,
      run,
      unknownKeys: projection.unknownKeys,
    });
    if (stepChanged) {
      const trajectory = await readTrajectory(directory, run.trajectoryRef);
      await appendTrajectory(directory, run.trajectoryRef, {
        sequence: trajectory.length + 1,
        timestamp: new Date().toISOString(),
        type: 'state_transitioned',
        runId: run.runId,
        data: {
          kind: 'pipeline-config',
          field,
          fromStep: projection.run.currentStep,
          toStep: currentStep,
        },
      });
    }
  } else {
    await atomicWrite(file, document.toString());
  }
  if (field === 'phase' && !options.internal) {
    output.stderr.push(
      yellow("WARNING: Setting 'phase' directly bypasses state machine constraints."),
      yellow('  Consider using: owner-state.mjs transition <change-name> <event>'),
    );
  }
  output.stderr.push(green(`[SET] ${field}=${value}`));
}

async function init(
  output: CommandOutput,
  name: string,
  workflow: string,
  isolation: string | null = null,
): Promise<void> {
  validateChangeName(name);
  validateEnum(workflow, PROFILES);
  if (isolation !== null) validateEnum(isolation, ['current', 'branch', 'worktree']);
  const boundBranch = isolation !== null ? liveGitBranch(pipelineCommandProjectRoot()) : null;
  if (isolation !== null && isolation !== 'current' && boundBranch === null) {
    fail(
      `ERROR: cannot bind isolation=${isolation} while HEAD is detached; checkout a branch first`,
    );
  }
  const change = await ensurePipelineActiveChangeDirectory(name, pipelineCommandProjectRoot());
  const { label, directory } = change;
  const file = path.join(directory, '.owner.yaml');
  if (await exists(file)) fail(`ERROR: .owner.yaml already exists at ${label}/.owner.yaml`);

  const preset = workflow !== 'full';
  const reviewMode = preset ? 'off' : await reviewModeDefault();
  const document = new Document({
    workflow,
    language: await projectLanguageDefault(),
    phase: 'open',
    context_compression: await contextCompression(),
    build_mode: preset ? 'direct' : null,
    build_pause: null,
    subagent_dispatch: null,
    tdd_mode: preset ? 'direct' : null,
    review_mode: reviewMode,
    isolation,
    verify_mode: preset ? 'light' : null,
    auto_transition: (await autoTransition()) === 'true',
    base_ref: gitOutput(['rev-parse', '--verify', 'HEAD']),
    design_doc: null,
    plan: null,
    verify_result: 'pending',
    verify_failures: 0,
    verification_report: null,
    branch_status: 'pending',
    created_at: new Date().toISOString().slice(0, 10),
    verified_at: null,
    archive_confirmation: null,
    archived: false,
  });
  if (isolation !== null) document.set('bound_branch', boundBranch);
  await atomicWrite(file, document.toString());
  output.stdout.push(green(`Initialized: ${label}/.owner.yaml (workflow=${workflow})`));
}

async function requirePhase(name: string, expected: string): Promise<void> {
  const actual = await readField(name, 'phase');
  if (actual !== expected) {
    fail(`ERROR: Cannot transition '${name}': expected phase ${expected}, got ${actual}`);
  }
}

async function requireBuildDecisions(name: string): Promise<void> {
  const workflow = await readField(name, 'workflow');
  const buildMode = await readField(name, 'build_mode');
  const isolation = await readField(name, 'isolation');
  const directOverride = await readField(name, 'direct_override');
  const subagentDispatch = await readField(name, 'subagent_dispatch');
  const tddMode = await readField(name, 'tdd_mode');
  const reviewMode = await readField(name, 'review_mode');
  const allowedIsolation = ['current', 'branch', 'worktree'];
  if (!allowedIsolation.includes(isolation)) {
    fail(
      `ERROR: Cannot transition '${name}': isolation must be current, branch, or worktree, got '${isolation || 'null'}'`,
    );
  }
  if (!['subagent-driven-development', 'executing-plans', 'direct'].includes(buildMode)) {
    fail(
      `ERROR: Cannot transition '${name}': build_mode must be selected before leaving build, got '${buildMode || 'null'}'`,
    );
  }
  if (
    buildMode === 'direct' &&
    !['hotfix', 'tweak'].includes(workflow) &&
    directOverride !== 'true'
  ) {
    fail(
      `ERROR: Cannot transition '${name}': build_mode=direct is only allowed for hotfix/tweak unless direct_override=true`,
    );
  }
  if (buildMode === 'subagent-driven-development' && subagentDispatch !== 'confirmed') {
    fail(
      `ERROR: Cannot transition '${name}': subagent_dispatch must be confirmed before using build_mode=subagent-driven-development`,
    );
  }
  if (workflow === 'full' && (!tddMode || tddMode === 'null')) {
    fail(
      `ERROR: Cannot transition '${name}': tdd_mode must be selected before leaving build (full workflow)`,
    );
  }
  if (workflow === 'full' && !['off', 'standard', 'thorough'].includes(reviewMode)) {
    fail(
      `ERROR: Cannot transition '${name}': review_mode must be selected before leaving build (full workflow); review_mode must be off, standard, or thorough, got '${reviewMode || 'null'}'`,
    );
  }
}

async function requireOpenArtifacts(name: string): Promise<void> {
  const { directory } = await stateFile(name);
  const workflow = await readField(name, 'workflow');
  for (const artifact of ['proposal.md', 'tasks.md']) {
    if (!(await nonempty(path.join(directory, artifact)))) {
      fail(
        `ERROR: Cannot transition '${name}': ${artifact} must exist and be non-empty before leaving open`,
      );
    }
  }
  if (workflow === 'full' && !(await nonempty(path.join(directory, 'design.md')))) {
    fail(
      `ERROR: Cannot transition '${name}': design.md must exist and be non-empty before leaving open`,
    );
  }
}

async function requireDesignEvidence(name: string): Promise<void> {
  const designDoc = await readField(name, 'design_doc');
  if (!designDoc || designDoc === 'null' || !(await nonempty(path.resolve(designDoc)))) {
    fail(
      `ERROR: Cannot transition '${name}': design_doc must point to an existing Design Doc before leaving design`,
    );
  }
}

async function writeSparseTransitionEffects(
  directory: string,
  effects: Array<{ field: keyof PipelineState; to: unknown }>,
): Promise<void> {
  const file = path.join(directory, '.owner.yaml');
  const document = await readDocument(file);
  for (const effect of effects) {
    const field = wireField(effect.field);
    document.set(field, parsedValue(field, wireValue(effect.to)));
  }
  await atomicWrite(file, document.toString());
}

async function applyTransitionEvent(
  output: CommandOutput,
  name: string,
  event: PipelineTransitionEvent,
): Promise<void> {
  const { directory } = await stateFile(name);
  const projection = await readPipelineState(directory);
  let pipeline = projection.pipeline;
  let sparse = false;
  if (!pipeline) {
    if (projection.run) fail('ERROR: Pipeline state projection is missing');
    const document = await readDocument(path.join(directory, '.owner.yaml'));
    pipeline = sparsePipelineState(document.toJS() as Record<string, unknown>);
    sparse = true;
  }

  const result = applyPipelineTransition(pipeline, event);
  if (projection.run) {
    await transitionPipelineRuntimeRun(directory, result.pipeline, projection.run, {
      event,
      source: 'owner-state',
    });
  } else if (sparse) {
    await writeSparseTransitionEffects(directory, result.effects);
  } else {
    await writePipelineState(directory, {
      pipeline: result.pipeline,
      run: null,
      unknownKeys: projection.unknownKeys,
    });
  }
  await appendPipelineStateEvent(directory, {
    change: name,
    event,
    source: 'owner-state',
    from: pipeline,
    to: result.pipeline,
    effects: result.effects,
  });

  for (const effect of result.effects) {
    output.stderr.push(green(`[SET] ${wireField(effect.field)}=${wireValue(effect.to)}`));
  }
  output.stderr.push(green(`[TRANSITION] ${event}`));
}

async function transition(output: CommandOutput, name: string, event: string): Promise<void> {
  validateChangeName(name);
  validateEnum(event, EVENTS);
  if (event === 'open-complete') {
    await requirePhase(name, 'open');
    await requireOpenArtifacts(name);
  } else if (event === 'design-complete') {
    await requirePhase(name, 'design');
    await requireDesignEvidence(name);
  } else if (event === 'build-complete') {
    await requirePhase(name, 'build');
    await requireBuildDecisions(name);
  } else if (event === 'verify-pass') {
    await requirePhase(name, 'verify');
    const report = await readField(name, 'verification_report');
    if (!report || !(await exists(path.resolve(report)))) {
      fail(
        `ERROR: Cannot transition '${name}': verification_report must point to an existing report file`,
      );
    }
  } else if (event === 'verify-fail') {
    await requirePhase(name, 'verify');
  } else if (event === 'archive-confirm') {
    await requirePhase(name, 'archive');
    if ((await readField(name, 'verify_result')) !== 'pass') {
      fail(`ERROR: Cannot transition '${name}': verify_result must be pass before archiving`);
    }
    if ((await readField(name, 'archived')) === 'true') {
      fail(`ERROR: Cannot transition '${name}': already archived`);
    }
  } else if (event === 'preset-escalate') {
    // preset (hotfix/tweak) → full: rewind phase to design so the agent can
    // supplement a Design Doc before continuing. Unlike verify-fail /
    // archive-reopen, this event also lifts workflow to full. pipeline_profile
    // MUST be synced alongside workflow, otherwise pipeline-resolver.ts throws
    // on the (phase=design, profile!=full) invariant — profileFor() reads
    // pipelineProfile first, which stays at the old preset value otherwise.
    await requirePhase(name, 'build');
    const workflow = await readField(name, 'workflow');
    if (!['hotfix', 'tweak'].includes(workflow)) {
      fail(
        `ERROR: Cannot transition '${name}': preset-escalate only applies to hotfix/tweak, got workflow='${workflow}'`,
      );
    }
  } else if (event === 'archive-reopen') {
    await requirePhase(name, 'archive');
    if ((await readField(name, 'archived')) === 'true') {
      fail(`ERROR: Cannot transition '${name}': already archived`);
    }
  } else {
    await requirePhase(name, 'archive');
    if ((await readField(name, 'verify_result')) !== 'pass') {
      fail(`ERROR: Cannot transition '${name}': verify_result must be pass before archiving`);
    }
    if ((await readField(name, 'archive_confirmation')) !== 'confirmed') {
      fail(
        `ERROR: Cannot transition '${name}': archive_confirmation must be confirmed before archiving`,
      );
    }
  }
  await applyTransitionEvent(output, name, event as PipelineTransitionEvent);
}

async function next(output: CommandOutput, name: string): Promise<void> {
  validateChangeName(name);
  const { file, label } = await stateFile(name);
  if (!(await exists(file))) fail(`ERROR: .owner.yaml not found at ${label}/.owner.yaml`);
  const phase = await readField(name, 'phase');
  const workflow = await readField(name, 'workflow');
  const automatic = await readField(name, 'auto_transition');
  if ((await readField(name, 'archived')) === 'true') {
    output.stdout.push('NEXT: done');
    return;
  }
  const skill =
    phase === 'open'
      ? 'owner-open'
      : phase === 'design'
        ? 'owner-design'
        : phase === 'verify'
          ? 'owner-verify'
          : phase === 'archive'
            ? 'owner-archive'
            : phase === 'build'
              ? workflow === 'hotfix'
                ? 'owner-hotfix'
                : workflow === 'tweak'
                  ? 'owner-tweak'
                  : 'owner-build'
              : null;
  if (!skill) {
    fail(`ERROR: Cannot resolve next step for '${name}': unknown phase '${phase || 'null'}'`);
  }
  output.stdout.push(`NEXT: ${automatic === 'false' ? 'manual' : 'auto'}`, `SKILL: ${skill}`);
  if (automatic === 'false') {
    output.stdout.push(`HINT: phase is '${phase}'; run /${skill} manually to continue`);
  }
}

async function taskCheckoff(
  output: CommandOutput,
  taskFile: string,
  taskText: string,
): Promise<void> {
  validateRelativePath(taskFile, 'task file');
  if (!taskText) fail('ERROR: Task text cannot be empty');
  const file = path.resolve(pipelineCommandProjectRoot(), taskFile);
  if (!(await exists(file))) fail(`ERROR: Task file not found: ${taskFile}`);
  const lines = (
    await readPipelineProjectFile(pipelineCommandProjectRoot(), file, {
      label: 'Pipeline task-checkoff file',
    })
  ).split(/\r?\n/u);
  const matches = lines.filter((line) =>
    [`- [ ] ${taskText}`, `- [x] ${taskText}`, `- [X] ${taskText}`].includes(line),
  );
  const checked = matches.filter((line) => /^- \[[xX]\] /u.test(line));
  if (matches.length !== 1) {
    fail(
      `ERROR: task text must appear exactly once in ${taskFile} (found ${matches.length}): ${taskText}`,
    );
  }
  if (checked.length !== 1) fail(`ERROR: task is not checked in ${taskFile}: ${taskText}`);
  output.stdout.push('TASK_CHECKOFF: PASS', `FILE: ${taskFile}`, `TASK: ${taskText}`);
}

async function check(output: CommandOutput, name: string, phase: string): Promise<void> {
  validateChangeName(name);
  validateEnum(phase, PHASES);
  const { file, directory, label } = await stateFile(name);
  output.stdout.push(`=== Entry Check: owner-${phase} ===`);
  if (!(await exists(file))) fail(`ERROR: .owner.yaml not found at ${label}/.owner.yaml`);
  let blocked = false;
  const pass = (message: string) => output.stdout.push(`  ${green('[PASS]')} ${message}`);
  const reject = (message: string) => {
    output.stdout.push(`  ${red('[FAIL]')} ${message}`);
    blocked = true;
  };
  const expectField = async (field: string, expected: string) => {
    const actual = await readField(name, field);
    (actual === expected ? pass : reject)(`${field}=${actual} (expected: ${expected})`);
  };
  pass('.owner.yaml exists');
  await expectField('phase', phase);
  if (phase === 'design') {
    await expectField('workflow', 'full');
    const designDoc = await readField(name, 'design_doc');
    (!designDoc || designDoc === 'null' ? pass : reject)(
      designDoc ? `design_doc=${designDoc} (expected: empty/null)` : 'design_doc is empty/null',
    );
    for (const artifact of ['proposal.md', 'design.md', 'tasks.md']) {
      ((await nonempty(path.join(directory, artifact))) ? pass : reject)(
        `${artifact} ${(await nonempty(path.join(directory, artifact))) ? 'non-empty' : 'missing or empty'}`,
      );
    }
  } else if (phase === 'build') {
    const workflow = await readField(name, 'workflow');
    const designDoc = await readField(name, 'design_doc');
    if (workflow === 'full') {
      (designDoc && designDoc !== 'null' && (await exists(path.resolve(designDoc)))
        ? pass
        : reject)(`design_doc=${designDoc} (expected: non-null and file exists)`);
    } else {
      pass(`workflow=${workflow} (design_doc not required)`);
    }
    for (const artifact of ['proposal.md', 'tasks.md']) {
      ((await nonempty(path.join(directory, artifact))) ? pass : reject)(
        `${artifact} ${(await nonempty(path.join(directory, artifact))) ? 'non-empty' : 'missing or empty'}`,
      );
    }
  } else if (phase === 'verify') {
    const value = await readField(name, 'verify_result');
    (['', 'null', 'pending'].includes(value) ? pass : reject)(
      `verify_result=${value} (expected: pending or null)`,
    );
  } else if (phase === 'archive') {
    await expectField('verify_result', 'pass');
    const archived = await readField(name, 'archived');
    (archived !== 'true' ? pass : reject)(`archived=${archived} (expected: not true)`);
  }
  const binding = await resolveBranchBinding(directory, {
    heal: true,
    cwd: pipelineCommandInvocationCwd(),
  });
  if (binding.bindingRequired) {
    switch (binding.status) {
      case 'drift':
        reject(driftBlockedMessage(name, binding.boundBranch, binding.currentBranch));
        break;
      case 'unbound-detached':
        reject(unboundDetachedMessage(name));
        break;
      case 'healed':
        pass(`bound_branch lazily set to ${binding.branch}`);
        break;
      case 'needs-heal':
      case 'ok':
      case 'not-applicable':
        pass('bound_branch matches current branch');
        break;
      default: {
        const exhaustive: never = binding;
        throw new Error(`unhandled branch binding status: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
  output.stdout.push('');
  if (blocked) {
    output.stderr.push(red('BLOCKED — fix failing checks before proceeding'));
    throw new CommandFailure('', 1);
  }
  output.stderr.push(green('ALL CHECKS PASSED — ready to proceed'));
}

async function fieldStatus(field: string, value: string, file?: string): Promise<string> {
  if (!value || value === 'null') return `  - ${field}: PENDING`;
  if (file && !(await exists(path.resolve(file)))) {
    return `  - ${field}: BROKEN (path ${value} does not exist)`;
  }
  return `  - ${field}: DONE (${value})`;
}

async function recoverOpen(output: CommandOutput, directory: string): Promise<void> {
  output.stdout.push('  Artifacts:');
  let complete = 0;
  for (const artifact of ['proposal.md', 'design.md', 'tasks.md']) {
    const done = await nonempty(path.join(directory, artifact));
    if (done) complete += 1;
    output.stdout.push(`  - ${artifact}: ${done ? 'DONE' : 'PENDING'}`);
  }
  output.stdout.push(
    '',
    complete === 3
      ? 'Recovery action: All artifacts complete. Run /owner-open user confirmation, then guard to transition.'
      : complete === 0
        ? 'Recovery action: No artifacts created yet. Start from /owner-open Step 1 (explore and clarify).'
        : 'Recovery action: Some artifacts incomplete. Resume /owner-open from the first missing artifact.',
  );
}

async function recoverDesign(
  output: CommandOutput,
  name: string,
  directory: string,
): Promise<void> {
  output.stdout.push('  Artifacts:');
  for (const artifact of ['proposal.md', 'design.md', 'tasks.md']) {
    output.stdout.push(
      `  - ${artifact}: ${(await nonempty(path.join(directory, artifact))) ? 'DONE' : 'MISSING (unexpected in design phase)'}`,
    );
  }
  const handoff = await readField(name, 'handoff_context');
  const hash = await readField(name, 'handoff_hash');
  const design = await readField(name, 'design_doc');
  output.stdout.push(
    '',
    '  Design progress:',
    await fieldStatus('handoff_context', handoff, handoff),
    await fieldStatus('handoff_hash', hash),
    await fieldStatus('design_doc', design, design),
    '',
  );
  if (design && design !== 'null' && (await exists(path.resolve(design)))) {
    output.stdout.push(
      'Recovery action: Design Doc already created and linked. Run guard to transition to build.',
    );
  } else if (handoff && handoff !== 'null' && (await exists(path.resolve(handoff)))) {
    output.stdout.push(
      'Recovery action: Handoff generated but Design Doc not yet created. Resume from brainstorming confirmation (Step 1c).',
    );
  } else {
    output.stdout.push(
      'Recovery action: No handoff generated yet. Start from Step 1a (generate handoff package).',
    );
  }
}

async function recoverBuild(
  output: CommandOutput,
  name: string,
  directory: string,
  workflow: string,
): Promise<void> {
  const isolation = await readField(name, 'isolation');
  const buildMode = await readField(name, 'build_mode');
  const pause = await readField(name, 'build_pause');
  const subagentDispatch = await readField(name, 'subagent_dispatch');
  const tdd = await readField(name, 'tdd_mode');
  const review = await readField(name, 'review_mode');
  const plan = await readField(name, 'plan');
  const planReadiness = await inspectPipelinePlanReadiness(pipelineCommandProjectRoot(), plan);
  const decisions = [
    '  Build decisions:',
    await fieldStatus('isolation', isolation),
    await fieldStatus('build_mode', buildMode),
    await fieldStatus('build_pause', pause),
    await fieldStatus('tdd_mode', tdd),
    await fieldStatus('review_mode', review),
  ];
  if (
    buildMode === 'subagent-driven-development' ||
    (subagentDispatch && subagentDispatch !== 'null')
  ) {
    decisions.push(await fieldStatus('subagent_dispatch', subagentDispatch));
  }
  output.stdout.push(...decisions, '', '  Plan:', await fieldStatus('plan', plan, plan), '');
  const tasks = path.join(directory, 'tasks.md');
  if (!(await exists(tasks))) {
    output.stdout.push(
      '  Tasks: tasks.md MISSING',
      '',
      'Recovery action: tasks.md missing. Verify change directory integrity.',
    );
    return;
  }
  const lines = (
    await readPipelineProjectFile(pipelineCommandProjectRoot(), tasks, {
      label: 'Pipeline change tasks',
    })
  ).split(/\r?\n/u);
  const total = lines.filter((line) => /^\s*- \[[ xX]\] /u.test(line)).length;
  const done = lines.filter((line) => /^\s*- \[[xX]\] /u.test(line)).length;
  const pending = total - done;
  let planTotal = 0;
  let planDone = 0;
  if (planReadiness.status === 'ready') {
    const planLines = (
      await readPipelineProjectFile(pipelineCommandProjectRoot(), plan, {
        label: 'Pipeline build plan',
      })
    ).split(/\r?\n/u);
    planTotal = planLines.filter((line) => /^\s*- \[[ xX]\] /u.test(line)).length;
    planDone = planLines.filter((line) => /^\s*- \[[xX]\] /u.test(line)).length;
  }
  const planPending = planTotal - planDone;
  output.stdout.push(`  Tasks: ${done}/${total} done, ${pending} pending`);
  if (planTotal > 0) {
    output.stdout.push(`  Plan tasks: ${planDone}/${planTotal} done, ${planPending} pending`);
  }
  output.stdout.push('');

  const action = resolveBuildRecoveryAction(
    name,
    path.relative(pipelineCommandProjectRoot(), directory).replaceAll('\\', '/'),
    workflow,
    isolation,
    buildMode,
    pause,
    subagentDispatch,
    tdd,
    review,
    planReadiness,
    pending,
    planPending,
  );
  output.stdout.push(action);
}

function isMissingStateValue(value: string): boolean {
  return !value || value === 'null';
}

function resolveBuildRecoveryAction(
  name: string,
  changeDirectory: string,
  workflow: string,
  isolation: string,
  buildMode: string,
  pause: string,
  subagentDispatch: string,
  tdd: string,
  review: string,
  planReadiness: PipelinePlanReadiness,
  pending: number,
  planPending: number,
): string {
  const planReady = planReadiness.status === 'ready';
  const missingWorkflowChoices =
    workflow === 'full' && (isMissingStateValue(tdd) || isMissingStateValue(review));
  if (
    pause === 'plan-ready' &&
    planReady &&
    (isMissingStateValue(isolation) || isMissingStateValue(buildMode) || missingWorkflowChoices)
  ) {
    return workflow === 'full'
      ? 'Recovery action: Plan-ready pause detected. Ask the user whether to continue, then choose isolation, build mode, TDD mode, and review mode without regenerating the plan.'
      : 'Recovery action: Plan-ready pause detected. Ask the user whether to continue, then choose isolation and build mode without regenerating the plan.';
  }
  if (workflow === 'full' && !planReady) {
    return buildPlanRecoveryAction(name, changeDirectory, planReadiness);
  }
  if (pause === 'plan-ready') {
    if (buildMode === 'subagent-driven-development' && (pending > 0 || planPending > 0)) {
      return subagentDispatch === 'confirmed'
        ? 'Recovery action: Plan-ready pause is stale because build decisions are already selected. Clear build_pause to null, then inspect the first unchecked task (OpenSpec or plan additions) against recent git history/diff. If implemented, check it off; otherwise dispatch a subagent. Do not execute the pending task directly in the main window.'
        : 'Recovery action: Plan-ready pause is stale and selected subagent execution is not recorded. Run owner state set <change-name> subagent_dispatch confirmed, then continue from the first unchecked task through subagent execution.';
    }
    if (pending > 0 || planPending > 0) {
      return 'Recovery action: Plan-ready pause is stale because build decisions are already selected. Clear build_pause to null, then continue from the first unchecked task.';
    }
    return 'Recovery action: Plan-ready pause is stale and all tasks are done. Clear build_pause to null, then run guard to transition to verify.';
  }
  if (isMissingStateValue(isolation)) {
    return "Recovery action: Isolation not selected. Use the current platform's user confirmation mechanism to ask user for branch/worktree choice.";
  }
  if (isMissingStateValue(buildMode)) {
    return "Recovery action: Build mode not selected. Use the current platform's user confirmation mechanism to ask user for execution method.";
  }
  if (workflow === 'full' && isMissingStateValue(tdd)) {
    return "Recovery action: TDD mode not selected. Use the current platform's user confirmation mechanism to ask user for tdd or direct.";
  }
  if (workflow === 'full' && isMissingStateValue(review)) {
    return "Recovery action: Review mode not selected. Use the current platform's user confirmation mechanism to ask user for off, standard, or thorough.";
  }
  if (pending > 0) {
    if (buildMode === 'subagent-driven-development') {
      return subagentDispatch === 'confirmed'
        ? 'Recovery action: Read tasks.md and the Superpowers plan (which may include additions beyond OpenSpec), then inspect the first unchecked task against recent git history/diff. If implemented, check it off; otherwise dispatch a subagent. Do not execute the pending task directly in the main window.'
        : 'Recovery action: Selected subagent execution is not recorded. Run owner state set <change-name> subagent_dispatch confirmed, then continue from the first unchecked task through subagent execution.';
    }
    return 'Recovery action: Read tasks.md and continue from first unchecked task.';
  }
  if (planPending > 0) {
    if (buildMode === 'subagent-driven-development') {
      return subagentDispatch === 'confirmed'
        ? 'Recovery action: Read the Superpowers plan, then inspect the first unchecked Superpowers plan task against recent git history/diff. If implemented, check it off; otherwise dispatch a subagent. Do not execute the pending task directly in the main window.'
        : 'Recovery action: Selected subagent execution is not recorded. Run owner state set <change-name> subagent_dispatch confirmed, then continue from the first unchecked task through subagent execution.';
    }
    return 'Recovery action: Read the Superpowers plan and continue from the first unchecked plan task.';
  }
  return 'Recovery action: All tasks done. Run guard to transition to verify.';
}

function buildPlanRecoveryAction(
  name: string,
  changeDirectory: string,
  planReadiness: Exclude<PipelinePlanReadiness, { status: 'ready' }>,
): string {
  const missing = planReadiness.status === 'missing';
  const errorCode = missing ? 'pipeline-build-plan-missing' : 'pipeline-build-plan-broken';
  const state = missing
    ? 'plan is not recorded'
    : 'the recorded plan path does not resolve to a file';
  const recorded = missing ? [] : [`RECORDED_PLAN: ${planReadiness.recordedPath}`];
  const createCommand = missing
    ? `owner state set ${name} plan <repository-relative-plan-path>`
    : `owner state set ${name} plan <new-repository-relative-plan-path>`;
  const repair = missing
    ? [
        '2. Load the Superpowers writing-plans Skill.',
        `3. Read the Design Doc path from "owner state get ${name} design_doc" and read ${changeDirectory}/tasks.md.`,
        '4. Create the implementation plan under docs/superpowers/plans/.',
        '5. Record the plan path:',
        `   ${createCommand}`,
      ]
    : [
        `2. Restore the plan file at ${planReadiness.recordedPath}, or load the Superpowers writing-plans Skill and create a replacement under docs/superpowers/plans/.`,
        '3. When creating a replacement, record its path:',
        `   ${createCommand}`,
      ];

  return [
    'OWNER_RECOVERY: required',
    `ERROR_CODE: ${errorCode}`,
    `CHANGE: ${name}`,
    'WORKFLOW: full',
    'PHASE: build',
    `STATE: ${state}`,
    ...recorded,
    '',
    'ALLOWED_RECOVERY_WRITES:',
    '- docs/superpowers/plans/<plan-file>.md',
    '- Owner state updates performed by the owner CLI',
    `- ${changeDirectory} artifacts allowed by the build phase`,
    '',
    'RECOVERY:',
    `1. Resume /owner-build for ${name} and return to Step 1.`,
    ...repair,
    `${missing ? '6' : '4'}. Verify recovery:`,
    `   owner state check ${name} build --recover`,
    '',
    'SUCCESS: plan is reported as DONE and recovery no longer returns pipeline-build-plan-missing or pipeline-build-plan-broken.',
    'RETRY: resume build configuration or retry the blocked Write/Edit only after SUCCESS.',
    'PROHIBITED: do not execute tasks.md or write project source before SUCCESS; tasks.md is not a substitute for the implementation plan.',
    'If writing-plans is unavailable, stop and report the missing Skill instead of bypassing this recovery.',
  ].join('\n');
}

async function recoverVerify(output: CommandOutput, name: string): Promise<void> {
  const result = await readField(name, 'verify_result');
  const failures = await readField(name, 'verify_failures');
  const mode = await readField(name, 'verify_mode');
  const report = await readField(name, 'verification_report');
  const branch = await readField(name, 'branch_status');
  output.stdout.push(
    '  Verification:',
    await fieldStatus('verify_result', result),
    `  - verify_failures: ${failures || '0'}`,
    await fieldStatus('verify_mode', mode),
    await fieldStatus('verification_report', report, report),
    branch === 'handled'
      ? '  - branch_status: LEGACY (handled before archive; archive still owns final closure)'
      : '  - branch_status: DEFERRED (handled after the archive commit)',
    '',
    result === 'pass'
      ? 'Recovery action: Verification complete. Continue to archive; branch handling happens after archive changes are committed.'
      : result === 'fail'
        ? 'Recovery action: Verification failed and rolled back to build. Resume from /owner-build.'
        : 'Recovery action: Verification not yet started or in progress. Run scale assessment then verify.',
  );
}

async function recoverArchive(output: CommandOutput, name: string): Promise<void> {
  const archiveConfirmation = await readField(name, 'archive_confirmation');
  output.stdout.push(
    '  Archive:',
    await fieldStatus('verify_result', await readField(name, 'verify_result')),
    await fieldStatus('archive_confirmation', archiveConfirmation),
    await fieldStatus('archived', await readField(name, 'archived')),
    '',
    archiveConfirmation === 'confirmed'
      ? 'Recovery action: Archive is confirmed. Run /owner-archive to complete archiving.'
      : 'Recovery action: Ask for final archive confirmation in /owner-archive before running the archive command.',
  );
}

async function recover(output: CommandOutput, name: string): Promise<void> {
  validateChangeName(name);
  const { file, directory, label } = await stateFile(name);
  if (!(await exists(file))) fail(`ERROR: .owner.yaml not found at ${label}/.owner.yaml`);
  const phase = await readField(name, 'phase');
  const workflow = await readField(name, 'workflow');
  output.stdout.push(
    `=== Recovery Context: ${name} ===`,
    `Phase: ${phase}`,
    `Workflow: ${workflow}`,
    '',
    'State fields:',
  );
  if (phase === 'open') {
    await recoverOpen(output, directory);
  } else if (phase === 'design') {
    await recoverDesign(output, name, directory);
  } else if (phase === 'build') {
    await recoverBuild(output, name, directory, workflow);
  } else if (phase === 'verify') {
    await recoverVerify(output, name);
  } else if (phase === 'archive') {
    await recoverArchive(output, name);
  } else {
    fail(`ERROR: Unknown phase: ${phase}`);
  }
  output.stdout.push('', '=== End Recovery Context ===');
}

async function scale(output: CommandOutput, name: string): Promise<void> {
  validateChangeName(name);
  const { file, directory, label } = await stateFile(name);
  if (!(await exists(file))) fail(`ERROR: .owner.yaml not found at ${label}/.owner.yaml`);
  const tasksFile = path.join(directory, 'tasks.md');
  const taskCount = (await exists(tasksFile))
    ? (
        await readPipelineProjectFile(pipelineCommandProjectRoot(), tasksFile, {
          label: 'Pipeline scale task file',
        })
      )
        .split(/\r?\n/u)
        .filter((line) => /^- \[/u.test(line)).length
    : 0;
  const specs = path.join(directory, 'specs');
  let deltaSpecs = 0;
  if (await exists(specs)) {
    for (const entry of await fs.readdir(specs)) {
      if (await exists(path.join(specs, entry, 'spec.md'))) deltaSpecs += 1;
    }
  }
  const plan = await readField(name, 'plan');
  let baseRef = '';
  if (plan && plan !== 'null' && (await exists(plan))) {
    const match = (
      await readPipelineProjectFile(pipelineCommandProjectRoot(), plan, {
        label: 'Pipeline scale plan',
      })
    ).match(/^base-ref:\s*(.+)$/mu);
    baseRef = match?.[1].trim() ?? '';
  }
  if (!baseRef) baseRef = await readField(name, 'base_ref');
  const changed = gitOutput([
    'diff',
    '--name-only',
    ...(baseRef && baseRef !== 'null' ? [`${baseRef}...HEAD`] : ['HEAD']),
  ]);
  const changedFiles = changed ? changed.split(/\r?\n/u).filter(Boolean).length : 0;
  const result = taskCount > 3 || deltaSpecs > 1 || changedFiles > 8 ? 'full' : 'light';
  await setField(new CommandOutput(), name, 'verify_mode', result);
  output.stderr.push(
    `=== Scale Assessment: ${name} ===`,
    `  Tasks: ${taskCount} (threshold: 3)`,
    `  Delta specs: ${deltaSpecs} capabilities (threshold: 1)`,
    `  Changed files: ${changedFiles} (threshold: 8)`,
    `  → Result: ${result}`,
    green(`[SCALE] verify_mode=${result}`),
  );
}

function parseRecordCheckOptions(args: string[]): {
  command: string;
  exitCode: number;
  cwd?: string;
} {
  let command: string | undefined;
  let exitCodeText: string | undefined;
  let cwd: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    if (!['--command', '--exit-code', '--cwd'].includes(option)) {
      fail(`ERROR: Unknown option: ${option}`);
    }
    const value = args[index + 1];
    if (value === undefined) fail(`ERROR: Missing value for option: ${option}`);
    if (option === '--command') command = value;
    else if (option === '--exit-code') exitCodeText = value;
    else cwd = value;
  }
  if (command === undefined) fail('ERROR: Missing option: --command');
  if (exitCodeText === undefined) fail('ERROR: Missing option: --exit-code');
  if (!/^-?\d+$/u.test(exitCodeText)) fail('ERROR: --exit-code must be an integer');
  return { command, exitCode: Number(exitCodeText), ...(cwd === undefined ? {} : { cwd }) };
}

async function recordCheck(
  output: CommandOutput,
  name: string,
  scopeText: string,
  args: string[],
): Promise<void> {
  validateChangeName(name);
  if (scopeText !== 'build' && scopeText !== 'verify') {
    fail(`ERROR: Invalid command check scope: '${scopeText}'`);
  }
  const options = parseRecordCheckOptions(args);
  const { directory, file } = await stateFile(name);
  const projectRoot = pipelineCommandProjectRoot();
  const activeChangesDir = (await assertPipelineLayoutReadable(projectRoot)).changesDir;
  if (path.dirname(directory) !== activeChangesDir || !(await exists(file))) {
    fail(`ERROR: command checks require an active change: ${name}`);
  }
  try {
    const projection = await readPipelineState(directory, { migrate: false });
    if (!projection.pipeline || !projection.run) {
      throw new Error('command checks require an existing synchronized Pipeline Run');
    }
    const { run } = await validatePipelineRuntimeRun(directory, projection);
    const recorded = await recordCommandCheck(projectRoot, directory, run, {
      scope: scopeText as CommandCheckScope,
      ...options,
      cwd:
        options.cwd ??
        (path.relative(projectRoot, pipelineCommandInvocationCwd()).replaceAll('\\', '/') || '.'),
    });
    output.stderr.push(
      green(
        `[RECORDED] ${recorded.scope} exit=${recorded.exitCode} cwd=${recorded.cwd} command=${recorded.command}`,
      ),
    );
  } catch (error) {
    fail(`ERROR: ${(error as Error).message}`);
  }
}

function required(args: string[], count: number, usage: string): void {
  if (args.length < count) fail(usage);
}

function requiredExact(args: string[], count: number, usage: string): void {
  if (args.length !== count) fail(usage);
}

const MUTATING_STATE_COMMANDS = new Set([
  'init',
  'set',
  'transition',
  'check',
  'scale',
  'record-check',
  'rebind',
  'select',
  'clear-selection',
]);

async function assertStateCommandWritable(subcommand: string | undefined): Promise<void> {
  if (!subcommand || !MUTATING_STATE_COMMANDS.has(subcommand)) return;
  try {
    await assertPipelineLayoutWritable(pipelineCommandProjectRoot());
  } catch (error) {
    fail(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function selectChange(output: CommandOutput, name: string): Promise<void> {
  validateChangeName(name);
  try {
    const requestedRoot = pipelineCommandProjectRoot();
    const workspace = await resolvePipelineWorkspace({ projectRoot: requestedRoot, name });
    const selection = await selectCurrentChange(workspace.projectRoot, name);
    const change = await resolvePipelineChangeDirectory(name, workspace.projectRoot);
    const state = await readPipelineState(change.directory, { migrate: false });
    const bound = state.pipeline?.boundBranch ?? null;
    output.stderr.push(
      green(
        `[SELECTED] current change: ${selection.change}${bound ? ` (branch: ${bound})` : ''}${workspace.routed ? ` (workspace: ${workspace.projectRoot})` : ''}`,
      ),
    );
  } catch (error) {
    fail(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function rebind(output: CommandOutput, name: string): Promise<void> {
  validateChangeName(name);
  const { directory } = await stateFile(name);
  const boundBranch = await readField(name, 'bound_branch');
  if (!boundBranch || boundBranch === 'null') {
    fail(
      `ERROR: '${name}' is not yet bound; use 'owner state set ${name} isolation <current|branch|worktree>' to establish the first binding`,
    );
  }
  const branch = liveGitBranch(pipelineCommandInvocationCwd());
  if (branch === null) {
    fail('ERROR: cannot rebind while HEAD is detached; checkout a branch first');
  }
  const before = await readPipelineState(directory);
  if (!before.pipeline) fail('ERROR: Pipeline state projection is missing');
  await healBoundBranch(directory, branch);
  const after: PipelineState = { ...before.pipeline, boundBranch: branch };
  await appendPipelineStateEvent(directory, {
    change: name,
    event: 'rebind',
    source: 'owner-state',
    from: before.pipeline,
    to: after,
    effects: [{ field: 'boundBranch', from: boundBranch, to: branch }],
  });
  output.stderr.push(green(`[REBIND] bound_branch: ${boundBranch} → ${branch}`));
}

async function currentChange(output: CommandOutput): Promise<void> {
  const resolution = await resolveCurrentChange(pipelineCommandProjectRoot());
  if (resolution.status === 'selected') {
    output.stdout.push(resolution.selection.change);
    return;
  }
  if (resolution.status === 'missing') {
    fail('ERROR: no current change selected\nUse: owner-state.mjs select <change-name>');
  }
  fail(
    `ERROR: current change selection is stale: ${resolution.reason}\nUse: owner-state.mjs select <change-name>`,
  );
}

async function clearSelection(output: CommandOutput): Promise<void> {
  await clearCurrentChange(pipelineCommandProjectRoot());
  output.stderr.push(green('[CLEARED] current change selection'));
}

export const pipelineStateCommand: PipelineCommandHandler = async (args, options) =>
  withPipelineCommandContext(options, async () => {
    const output = new CommandOutput();
    try {
      const [subcommand, ...rest] = args;
      await assertStateCommandWritable(subcommand);
      if (subcommand === 'init') {
        required(rest, 2, 'Usage: owner-state.mjs init <change-name> <workflow>');
        const initOptions = rest.slice(2);
        let isolation: string | null = null;
        if (initOptions.length > 0) {
          if (initOptions.length !== 2 || initOptions[0] !== '--isolation') {
            fail('Usage: owner-state.mjs init <change-name> <workflow> [--isolation <mode>]');
          }
          isolation = initOptions[1];
        }
        await init(output, rest[0], rest[1], isolation);
      } else if (subcommand === 'get') {
        required(rest, 2, 'Usage: owner-state.mjs get <change-name> <field>');
        validateChangeName(rest[0]);
        output.stdout.push(await readField(rest[0], rest[1]));
      } else if (subcommand === 'set') {
        required(rest, 3, 'Usage: owner-state.mjs set <change-name> <field> <value>');
        validateChangeName(rest[0]);
        await setField(output, rest[0], rest[1], rest[2]);
      } else if (subcommand === 'transition') {
        required(rest, 2, 'Usage: owner-state.mjs transition <change-name> <event>');
        await transition(output, rest[0], rest[1]);
      } else if (subcommand === 'check') {
        required(rest, 2, 'Usage: owner-state.mjs check <change-name> <phase> [--recover]');
        if (rest[2] === '--recover') await recover(output, rest[0]);
        else await check(output, rest[0], rest[1]);
      } else if (subcommand === 'scale') {
        required(rest, 1, 'Usage: owner-state.mjs scale <change-name>');
        await scale(output, rest[0]);
      } else if (subcommand === 'record-check') {
        required(
          rest,
          2,
          'Usage: owner state record-check <change> <build|verify> --command <text> --exit-code <int> [--cwd <path>]',
        );
        await recordCheck(output, rest[0], rest[1], rest.slice(2));
      } else if (subcommand === 'task-checkoff') {
        required(rest, 2, 'Usage: owner-state.mjs task-checkoff <file> <task-text>');
        await taskCheckoff(output, rest[0], rest[1]);
      } else if (subcommand === 'rebind') {
        requiredExact(rest, 1, 'Usage: owner-state.mjs rebind <change-name>');
        await rebind(output, rest[0]);
      } else if (subcommand === 'select') {
        requiredExact(rest, 1, 'Usage: owner-state.mjs select <change-name>');
        await selectChange(output, rest[0]);
      } else if (subcommand === 'current') {
        requiredExact(rest, 0, 'Usage: owner-state.mjs current');
        await currentChange(output);
      } else if (subcommand === 'clear-selection') {
        requiredExact(rest, 0, 'Usage: owner-state.mjs clear-selection');
        await clearSelection(output);
      } else if (subcommand === 'next') {
        required(rest, 1, 'Usage: owner-state.mjs next <change-name>');
        await next(output, rest[0]);
      } else {
        fail(`Unknown subcommand: ${subcommand ?? ''}`);
      }
      return output.result();
    } catch (error) {
      if (!(error instanceof CommandFailure)) throw error;
      // The frozen 0.3.8 shell calls red() once per line and never embeds newlines
      // inside a single color call. Mirror that contract by wrapping each line of
      // the message in its own span so multi-line errors (e.g. validateEnum) render
      // as separate colored lines rather than one span across a newline.
      if (error.message) {
        for (const line of error.message.split('\n')) output.stderr.push(red(line));
      }
      return output.result(error.exitCode);
    }
  });
