import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

import {
  OWNER_RESUME_PROBE_SCHEMA_VERSION as PIPELINE_RESUME_PROBE_SCHEMA_VERSION,
  resolveOwnerResumeProbe as resolvePipelineResumeProbe,
  type OwnerResumeProbeAction,
  type OwnerResumeProbeConfidence,
  type OwnerResumeProbeEvidence,
  type OwnerResumeProbeInput as PipelineResumeProbeInput,
} from '../owner-pipeline/pipeline-resume-probe.js';
import {
  inspectLoopChangeStateDocument,
  loopChangeDir,
  readLoopChange,
} from '../owner-loop/loop-change.js';
import { assertNoPendingLoopRootMove } from '../owner-loop/loop-config.js';
import {
  inspectLoopArtifactFindings,
  listLoopChangeNames,
  LOOP_STATUS_PAGE_LIMITS,
} from '../owner-loop/loop-diagnostics.js';
import { loopProjectPaths } from '../owner-loop/loop-paths.js';
import {
  isLoopPortableChange,
  loopPortableChangeDir,
  readLoopPortableChange,
} from '../owner-loop/loop-portable-runtime.js';
import {
  inspectLoopPortableStatus,
  type LoopPortableStatusProjection,
} from '../owner-loop/loop-portable-status.js';
import { runWithHookReadCache } from '../../platform/process/hook-read-cache.js';
import { discoverCachedLoopProject, readCachedProjectConfig } from './entry-reads.js';
import { readLoopSelectionRecord } from '../owner-loop/loop-selection.js';
import { readLoopProposedSpecs } from '../owner-loop/loop-specs.js';
import type { LoopChangeState, LoopFinding, LoopProjectPaths } from '../owner-loop/loop-types.js';
import type { LoopPortableState } from '../owner-loop/loop-portable-types.js';
import { resolveOwnerEntry } from './resolve-entry.js';
import type { OwnerEntryResolutionSource, OwnerEntrySkill, OwnerWorkflow } from './types.js';

export const OWNER_RESUME_PROBE_SCHEMA_VERSION = 'owner.resume_probe.v2' as const;

export interface OwnerEntryResumeProbeInput {
  schema_version: typeof OWNER_RESUME_PROBE_SCHEMA_VERSION;
  utterance: string;
  locale: string;
  agent_context: {
    non_trivial_work: boolean;
    already_in_owner_flow: boolean;
  };
}

export interface OwnerEntryResumeProbeCandidate {
  name: string;
  phase: string;
  selected: boolean;
}

export interface OwnerEntryResumeProbeResult {
  schema_version: typeof OWNER_RESUME_PROBE_SCHEMA_VERSION;
  workflow: OwnerWorkflow | null;
  skill: OwnerEntrySkill | null;
  entrySource: OwnerEntryResolutionSource | null;
  action: OwnerResumeProbeAction;
  changeName: string | null;
  phase: string | null;
  nextCommand: '/owner-loop' | '/owner-pipeline' | null;
  confidence: OwnerResumeProbeConfidence;
  reasonCode: string;
  reason: string;
  evidence: OwnerResumeProbeEvidence[];
  candidates: OwnerEntryResumeProbeCandidate[];
}

interface ResultOptions {
  workflow?: OwnerWorkflow | null;
  skill?: OwnerEntrySkill | null;
  entrySource?: OwnerEntryResolutionSource | null;
  action: OwnerResumeProbeAction;
  change?: { name: string; phase: string } | null;
  confidence: OwnerResumeProbeConfidence;
  reasonCode: string;
  reason: string;
  evidence?: OwnerResumeProbeEvidence[];
  candidates?: OwnerEntryResumeProbeCandidate[];
}

const RESUME_WORDS = [
  'continue',
  'resume',
  'carry on',
  'finish',
  '继续',
  '接着',
  '恢复',
  '跑完',
  '提交',
  '验证',
  '归档',
  '修刚才',
] as const;

const OPT_OUT_WORDS = [
  'do not resume',
  "don't resume",
  'without owner',
  'skip owner',
  '不要恢复',
  '不走 owner',
  '不要走 owner',
  '直接解释',
  '只回答',
] as const;

const GENERIC_RELATED_TOKENS = new Set([
  'acceptance',
  'build',
  'change',
  'constraints',
  'decisions',
  'implementation',
  'loop',
  'non-goals',
  'outcome',
  'questions',
  'scope',
  'specification',
  'verification',
]);

const RESUMABLE_LOOP_FINDING_CODES = new Set([
  'run-action-pending',
  'transition-incomplete',
  'verification-report-missing',
]);

function blockingLoopResumeFinding(findings: LoopFinding[]): LoopFinding | null {
  return findings.find((finding) => !RESUMABLE_LOOP_FINDING_CODES.has(finding.code)) ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeInput(input: unknown): OwnerEntryResumeProbeInput {
  if (!isRecord(input)) {
    throw new Error('Invalid OwnerEntryResumeProbeInput: input must be an object');
  }
  if (input.schema_version !== OWNER_RESUME_PROBE_SCHEMA_VERSION) {
    throw new Error(
      `Invalid OwnerEntryResumeProbeInput: schema_version must be ${OWNER_RESUME_PROBE_SCHEMA_VERSION}`,
    );
  }
  if (typeof input.utterance !== 'string') {
    throw new Error('Invalid OwnerEntryResumeProbeInput: utterance must be a string');
  }
  const context = isRecord(input.agent_context) ? input.agent_context : {};
  return {
    schema_version: OWNER_RESUME_PROBE_SCHEMA_VERSION,
    utterance: input.utterance,
    locale: typeof input.locale === 'string' ? input.locale : 'unknown',
    agent_context: {
      non_trivial_work: context.non_trivial_work === true,
      already_in_owner_flow: context.already_in_owner_flow === true,
    },
  };
}

function result(options: ResultOptions): OwnerEntryResumeProbeResult {
  const nextCommand =
    options.action === 'auto_resume'
      ? options.skill === 'owner-loop'
        ? '/owner-loop'
        : options.skill === 'owner-pipeline'
          ? '/owner-pipeline'
          : null
      : null;
  return {
    schema_version: OWNER_RESUME_PROBE_SCHEMA_VERSION,
    workflow: options.workflow ?? null,
    skill: options.skill ?? null,
    entrySource: options.entrySource ?? null,
    action: options.action,
    changeName: options.change?.name ?? null,
    phase: options.change?.phase ?? null,
    nextCommand,
    confidence: options.confidence,
    reasonCode: options.reasonCode,
    reason: options.reason,
    evidence: options.evidence ?? [],
    candidates: options.candidates ?? [],
  };
}

function includesAny(text: string, words: readonly string[]): boolean {
  return words.some((word) => text.includes(word));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function namesInUtterance(utterance: string, names: readonly string[]): string[] {
  const lower = utterance.toLowerCase();
  return names.filter((name) => {
    const pattern = new RegExp(
      `(?:^|[^a-z0-9_-])${escapeRegExp(name.toLowerCase())}(?=$|[^a-z0-9_-])`,
      'u',
    );
    return pattern.test(lower);
  });
}

async function loopResumeCandidates(
  paths: LoopProjectPaths,
  names: readonly string[],
  selectedName: string | null,
  targetName: string | null,
): Promise<OwnerEntryResumeProbeCandidate[]> {
  const displayedNames = names.slice(0, LOOP_STATUS_PAGE_LIMITS.maxItems);
  if (targetName && !displayedNames.includes(targetName)) {
    if (displayedNames.length === LOOP_STATUS_PAGE_LIMITS.maxItems) displayedNames.pop();
    displayedNames.push(targetName);
  }
  return Promise.all(
    displayedNames.map(async (name) => {
      try {
        if (await isLoopPortableChange(paths, name)) {
          const state = await readLoopPortableChange(paths, name);
          return {
            name,
            phase: state.phase,
            selected: name === selectedName,
          };
        }
        const inspection = await inspectLoopChangeStateDocument(paths, name);
        return {
          name,
          phase: inspection.state?.phase ?? 'invalid',
          selected: name === selectedName,
        };
      } catch {
        return { name, phase: 'invalid', selected: name === selectedName };
      }
    }),
  );
}

async function loopRelatedEvidence(
  paths: LoopProjectPaths,
  change: { name: string; phase: string },
  state: LoopChangeState | LoopPortableState,
  utterance: string,
): Promise<OwnerResumeProbeEvidence[]> {
  let source: string;
  try {
    const portable = state.schema === 'owner.loop.v4';
    const specs = portable
      ? Object.fromEntries(
          await Promise.all(
            state.spec_changes
              .filter((entry): entry is typeof entry & { source: string } => entry.source !== null)
              .map(async (entry) => [
                entry.capability,
                await fs.readFile(
                  path.join(loopPortableChangeDir(paths, change.name), entry.source),
                  'utf8',
                ),
              ]),
          ),
        )
      : await readLoopProposedSpecs(paths, change.name);
    const changeDirectory = portable
      ? loopPortableChangeDir(paths, change.name)
      : loopChangeDir(paths, change.name);
    source = [
      change.name,
      await fs.readFile(path.join(changeDirectory, state.brief), 'utf8'),
      ...Object.keys(specs),
      ...Object.values(specs),
    ]
      .join('\n')
      .toLowerCase();
  } catch {
    return [];
  }
  const lower = utterance.toLowerCase();
  const tokens = source
    .split(/[^a-zA-Z0-9_\-\u4e00-\u9fff/]+/u)
    .map((token) => token.trim())
    .filter((token) => {
      if (GENERIC_RELATED_TOKENS.has(token)) return false;
      return /^[\u4e00-\u9fff]+$/u.test(token) ? token.length >= 2 : token.length >= 4;
    });
  return [...new Set(tokens.filter((token) => lower.includes(token)))]
    .slice(0, 3)
    .map((token) => ({ source: 'repo' as const, quote: token }));
}

async function gitDirtyFiles(projectRoot: string): Promise<string[]> {
  return new Promise((resolve) => {
    const child = spawn('git', ['status', '--short', '--untracked-files=all'], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: false,
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    child.on('error', () => resolve([]));
    child.on('exit', (code) => {
      if (code !== 0) {
        resolve([]);
        return;
      }
      resolve(
        Buffer.concat(chunks)
          .toString('utf8')
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter(Boolean),
      );
    });
  });
}

function mapPipelineResult(
  pipeline: Awaited<ReturnType<typeof resolvePipelineResumeProbe>>,
  entrySource: OwnerEntryResolutionSource,
): OwnerEntryResumeProbeResult {
  return result({
    workflow: 'pipeline',
    skill: 'owner-pipeline',
    entrySource,
    action: pipeline.action,
    change:
      pipeline.changeName && pipeline.phase
        ? { name: pipeline.changeName, phase: pipeline.phase }
        : null,
    confidence: pipeline.confidence,
    reasonCode: `pipeline-${pipeline.action.replaceAll('_', '-')}`,
    reason: pipeline.reason,
    evidence: pipeline.evidence,
    candidates:
      pipeline.changeName && pipeline.phase
        ? [{ name: pipeline.changeName, phase: pipeline.phase, selected: false }]
        : [],
  });
}

async function resolveLoopResumeProbe(
  projectRoot: string,
  input: OwnerEntryResumeProbeInput,
  entrySource: OwnerEntryResolutionSource,
): Promise<OwnerEntryResumeProbeResult> {
  const config = await readCachedProjectConfig(projectRoot);
  if (!config?.loop) {
    throw new Error('.owner/config.yaml has no Loop configuration after resolving Loop entry');
  }
  await assertNoPendingLoopRootMove(projectRoot);
  const paths = await loopProjectPaths(projectRoot, config.loop.artifact_root);
  const names = await listLoopChangeNames(paths);
  let selectedName: string | null = null;
  let selectionError: string | null = null;
  try {
    const selection = await readLoopSelectionRecord(paths);
    if (selection && names.includes(selection.change)) {
      selectedName = selection.change;
    } else if (selection) {
      selectionError = `ENOENT: selected Loop change ${selection.change} is missing or archived`;
    }
  } catch (error) {
    selectionError = error instanceof Error ? error.message : String(error);
  }
  if (names.length === 0) {
    return result({
      workflow: 'loop',
      skill: 'owner-loop',
      entrySource,
      action: 'none',
      confidence: 'none',
      reasonCode: 'no-active-loop-changes',
      reason: 'no active Loop changes',
      candidates: [],
    });
  }

  const utterance = input.utterance.trim();
  const lower = utterance.toLowerCase();
  const resumeLike = includesAny(lower, RESUME_WORDS);
  const named = namesInUtterance(utterance, names);
  const targetName = named[0] ?? selectedName ?? (names.length === 1 ? names[0] : null);
  const candidates = await loopResumeCandidates(paths, names, selectedName, targetName);
  if (!input.agent_context.non_trivial_work && !resumeLike) {
    return result({
      workflow: 'loop',
      skill: 'owner-loop',
      entrySource,
      action: 'out_of_scope',
      confidence: 'low',
      reasonCode: 'request-not-workflow-work',
      reason: 'request is informational rather than workflow work',
      candidates,
    });
  }

  if (named.length > 1) {
    return result({
      workflow: 'loop',
      skill: 'owner-loop',
      entrySource,
      action: 'ask_user',
      confidence: 'low',
      reasonCode: 'multiple-loop-changes-named',
      reason: 'request names multiple active Loop changes',
      evidence: named.map((name) => ({ source: 'user', quote: name })),
      candidates,
    });
  }

  if (!targetName) {
    return result({
      workflow: 'loop',
      skill: 'owner-loop',
      entrySource,
      action: resumeLike ? 'ask_user' : 'out_of_scope',
      confidence: 'low',
      reasonCode: resumeLike ? 'multiple-loop-changes' : 'request-unrelated',
      reason: resumeLike
        ? 'multiple active Loop changes require an explicit name or Loop selection'
        : 'request does not identify an active Loop change',
      ...(selectionError
        ? { evidence: [{ source: 'state' as const, quote: selectionError }] }
        : {}),
      candidates,
    });
  }

  const target = candidates.find((change) => change.name === targetName);
  let targetState: LoopChangeState | LoopPortableState | null = null;
  let targetPortableStatus: LoopPortableStatusProjection | null = null;
  let targetStateError: string | null = null;
  if (target) {
    try {
      if (await isLoopPortableChange(paths, target.name)) {
        targetState = await readLoopPortableChange(paths, target.name);
        targetPortableStatus = await inspectLoopPortableStatus({ paths, name: target.name });
      } else {
        targetState = await readLoopChange(paths, target.name);
      }
    } catch (error) {
      targetStateError = error instanceof Error ? error.message : String(error);
    }
  }
  if (!target || targetStateError || !targetState) {
    if (!resumeLike && named.length === 0) {
      return result({
        workflow: 'loop',
        skill: 'owner-loop',
        entrySource,
        action: 'out_of_scope',
        change: { name: targetName, phase: target?.phase ?? 'invalid' },
        confidence: 'low',
        reasonCode: 'request-unrelated',
        reason: 'request does not identify the invalid Loop change as its resume target',
        candidates,
      });
    }
    return result({
      workflow: 'loop',
      skill: 'owner-loop',
      entrySource,
      action: 'ask_user',
      change: { name: targetName, phase: target?.phase ?? 'invalid' },
      confidence: 'low',
      reasonCode: 'loop-change-invalid',
      reason: targetStateError ?? `selected Loop change ${targetName} is unavailable`,
      evidence: [{ source: 'state', quote: `change: ${targetName}` }],
      candidates,
    });
  }

  const exactName = named[0] === target.name;
  const related =
    !resumeLike && !exactName
      ? await loopRelatedEvidence(paths, target, targetState, utterance)
      : [];
  if (!resumeLike && !exactName && related.length === 0) {
    return result({
      workflow: 'loop',
      skill: 'owner-loop',
      entrySource,
      action: 'out_of_scope',
      change: { name: target.name, phase: target.phase },
      confidence: 'low',
      reasonCode: 'request-unrelated',
      reason: 'request does not appear related to the active Loop change',
      candidates,
    });
  }

  if (targetPortableStatus?.workspace.bindingState === 'mismatch') {
    return result({
      workflow: 'loop',
      skill: 'owner-loop',
      entrySource,
      action: 'ask_user',
      change: { name: target.name, phase: target.phase },
      confidence: 'low',
      reasonCode: 'loop-workspace-mismatch',
      reason: targetPortableStatus.workspace.message ?? 'Loop workspace binding is invalid',
      evidence: [{ source: 'state', quote: `change: ${target.name}` }],
      candidates,
    });
  }

  const blockingFinding =
    targetState.schema === 'owner.loop.v4'
      ? null
      : blockingLoopResumeFinding(await inspectLoopArtifactFindings(paths, targetState));
  if (blockingFinding) {
    return result({
      workflow: 'loop',
      skill: 'owner-loop',
      entrySource,
      action: 'ask_user',
      change: { name: target.name, phase: target.phase },
      confidence: 'low',
      reasonCode: 'loop-change-invalid',
      reason: blockingFinding.message,
      evidence: [
        { source: 'state', quote: `change: ${target.name}` },
        { source: 'state', quote: `finding: ${blockingFinding.code}` },
      ],
      candidates,
    });
  }

  const dirtyFiles = await gitDirtyFiles(projectRoot);
  return result({
    workflow: 'loop',
    skill: 'owner-loop',
    entrySource,
    action: 'auto_resume',
    change: { name: target.name, phase: target.phase },
    confidence: 'high',
    reasonCode: exactName
      ? 'loop-change-named'
      : selectedName === target.name
        ? 'loop-change-selected'
        : 'single-loop-change-related',
    reason: 'configured Loop workflow has one unambiguous related resume target',
    evidence: [
      { source: 'state', quote: `phase: ${target.phase}` },
      ...(exactName ? [{ source: 'user' as const, quote: target.name }] : related),
      ...(selectionError ? [{ source: 'state' as const, quote: selectionError }] : []),
      ...(dirtyFiles.length > 0
        ? [{ source: 'repo' as const, quote: `${dirtyFiles.length} dirty file(s)` }]
        : []),
    ],
    candidates,
  });
}

export async function resolveOwnerEntryResumeProbe(
  startPath: string,
  rawInput: unknown,
): Promise<OwnerEntryResumeProbeResult> {
  // Activate a per-invocation read cache so the project-root discovery and
  // config read below are shared with `resolveOwnerEntry` and the per-workflow
  // resolvers instead of being repeated 2-3 times.
  return runWithHookReadCache(() => resolveOwnerEntryResumeProbeImpl(startPath, rawInput));
}

async function resolveOwnerEntryResumeProbeImpl(
  startPath: string,
  rawInput: unknown,
): Promise<OwnerEntryResumeProbeResult> {
  const input = normalizeInput(rawInput);
  const utterance = input.utterance.trim();
  const lower = utterance.toLowerCase();
  if (input.agent_context.already_in_owner_flow) {
    return result({
      action: 'out_of_scope',
      confidence: 'low',
      reasonCode: 'already-in-owner-flow',
      reason: 'already in Owner flow',
    });
  }
  if (includesAny(lower, OPT_OUT_WORDS)) {
    return result({
      action: 'out_of_scope',
      confidence: 'low',
      reasonCode: 'user-opted-out',
      reason: 'user opted out of Owner resume',
      evidence: [{ source: 'user', quote: utterance }],
    });
  }

  let projectRoot: string;
  let entry: Awaited<ReturnType<typeof resolveOwnerEntry>>;
  try {
    projectRoot = await discoverCachedLoopProject(startPath);
    // Read config once here; the cached read is reused by resolveOwnerEntry
    // and the per-workflow resolvers below, instead of each re-opening the
    // file. Check ambient_resume on the same cached config.
    const ambientConfig = await readCachedProjectConfig(projectRoot);
    if (ambientConfig !== null && !ambientConfig.ambient_resume) {
      return result({
        action: 'out_of_scope',
        confidence: 'none',
        reasonCode: 'ambient-resume-disabled',
        reason: 'Ambient Resume is disabled by .owner/config.yaml',
        evidence: [{ source: 'state', quote: 'ambient_resume: false' }],
      });
    }
    entry = await resolveOwnerEntry(projectRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return result({
      action: 'ask_user',
      confidence: 'low',
      reasonCode: 'project-config-invalid',
      reason: message,
      evidence: [{ source: 'state', quote: message }],
    });
  }

  if (entry.workflow === 'pipeline') {
    const pipelineInput: PipelineResumeProbeInput = {
      schema_version: PIPELINE_RESUME_PROBE_SCHEMA_VERSION,
      utterance: input.utterance,
      locale: input.locale,
      agent_context: input.agent_context,
    };
    try {
      return mapPipelineResult(
        await resolvePipelineResumeProbe(projectRoot, pipelineInput),
        entry.source,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return result({
        workflow: 'pipeline',
        skill: 'owner-pipeline',
        entrySource: entry.source,
        action: 'ask_user',
        confidence: 'low',
        reasonCode: 'pipeline-state-invalid',
        reason: message,
        evidence: [{ source: 'state', quote: message }],
      });
    }
  }

  try {
    return await resolveLoopResumeProbe(projectRoot, input, entry.source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return result({
      workflow: 'loop',
      skill: 'owner-loop',
      entrySource: entry.source,
      action: 'ask_user',
      confidence: 'low',
      reasonCode: 'loop-state-invalid',
      reason: message,
      evidence: [{ source: 'state', quote: message }],
    });
  }
}
