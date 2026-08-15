import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { parseDocument } from 'yaml';
import type { PipelineCommandHandler, PipelineCommandResult } from './pipeline-cli.js';
import {
  latestCommandCheck,
  type CommandCheckScope,
  type RecordedCommandCheck,
} from './pipeline-command-checks.js';
import { inspectPipelineChange } from './pipeline-diagnostics.js';
import { assertPipelineLayoutWritable, pipelineProjectRelative } from './pipeline-layout.js';
import { openSpecChangeNameError, resolvePipelineChangeDirectory } from './pipeline-paths.js';
import { ensurePipelineRuntimeRun, transitionPipelineRuntimeRun } from './pipeline-runtime-run.js';
import type { PipelineRunContext } from './pipeline-migrate.js';
import type { PipelinePhase, PipelineState } from './pipeline-state.js';
import { appendPipelineStateEvent } from './pipeline-state-events.js';
import {
  PIPELINE_GUARD_TRANSITION_EVENT,
  applyPipelineTransition,
} from './pipeline-transitions.js';
import { pipelineValidateCommand } from './pipeline-validate-command.js';
import { readPipelineState } from './pipeline-store.js';
import { readPipelineConfigValue } from './pipeline-project-config.js';
import { readWorkflowProjectConfigDocument } from '../workflow-contract/project-config-reader.js';
import {
  pipelineProjectFileNonempty,
  pipelineProjectTargetExists,
  inspectPipelineProjectTarget,
  readPipelineProjectBytes,
  readPipelineProjectFile,
} from './pipeline-protected-path.js';
import {
  driftBlockedMessage,
  resolveBranchBinding,
  unboundDetachedMessage,
  type BranchBindingOutcome,
} from './pipeline-branch-binding.js';
import {
  pipelineCommandInvocationCwd,
  pipelineCommandProjectRoot,
  withPipelineCommandContext,
} from './pipeline-command-context.js';

const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const YELLOW = '\u001b[33m';
const RESET = '\u001b[0m';
const PHASES = ['open', 'design', 'build', 'verify', 'archive'] as const;
const PHASE_HEADER: Record<string, string> = {
  open: '=== Guard: open → next ===',
  design: '=== Guard: design → build ===',
  build: '=== Guard: build → verify ===',
  verify: '=== Guard: verify → archive ===',
  archive: '=== Guard: archive completeness ===',
};
const APPLY_MESSAGE: Record<string, string> = {
  open: '  [APPLY] .owner.yaml updated: phase=PLACEHOLDER',
  design: '  [APPLY] .owner.yaml updated: phase=build',
  build: '  [APPLY] .owner.yaml updated: phase=verify, verify_result=pending',
  verify: '  [APPLY] .owner.yaml updated: phase=archive, verify_result=pass',
};
const PIPELINE_FIELD_WIRE_NAMES: Partial<Record<keyof PipelineState, string>> = {
  branchStatus: 'branch_status',
  phase: 'phase',
  verificationReport: 'verification_report',
  verifiedAt: 'verified_at',
  verifyResult: 'verify_result',
};

function green(message: string): string {
  return `${GREEN}${message}${RESET}`;
}

function red(message: string): string {
  return `${RED}${message}${RESET}`;
}

function yellow(message: string): string {
  return `${YELLOW}${message}${RESET}`;
}

function wireField(field: keyof PipelineState): string {
  return PIPELINE_FIELD_WIRE_NAMES[field] ?? String(field);
}

function wireValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

class GuardFailure extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

class GuardOutput {
  readonly stderr: string[] = [];
  diagnostics?: Record<string, unknown>;

  toResult(exitCode = 0): PipelineCommandResult {
    return {
      exitCode,
      ...(this.diagnostics
        ? { stdout: JSON.stringify({ diagnostics: this.diagnostics }) + '\n' }
        : {}),
      ...(this.stderr.length > 0 ? { stderr: this.stderr.join('\n') + '\n' } : {}),
    };
  }
}

async function exists(file: string): Promise<boolean> {
  const projectRoot = pipelineCommandProjectRoot();
  return pipelineProjectTargetExists(projectRoot, file, {
    label: `Pipeline guard path ${path.relative(projectRoot, path.resolve(projectRoot, file)).replaceAll('\\', '/')}`,
  });
}

async function nonempty(file: string): Promise<boolean> {
  const projectRoot = pipelineCommandProjectRoot();
  return pipelineProjectFileNonempty(
    projectRoot,
    file,
    `Pipeline guard file ${path.relative(projectRoot, path.resolve(projectRoot, file)).replaceAll('\\', '/')}`,
  );
}

function validateChangeName(name: string): void {
  const error = openSpecChangeNameError(name);
  if (error) throw new GuardFailure(red(`ERROR: ${error}`));
}

// Resolve an absolute change directory for filesystem and runtime consumers.
// Frozen relative provenance strings are derived separately from projectRoot.
async function resolveChangeDir(name: string): Promise<string> {
  return (await resolvePipelineChangeDirectory(name, pipelineCommandProjectRoot())).directory;
}

async function readField(changeDir: string, field: string): Promise<string> {
  const file = path.join(changeDir, '.owner.yaml');
  const document = parseDocument(
    await readPipelineProjectFile(pipelineCommandProjectRoot(), file, {
      label: `Pipeline state ${changeDir}/.owner.yaml`,
    }),
    { uniqueKeys: false },
  );
  if (document.errors.length > 0) {
    throw new GuardFailure(`ERROR: Invalid .owner.yaml: ${document.errors[0].message}`);
  }
  const record = document.toJS() as Record<string, unknown>;
  const value = record[field];
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

async function projectConfigValue(field: string, changeDir: string): Promise<string> {
  const changeValue = await readField(changeDir, field);
  if (changeValue && changeValue !== 'null') return changeValue;
  return (await readPipelineConfigValue(field, { cwd: pipelineCommandProjectRoot() }))?.value ?? '';
}

async function configuredLanguage(changeDir: string): Promise<'en' | 'zh-CN'> {
  const language = await projectConfigValue('language', changeDir);
  if (!language) return 'en';
  if (language === 'en' || language === 'zh-CN') return language;
  throw new Error(`configured language '${language}' is invalid; expected en or zh-CN.`);
}

function stripFencedCodeBlocks(source: string): string {
  const kept: string[] = [];
  let inFence = false;
  for (const line of source.split(/\r?\n/u)) {
    if (/^\s*```/u.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) kept.push(line);
  }
  return kept.join('\n');
}

function countCjkChars(source: string): number {
  return source.match(/[\u4e00-\u9fff]/gu)?.length ?? 0;
}

function countEnglishWords(source: string): number {
  return source.match(/[A-Za-z][A-Za-z0-9_-]{2,}/gu)?.length ?? 0;
}

async function documentLanguageMatchesConfigured(
  changeDir: string,
  file: string,
): Promise<CheckResult> {
  const language = await configuredLanguage(changeDir);
  const source = stripFencedCodeBlocks(
    await readPipelineProjectFile(pipelineCommandProjectRoot(), file, {
      label: `Pipeline language-check artifact ${file}`,
    }),
  );
  const cjk = countCjkChars(source);
  const englishWords = countEnglishWords(source);

  if (language === 'zh-CN' && cjk < 20 && englishWords >= 20) {
    return fail(
      `configured language is zh-CN, but ${file} appears to be English-dominant (cjk_chars=${cjk}, english_words=${englishWords}).\nNext: regenerate or rewrite this artifact in Chinese while preserving necessary technical terms.`,
    );
  }
  if (language === 'en' && cjk > 20 && cjk > englishWords) {
    return fail(
      `configured language is en, but ${file} appears to be Chinese-dominant (cjk_chars=${cjk}, english_words=${englishWords}).\nNext: regenerate or rewrite this artifact in English while preserving necessary technical terms.`,
    );
  }
  return pass();
}

async function hashFile(file: string): Promise<string> {
  return createHash('sha256')
    .update(
      await readPipelineProjectBytes(pipelineCommandProjectRoot(), file, {
        label: `Pipeline handoff source ${file}`,
      }),
    )
    .digest('hex');
}

async function handoffSourceFiles(changeDir: string): Promise<string[]> {
  // Use forward-slash concatenation (not path.join, which uses the OS separator)
  // so the handoff-hash input and markdown `Source:` references match the frozen
  // shell + owner-handoff provenance byte-for-byte. changeDir is a relative forward-slash
  // path (openspec/changes/<name>); forward slashes are readable on Windows too.
  const changeRef = pipelineProjectRelative(pipelineCommandProjectRoot(), changeDir);
  const files = [`${changeRef}/proposal.md`, `${changeRef}/design.md`, `${changeRef}/tasks.md`];
  const specs = `${changeRef}/specs`;
  if (await exists(specs)) {
    const specsInspection = await inspectPipelineProjectTarget(
      pipelineCommandProjectRoot(),
      specs,
      {
        label: `Pipeline delta-spec directory ${specs}`,
        expected: 'directory',
      },
    );
    for (const entry of (await fs.readdir(specsInspection.target)).sort()) {
      const spec = `${specs}/${entry}/spec.md`;
      if (await exists(spec)) files.push(spec);
    }
  }
  return files;
}

async function computeHandoffHash(changeDir: string): Promise<string> {
  const lines: string[] = [];
  for (const file of await handoffSourceFiles(changeDir)) {
    if (await exists(file)) {
      lines.push(`path:${file}`, `sha256:${await hashFile(file)}`);
    }
  }
  // Match the frozen shell: command substitution $(...) strips the trailing
  // newline, so the hashed payload ends with the last sha256 line (no trailing \n).
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

async function preflight(changeDir: string, name: string): Promise<void> {
  if (!(await exists(changeDir))) {
    throw new GuardFailure(red(`FATAL: change directory not found: ${changeDir}`));
  }
  if (!(await exists(path.join(changeDir, '.owner.yaml')))) {
    throw new GuardFailure(red(`FATAL: .owner.yaml not found in ${changeDir}`));
  }
  await inspectPipelineProjectTarget(pipelineCommandProjectRoot(), path.join(changeDir, '.owner'), {
    label: `Pipeline runtime directory for ${name}`,
    expected: 'directory',
  });
  const result = await pipelineValidateCommand([name], { json: false });
  if (result.exitCode !== 0) {
    if (result.stderr)
      process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
    throw new GuardFailure(red('FATAL: .owner.yaml schema validation failed'));
  }
  const projection = await readPipelineState(changeDir);
  const unknownKeys = Array.from(new Set(projection.unknownKeys)).sort();
  if (unknownKeys.length > 0) {
    throw new GuardFailure(
      red(`FATAL: .owner.yaml has unknown field(s): ${unknownKeys.join(', ')}`),
    );
  }
}

interface CheckOutcome {
  description: string;
  passed: boolean;
  detail: string;
}

type CheckResult = { passed: true; detail?: string } | { passed: false; detail: string };

function pushCheck(output: GuardOutput, outcome: CheckOutcome): void {
  if (outcome.passed) {
    output.stderr.push(green(`  [PASS] ${outcome.description}`));
    if (outcome.detail) {
      for (const line of outcome.detail.split('\n')) output.stderr.push(green(`    ${line}`));
    }
  } else {
    output.stderr.push(red(`  [FAIL] ${outcome.description}`));
    if (outcome.detail) {
      for (const line of outcome.detail.split('\n')) output.stderr.push(red(`    ${line}`));
    }
  }
}

function check(description: string, run: () => Promise<CheckResult>): () => Promise<CheckOutcome> {
  return async () => {
    try {
      const result = await run();
      return {
        description,
        passed: result.passed,
        detail: ('detail' in result ? result.detail : '') ?? '',
      };
    } catch (error) {
      return {
        description,
        passed: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

function pass(detail?: string): CheckResult {
  return { passed: true, ...(detail ? { detail } : {}) };
}

function fail(detail: string): CheckResult {
  return { passed: false, detail };
}

async function runChecks(
  output: GuardOutput,
  builders: Array<() => Promise<CheckOutcome>>,
): Promise<boolean> {
  let blocked = false;
  for (const build of builders) {
    const outcome = await build();
    pushCheck(output, outcome);
    if (!outcome.passed) blocked = true;
  }
  return blocked;
}

interface CommandRun {
  status: number;
  output: string;
}

const INFERRED_COMMAND_SOURCES = [
  'package.json with a build script',
  'pom.xml',
  'Cargo.toml',
] as const;

async function removedProjectCommandField(field: 'build_command' | 'verify_command') {
  try {
    const document = await readWorkflowProjectConfigDocument(pipelineCommandProjectRoot(), {
      allowPartialProject: true,
    });
    if (!document) return false;
    return Object.prototype.hasOwnProperty.call(document.value, field);
  } catch (error) {
    throw new Error(
      `.owner/config.yaml is invalid YAML (${error instanceof Error ? error.message : String(error)}); cannot check for removed "${field}" field. Fix the config and retry.`,
      { cause: error },
    );
  }
}

function removedProjectCommandRun(field: 'build_command' | 'verify_command'): CommandRun {
  return {
    status: 1,
    output: `${field} has been removed from .owner/config.yaml. Delete this field and run any required ${field === 'build_command' ? 'build' : 'verification'} command manually before retrying.`,
  };
}

function runInferred(command: string): CommandRun {
  // Inferred build/verify commands (npm run build, mvn, cargo, …) run through
  // the platform's default shell so .cmd shims resolve on Windows without
  // requiring bash. Output is returned raw (no `+ ` prefix).
  const result = spawnSync(command, {
    shell: true,
    cwd: pipelineCommandInvocationCwd(),
    encoding: 'utf8',
    timeout: 300_000,
  });
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.replace(/\n+$/u, ''),
  };
}

function invocationTarget(relative: string): string {
  return path.resolve(pipelineCommandInvocationCwd(), relative);
}

async function inferredBuildCommand(): Promise<string | null> {
  const packageJson = invocationTarget('package.json');
  if (await exists(packageJson)) {
    const parsed = JSON.parse(
      await readPipelineProjectFile(pipelineCommandProjectRoot(), packageJson, {
        label: 'package.json',
      }),
    ) as {
      scripts?: Record<string, unknown>;
    };
    if (typeof parsed.scripts?.build === 'string') return 'npm run build';
  }
  if (await exists(invocationTarget('pom.xml'))) {
    if (process.platform === 'win32') {
      if (await exists(invocationTarget('mvnw.cmd'))) return 'mvnw.cmd compile -q';
      return 'mvn.cmd compile -q';
    }
    if (await exists(invocationTarget('mvnw'))) return './mvnw compile -q';
    return 'mvn compile -q';
  }
  if (await exists(invocationTarget('Cargo.toml'))) return 'cargo build';
  return null;
}

function evidenceDetail(record: RecordedCommandCheck): string {
  return `Evidence: recorded command-check at ${record.timestamp}; command: ${record.command}; cwd: ${record.cwd}`;
}

function recoveryCommand(change: string, scope: CommandCheckScope, command: string): string {
  return `owner state record-check ${change} ${scope} --command "${command}" --exit-code 0`;
}

async function commandCheckPasses(
  changeDir: string,
  change: string,
  run: PipelineRunContext['run'],
  scope: CommandCheckScope,
): Promise<CommandRun> {
  if (process.env.OWNER_SKIP_BUILD === '1') {
    return { status: 0, output: 'SKIPPED via OWNER_SKIP_BUILD=1' };
  }
  const removedFields: Array<'build_command' | 'verify_command'> =
    scope === 'build' ? ['build_command'] : ['verify_command', 'build_command'];
  for (const removedField of removedFields) {
    if (await removedProjectCommandField(removedField)) {
      return removedProjectCommandRun(removedField);
    }
  }
  const inferred = scope === 'build' ? await inferredBuildCommand() : null;
  if (inferred) return runInferred(inferred);

  const recorded = await latestCommandCheck(pipelineCommandProjectRoot(), changeDir, run, scope);
  if (!recorded) {
    return {
      status: 1,
      output:
        scope === 'build'
          ? `No inferred build command or recorded build check. Detection searched: ${INFERRED_COMMAND_SOURCES.join(', ')}.\nNext: run the required command, then record it with:\n${recoveryCommand(change, scope, '<command>')}`
          : `No recorded verify check.\nNext: run the required verification command, then record it with:\n${recoveryCommand(change, scope, '<command>')}`,
    };
  }
  if (recorded.exitCode !== 0) {
    return {
      status: recorded.exitCode,
      output: `Latest recorded ${scope} check failed with exit code ${recorded.exitCode}.\n${evidenceDetail(recorded)}\nNext: rerun the command successfully, then record it with:\n${recoveryCommand(change, scope, recorded.command)}`,
    };
  }
  return { status: 0, output: evidenceDetail(recorded) };
}

async function tasksAllDone(changeDir: string): Promise<CheckResult> {
  const tasks = path.join(changeDir, 'tasks.md');
  if (!(await exists(tasks))) {
    return fail(
      `tasks.md is missing at ${tasks}\nNext: restore or create tasks.md for this change before leaving build.`,
    );
  }
  const source = await readPipelineProjectFile(pipelineCommandProjectRoot(), tasks, {
    label: `Pipeline tasks ${tasks}`,
  });
  if (!/- \[x\]/u.test(source)) {
    return fail(
      "tasks.md has no completed tasks.\nNext: complete implementation tasks and mark them with '- [x]'.",
    );
  }
  const unfinished = source
    .split(/\r?\n/u)
    .map((line, index) => ({ line, number: index + 1 }))
    .filter((entry) => /^- \[ \]/u.test(entry.line));
  if (unfinished.length > 0) {
    return fail(
      `Unfinished tasks:\n${unfinished.map((entry) => `${entry.number}:${entry.line}`).join('\n')}\nNext: complete or explicitly remove unfinished tasks, then mark tasks.md with '- [x]'.`,
    );
  }
  return pass();
}

async function tasksHasAny(changeDir: string): Promise<boolean> {
  const tasks = path.join(changeDir, 'tasks.md');
  if (!(await exists(tasks))) return false;
  return /- \[/u.test(
    await readPipelineProjectFile(pipelineCommandProjectRoot(), tasks, {
      label: `Pipeline tasks ${tasks}`,
    }),
  );
}

async function planTasksAllDone(changeDir: string): Promise<CheckResult> {
  const plan = await readField(changeDir, 'plan');
  if (!plan || plan === 'null') return pass();
  if (!(await exists(plan))) {
    return fail(
      `plan file is missing at ${plan}\nNext: restore the Superpowers plan file or update .owner.yaml plan before leaving build.`,
    );
  }
  const source = await readPipelineProjectFile(pipelineCommandProjectRoot(), plan, {
    label: `Pipeline plan ${plan}`,
  });
  const unfinished = source
    .split(/\r?\n/u)
    .map((line, index) => ({ line, number: index + 1 }))
    .filter((entry) => /^\s*- \[ \]/u.test(entry.line));
  if (unfinished.length > 0) {
    return fail(
      `Unfinished Superpowers plan tasks:\n${unfinished.map((entry) => `${entry.number}:${entry.line}`).join('\n')}\nNext: check off corresponding completed plan tasks, then commit the plan update.`,
    );
  }
  return pass();
}

async function boundBranchMatches(changeDir: string, change: string): Promise<CheckResult> {
  let outcome: BranchBindingOutcome;
  try {
    outcome = await resolveBranchBinding(changeDir, {
      heal: true,
      cwd: pipelineCommandInvocationCwd(),
    });
  } catch (error) {
    throw new GuardFailure(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  }
  switch (outcome.status) {
    case 'drift':
      return fail(driftBlockedMessage(change, outcome.boundBranch, outcome.currentBranch));
    case 'unbound-detached':
      return fail(unboundDetachedMessage(change));
    case 'healed':
      return pass(`bound_branch lazily set to ${outcome.branch}`);
    case 'needs-heal':
    case 'ok':
    case 'not-applicable':
      return pass();
    default: {
      const exhaustive: never = outcome;
      throw new Error(`unhandled branch binding status: ${JSON.stringify(exhaustive)}`);
    }
  }
}

async function isolationSelected(changeDir: string, change: string): Promise<CheckResult> {
  const isolation = await readField(changeDir, 'isolation');
  if (isolation === 'current' || isolation === 'branch' || isolation === 'worktree') return pass();
  const allowedValues = '<current|branch|worktree>';
  return fail(
    `isolation must be current, branch, or worktree, got '${isolation || 'null'}'\nNext: choose a valid workspace mode, prepare it when needed, then run:\n  owner state set ${change} isolation ${allowedValues}`,
  );
}

async function buildModeSelected(changeDir: string, change: string): Promise<CheckResult> {
  const buildMode = await readField(changeDir, 'build_mode');
  if (['subagent-driven-development', 'executing-plans', 'direct'].includes(buildMode))
    return pass();
  return fail(
    `build_mode must be selected before leaving build, got '${buildMode || 'null'}'\nNext: ask the user to choose an execution mode, then run:\n  owner state set ${change} build_mode <subagent-driven-development|executing-plans>`,
  );
}

async function buildModeAllowedForWorkflow(changeDir: string): Promise<CheckResult> {
  const workflow = await readField(changeDir, 'workflow');
  const buildMode = await readField(changeDir, 'build_mode');
  const directOverride = await readField(changeDir, 'direct_override');
  if (buildMode !== 'direct') return pass();
  if (workflow === 'hotfix' || workflow === 'tweak') return pass();
  if (directOverride === 'true') return pass();
  return fail(
    'build_mode=direct is only allowed for hotfix/tweak unless direct_override: true is recorded\nNext: choose executing-plans or subagent-driven-development, or stop and ask the user for an explicit direct override.',
  );
}

async function subagentDispatchConfirmed(changeDir: string, change: string): Promise<CheckResult> {
  const buildMode = await readField(changeDir, 'build_mode');
  const subagentDispatch = await readField(changeDir, 'subagent_dispatch');
  if (buildMode !== 'subagent-driven-development') return pass();
  if (subagentDispatch === 'confirmed') return pass();
  return fail(
    `subagent_dispatch must be confirmed before using build_mode=subagent-driven-development\nNext: record the selected subagent-driven execution, then run:\n  owner state set ${change} subagent_dispatch confirmed`,
  );
}

async function tddModeSelected(changeDir: string, change: string): Promise<CheckResult> {
  const workflow = await readField(changeDir, 'workflow');
  if (workflow === 'hotfix' || workflow === 'tweak') return pass();
  const tddMode = await readField(changeDir, 'tdd_mode');
  if (tddMode === 'tdd' || tddMode === 'direct') return pass();
  return fail(
    `tdd_mode must be tdd or direct for full workflow, got '${tddMode || 'null'}'\nNext: ask the user to choose TDD enforcement level, then run:\n  owner state set ${change} tdd_mode <tdd|direct>`,
  );
}

async function reviewModeSelected(changeDir: string, change: string): Promise<CheckResult> {
  const workflow = await readField(changeDir, 'workflow');
  if (workflow === 'hotfix' || workflow === 'tweak') return pass();
  const reviewMode = await readField(changeDir, 'review_mode');
  if (reviewMode === 'off' || reviewMode === 'standard' || reviewMode === 'thorough') {
    return pass();
  }
  return fail(
    `review_mode must be off, standard, or thorough before leaving build, got '${reviewMode || 'null'}'\nNext: ask the user to choose review strength, then run:\n  owner state set ${change} review_mode <off|standard|thorough>`,
  );
}

async function verificationReportExists(changeDir: string): Promise<boolean> {
  const report = await readField(changeDir, 'verification_report');
  return Boolean(report) && report !== 'null' && (await exists(report));
}

async function branchStatusHandled(changeDir: string): Promise<boolean> {
  return (await readField(changeDir, 'branch_status')) === 'handled';
}

async function archivedIsTrue(changeDir: string): Promise<boolean> {
  return (await readField(changeDir, 'archived')) === 'true';
}

async function designDocFrontmatterHas(
  designDoc: string,
  field: string,
  expected: string,
): Promise<boolean> {
  const source = (
    await readPipelineProjectFile(pipelineCommandProjectRoot(), designDoc, {
      label: `Pipeline Design Doc ${designDoc}`,
    })
  ).replace(/^\uFEFF/u, '');
  let inFrontmatter = false;
  for (const line of source.split(/\r?\n/u)) {
    if (!inFrontmatter) {
      if (line === '---') inFrontmatter = true;
      continue;
    }
    if (line === '---') break;
    if (new RegExp(`^${field}: ['"]?${expected}['"]?\\s*$`, 'u').test(line)) return true;
  }
  return false;
}

async function designDocRecorded(changeDir: string, change: string): Promise<CheckResult> {
  const designDoc = await readField(changeDir, 'design_doc');
  if (designDoc && designDoc !== 'null' && (await exists(designDoc))) return pass();
  return fail(
    `design_doc must point to an existing Superpowers Design Doc for full workflow before leaving design.\nNext: create the Design Doc and run: owner state set ${change} design_doc <path>`,
  );
}

async function designHandoffContextValid(changeDir: string, change: string): Promise<CheckResult> {
  const context = await readField(changeDir, 'handoff_context');
  const recordedHash = await readField(changeDir, 'handoff_hash');
  if (!context || context === 'null') {
    return fail(
      `handoff_context is missing from .owner.yaml\nNext: run node "$OWNER_HANDOFF" ${change} design --write before invoking Superpowers.`,
    );
  }
  if (!(await nonempty(context))) {
    return fail(
      `handoff_context does not point to a non-empty file: ${context}\nNext: regenerate the design handoff with owner handoff ${change} design --write.`,
    );
  }
  if (!/^[a-f0-9]{64}$/u.test(recordedHash)) {
    return fail(
      `handoff_hash is missing or invalid: ${recordedHash || 'null'}\nNext: regenerate the design handoff with owner handoff ${change} design --write.`,
    );
  }
  const actualHash = await computeHandoffHash(changeDir);
  if (actualHash !== recordedHash) {
    return fail(
      `OpenSpec artifacts changed after handoff was generated.\nExpected handoff_hash: ${recordedHash}\nActual handoff_hash:   ${actualHash}\nNext: run owner handoff ${change} design --write so Superpowers receives the current OpenSpec context.`,
    );
  }
  const markdown = `${context.replace(/\.json$/u, '')}.md`;
  if (!(await nonempty(markdown))) {
    return fail(
      `design handoff markdown is missing or empty: ${markdown}\nNext: regenerate the design handoff with owner handoff ${change} design --write.`,
    );
  }
  return pass();
}

async function designHandoffMarkdownTraceable(changeDir: string): Promise<CheckResult> {
  const context = await readField(changeDir, 'handoff_context');
  if (!context || context === 'null') return fail('handoff_context is missing from .owner.yaml');
  const markdown = `${context.replace(/\.json$/u, '')}.md`;
  if (!(await nonempty(markdown)))
    return fail(`design handoff markdown is missing or empty: ${markdown}`);
  const source = await readPipelineProjectFile(pipelineCommandProjectRoot(), markdown, {
    label: `Pipeline handoff markdown ${markdown}`,
  });
  const lines = new Set(source.split(/\r?\n/u));
  const problems: string[] = [];
  if (!/^Generated-by: owner-handoff\.sh$/mu.test(source)) {
    problems.push('handoff markdown is missing Generated-by marker');
  }
  if (!/^- Mode: (compact|full|beta)$/mu.test(source)) {
    problems.push('handoff markdown is missing Mode marker');
  }
  for (const file of await handoffSourceFiles(changeDir)) {
    if (!(await exists(file))) continue;
    if (!lines.has(`- Source: ${file}`)) {
      problems.push(`handoff markdown is missing source reference: ${file}`);
    }
    if (!lines.has(`- SHA256: ${await hashFile(file)}`)) {
      problems.push(`handoff markdown is missing current sha256 for: ${file}`);
    }
  }
  return problems.length === 0 ? pass() : fail(problems.join('\n'));
}

async function contextCompressionMode(changeDir: string): Promise<string> {
  return (await readField(changeDir, 'context_compression')) || 'off';
}

async function betaSpecJsonStructurallyValid(changeDir: string): Promise<CheckResult> {
  if ((await contextCompressionMode(changeDir)) !== 'beta') return pass();
  const context = await readField(changeDir, 'handoff_context');
  if (!context || context === 'null') return fail('handoff_context is missing from .owner.yaml');
  if (!(await nonempty(context))) return fail(`spec-context.json is missing or empty: ${context}`);
  const source = await readPipelineProjectFile(pipelineCommandProjectRoot(), context, {
    label: `Pipeline handoff context ${context}`,
  });
  const problems: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    return fail(
      `spec-context.json invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail('spec-context.json root must be an object');
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.change !== 'string') problems.push("spec-context.json missing 'change' field");
  if (typeof record.phase !== 'string') problems.push("spec-context.json missing 'phase' field");
  if (record.mode !== 'beta') problems.push('spec-context.json mode is not beta');
  if (typeof record.context_hash !== 'string') {
    problems.push("spec-context.json missing 'context_hash' field");
  }
  if (!Array.isArray(record.files)) problems.push("spec-context.json missing 'files' field");
  const files = Array.isArray(record.files)
    ? record.files.filter(
        (file): file is Record<string, unknown> =>
          Boolean(file) && typeof file === 'object' && !Array.isArray(file),
      )
    : [];
  for (const file of await handoffSourceFiles(changeDir)) {
    if (!(await exists(file))) continue;
    if (!files.some((entry) => entry.path === file && typeof entry.sha256 === 'string')) {
      problems.push(`spec-context.json missing source file reference: ${file}`);
    }
  }
  return problems.length === 0 ? pass() : fail(problems.join('\n'));
}

async function guardOpenChecks(output: GuardOutput, changeDir: string): Promise<boolean> {
  const workflow = await readField(changeDir, 'workflow');
  const checks: Array<() => Promise<CheckOutcome>> = [
    check('proposal.md exists and non-empty', async () =>
      (await nonempty(path.join(changeDir, 'proposal.md'))) ? pass() : fail(''),
    ),
    check('proposal.md matches configured language', () =>
      documentLanguageMatchesConfigured(changeDir, path.join(changeDir, 'proposal.md')),
    ),
    check('tasks.md exists and non-empty', async () =>
      (await nonempty(path.join(changeDir, 'tasks.md'))) ? pass() : fail(''),
    ),
    check('tasks.md matches configured language', () =>
      documentLanguageMatchesConfigured(changeDir, path.join(changeDir, 'tasks.md')),
    ),
    check('tasks.md has at least one task', async () =>
      (await tasksHasAny(changeDir)) ? pass() : fail(''),
    ),
  ];
  if (workflow === 'full') {
    checks.splice(
      1,
      0,
      check('design.md exists and non-empty', async () =>
        (await nonempty(path.join(changeDir, 'design.md'))) ? pass() : fail(''),
      ),
      check('design.md matches configured language', () =>
        documentLanguageMatchesConfigured(changeDir, path.join(changeDir, 'design.md')),
      ),
    );
  }
  return runChecks(output, checks);
}

async function guardDesignChecks(
  output: GuardOutput,
  changeDir: string,
  change: string,
): Promise<boolean> {
  const designDoc = await readField(changeDir, 'design_doc');
  const workflow = await readField(changeDir, 'workflow');
  const builders: Array<() => Promise<CheckOutcome>> = [
    check('proposal.md exists', async () =>
      (await nonempty(path.join(changeDir, 'proposal.md'))) ? pass() : fail(''),
    ),
    check('proposal.md matches configured language', () =>
      documentLanguageMatchesConfigured(changeDir, path.join(changeDir, 'proposal.md')),
    ),
    check('design.md exists', async () =>
      (await nonempty(path.join(changeDir, 'design.md'))) ? pass() : fail(''),
    ),
    check('design.md matches configured language', () =>
      documentLanguageMatchesConfigured(changeDir, path.join(changeDir, 'design.md')),
    ),
    check('tasks.md exists', async () =>
      (await nonempty(path.join(changeDir, 'tasks.md'))) ? pass() : fail(''),
    ),
    check('tasks.md matches configured language', () =>
      documentLanguageMatchesConfigured(changeDir, path.join(changeDir, 'tasks.md')),
    ),
    check('design handoff context exists', () => designHandoffContextValid(changeDir, change)),
    check('design handoff markdown is traceable', () => designHandoffMarkdownTraceable(changeDir)),
  ];
  if ((await contextCompressionMode(changeDir)) === 'beta') {
    builders.push(
      check('beta spec-context.json is structurally valid', () =>
        betaSpecJsonStructurallyValid(changeDir),
      ),
    );
  }
  if (workflow === 'full') {
    builders.push(
      check('design_doc is recorded for full workflow', () => designDocRecorded(changeDir, change)),
    );
  }
  let blocked = await runChecks(output, builders);
  if (designDoc && designDoc !== 'null') {
    blocked =
      (await runChecks(output, [
        check(`Design Doc (${designDoc}) exists`, async () =>
          (await nonempty(designDoc)) ? pass() : fail(''),
        ),
        check('Design Doc matches configured language', () =>
          documentLanguageMatchesConfigured(changeDir, designDoc),
        ),
        check('Design Doc frontmatter links current change', async () => {
          if (!(await nonempty(designDoc))) return fail('');
          return (await designDocFrontmatterHas(designDoc, 'owner_change', change))
            ? pass()
            : fail('');
        }),
        check('Design Doc declares technical design role', async () => {
          if (!(await nonempty(designDoc))) return fail('');
          return (await designDocFrontmatterHas(designDoc, 'role', 'technical-design'))
            ? pass()
            : fail('');
        }),
        check('Design Doc declares OpenSpec as canonical spec', async () => {
          if (!(await nonempty(designDoc))) return fail('');
          return (await designDocFrontmatterHas(designDoc, 'canonical_spec', 'openspec'))
            ? pass()
            : fail('');
        }),
      ])) || blocked;
  } else if (workflow !== 'full') {
    output.stderr.push(
      yellow('  [WARN] No design_doc recorded in .owner.yaml (optional for hotfix/tweak)'),
    );
  }
  return blocked;
}

async function guardBuildChecks(
  output: GuardOutput,
  changeDir: string,
  change: string,
  run: PipelineRunContext['run'],
): Promise<boolean> {
  return runChecks(output, [
    check('bound branch matches workspace mode', () => boundBranchMatches(changeDir, change)),
    check('isolation selected', () => isolationSelected(changeDir, change)),
    check('build_mode selected', () => buildModeSelected(changeDir, change)),
    check('build_mode allowed for workflow', () => buildModeAllowedForWorkflow(changeDir)),
    check('subagent dispatch confirmed', () => subagentDispatchConfirmed(changeDir, change)),
    check('tdd_mode selected', () => tddModeSelected(changeDir, change)),
    check('review_mode selected', () => reviewModeSelected(changeDir, change)),
    check('tasks.md all tasks checked', () => tasksAllDone(changeDir)),
    check('Superpowers plan all tasks checked', () => planTasksAllDone(changeDir)),
    check('proposal.md exists', async () =>
      (await nonempty(path.join(changeDir, 'proposal.md'))) ? pass() : fail(''),
    ),
    check('proposal.md matches configured language', () =>
      documentLanguageMatchesConfigured(changeDir, path.join(changeDir, 'proposal.md')),
    ),
    check('Superpowers plan matches configured language', async () => {
      const plan = await readField(changeDir, 'plan');
      if (!plan || plan === 'null' || !(await exists(plan))) return pass();
      return documentLanguageMatchesConfigured(changeDir, plan);
    }),
    // Build check runs last — only after all config checks pass — to avoid
    // wasting time on a build that would be rejected by a config failure.
    check('Build passes', async () => {
      const buildResult = await commandCheckPasses(changeDir, change, run, 'build');
      return buildResult.status === 0 ? pass(buildResult.output) : fail(buildResult.output);
    }),
  ]);
}

async function guardVerifyChecks(
  output: GuardOutput,
  changeDir: string,
  change: string,
  run: PipelineRunContext['run'],
): Promise<boolean> {
  return runChecks(output, [
    check('bound branch matches workspace mode', () => boundBranchMatches(changeDir, change)),
    check('tasks.md all tasks checked', () => tasksAllDone(changeDir)),
    // Verification command runs after tasks check — no point running tests
    // if tasks.md is incomplete.
    check('Verification passes', async () => {
      const verifyResult = await commandCheckPasses(changeDir, change, run, 'verify');
      return verifyResult.status === 0 ? pass(verifyResult.output) : fail(verifyResult.output);
    }),
    check('verification_report exists', async () =>
      (await verificationReportExists(changeDir)) ? pass() : fail(''),
    ),
    check('verification_report matches configured language', async () => {
      const report = await readField(changeDir, 'verification_report');
      if (!report || report === 'null' || !(await exists(report))) return pass();
      return documentLanguageMatchesConfigured(changeDir, report);
    }),
  ]);
}

async function guardArchiveChecks(
  output: GuardOutput,
  changeDir: string,
  change: string,
): Promise<boolean> {
  return runChecks(output, [
    check('bound branch matches workspace mode', () => boundBranchMatches(changeDir, change)),
    check('archived is true', async () => ((await archivedIsTrue(changeDir)) ? pass() : fail(''))),
    check('proposal.md exists', async () =>
      (await nonempty(path.join(changeDir, 'proposal.md'))) ? pass() : fail(''),
    ),
    check('design.md exists', async () =>
      (await nonempty(path.join(changeDir, 'design.md'))) ? pass() : fail(''),
    ),
    check('tasks.md all tasks checked', () => tasksAllDone(changeDir)),
    check('branch_status=handled', async () =>
      (await branchStatusHandled(changeDir)) ? pass() : fail(''),
    ),
  ]);
}

async function applyStateUpdate(
  output: GuardOutput,
  change: string,
  changeDir: string,
  phase: string,
): Promise<void> {
  const event = PIPELINE_GUARD_TRANSITION_EVENT[phase as PipelinePhase];
  if (!event) return;

  // Re-read instead of reusing the run context captured before the checks:
  // boundBranchMatches may have lazily healed bound_branch on disk, and a
  // stale projection would write the pre-heal null back over it.
  const context = await ensurePipelineRuntimeRun(changeDir);
  const result = applyPipelineTransition(context.pipeline, event);
  await transitionPipelineRuntimeRun(changeDir, result.pipeline, context.run, {
    event,
    phase,
    source: 'owner-guard',
  });
  await appendPipelineStateEvent(changeDir, {
    change,
    event,
    source: 'owner-guard',
    from: context.pipeline,
    to: result.pipeline,
    effects: result.effects,
  });

  for (const effect of result.effects) {
    output.stderr.push(green(`[SET] ${wireField(effect.field)}=${wireValue(effect.to)}`));
  }
  output.stderr.push(green(`[TRANSITION] ${event}`));
  const template = APPLY_MESSAGE[phase];
  const message =
    phase === 'open' ? template.replace('PLACEHOLDER', result.pipeline.phase) : template;
  output.stderr.push(green(message));
}

export const pipelineGuardCommand: PipelineCommandHandler = async (args, options) =>
  withPipelineCommandContext(options, async () => {
    const output = new GuardOutput();
    const [change, phase, flag] = args;
    try {
      validateChangeName(change);
      if (!phase || !PHASES.includes(phase as (typeof PHASES)[number])) {
        throw new GuardFailure(
          `${red(`Unknown phase: ${phase ?? ''}`)}\nValid phases: open, design, build, verify, archive`,
        );
      }
      await assertPipelineLayoutWritable(pipelineCommandProjectRoot());
      const changeDir = await resolveChangeDir(change);
      await preflight(changeDir, change);
      const runContext = await ensurePipelineRuntimeRun(changeDir);
      const diagnostic = await inspectPipelineChange(changeDir, change);
      if (options.json) {
        output.diagnostics = {
          change,
          phase,
          currentStep: diagnostic.currentStep,
          runtimeEval: diagnostic.runtimeEval,
        };
      }
      output.stderr.push(PHASE_HEADER[phase]);

      let blocked: boolean;
      if (phase === 'open') blocked = await guardOpenChecks(output, changeDir);
      else if (phase === 'design') blocked = await guardDesignChecks(output, changeDir, change);
      else if (phase === 'build')
        blocked = await guardBuildChecks(output, changeDir, change, runContext.run);
      else if (phase === 'verify')
        blocked = await guardVerifyChecks(output, changeDir, change, runContext.run);
      else blocked = await guardArchiveChecks(output, changeDir, change);

      if (blocked) {
        output.stderr.push('');
        output.stderr.push(red('BLOCKED — fix failing checks before proceeding to next phase'));
        return output.toResult(1);
      }
      output.stderr.push('');
      output.stderr.push(green('ALL CHECKS PASSED — ready for next phase'));
      if (flag === '--apply') {
        await applyStateUpdate(output, change, changeDir, phase);
      }
      return output.toResult(0);
    } catch (error) {
      if (error instanceof GuardFailure) {
        for (const line of error.message.split('\n')) output.stderr.push(line);
        return output.toResult(error.exitCode);
      }
      throw error;
    }
  });
