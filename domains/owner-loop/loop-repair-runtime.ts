import type { TrajectoryEvent } from '../engine/types.js';
import { canonicalHash } from './loop-canonical-hash.js';
import {
  buildLoopRepairSignature,
  decideLoopRepairOverride,
  decideLoopRepairStagnation,
  hashLoopRepairOverrideSummary,
  loopRepairConsecutiveFailures,
  LOOP_REPAIR_STAGNATION_LIMITS,
  normalizeLoopRepairFailedCheckIds,
  type LoopRepairFailureFacts,
  type LoopRepairHistoryRecord,
  type LoopRepairOverrideRequest,
  type LoopRepairStagnationDecision,
} from './loop-repair-stagnation.js';
import {
  parseLoopVerificationEvidenceEnvelope,
  type LoopVerificationEvidenceEnvelope,
} from './loop-verification-evidence.js';
import {
  parseLoopImplementationScopeBundle,
  type LoopImplementationScopeBundle,
} from './loop-verification-scope.js';
import { LOOP_TRAJECTORY_MAX_TEXT_CHARACTERS } from './loop-trajectory-limits.js';

export const LOOP_REPAIR_TRAJECTORY_FIELD = 'repairStagnation' as const;
export const LOOP_REPAIR_TRAJECTORY_LIMITS = {
  maxEvents: 4_096,
  maxDataDepth: 8,
  maxDataNodes: 4_096,
  maxTotalDataNodes: 65_536,
  maxObjectFields: 64,
  maxArrayEntries: 256,
  maxKeyCharacters: 128,
  maxTextCharacters: LOOP_TRAJECTORY_MAX_TEXT_CHARACTERS,
  maxEventDataCharacters: 65_536,
  maxTotalDataCharacters: 1_048_576,
  maxRunIdCharacters: 256,
} as const;

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const REPAIR_SCOPE_HASH_TAG = 'owner.loop.repair-scope.v1';
const EVENT_TYPES = new Set<TrajectoryEvent['type']>([
  'run_started',
  'action_proposed',
  'action_completed',
  'eval_completed',
  'checkpoint',
  'state_migrated',
  'state_transitioned',
  'command_check_recorded',
  'recovery_reconciled',
]);
const EVENT_KEYS = ['data', 'runId', 'sequence', 'timestamp', 'type'] as const;
const LEGACY_PROJECTION_KEYS = ['disposition', 'overrideSummaryHash', 'signatureHash'] as const;
const PROJECTION_KEYS = [
  'contractHash',
  'disposition',
  'failedAcceptanceIds',
  'failedCheckIds',
  'maxVerifyFailures',
  'overrideSummaryHash',
  'signatureHash',
] as const;
const LEGACY_MAX_REPAIR_ITERATIONS = 12;

export interface LoopRepairTrajectoryProjection {
  signatureHash: string;
  disposition: 'continue' | 'warn' | 'manual-stop' | 'hard-stop';
  overrideSummaryHash: string | null;
  contractHash: string | null;
  failedAcceptanceIds: string[];
  failedCheckIds: string[];
  maxVerifyFailures: number | null;
}

export interface LoopCommittedRepairTrajectory {
  trajectory: readonly unknown[];
  committedTrajectoryOffset: number;
  runId: string;
}

export interface LoopRepairEvidenceInput {
  envelope: LoopVerificationEvidenceEnvelope;
  implementationScope: LoopImplementationScopeBundle;
  failedCheckIds?: readonly string[];
}

export interface LoopRepairRuntimeInput
  extends LoopCommittedRepairTrajectory, LoopRepairEvidenceInput {
  maxVerifyFailures: number;
}

export interface LoopRepairRuntimeResult {
  facts: LoopRepairFailureFacts;
  history: LoopRepairHistoryRecord[];
  decision: LoopRepairStagnationDecision;
  eventProjection: LoopRepairTrajectoryProjection | null;
}

export interface LoopRepairResumeInput extends LoopRepairRuntimeInput {
  currentImplementationScope: LoopImplementationScopeBundle;
}

export interface LoopRepairResumeInspection {
  disposition: 'proceed' | 'override-required' | 'hard-stop';
  reason:
    | 'scope-progress'
    | 'no-stopped-failure'
    | 'override-required'
    | 'override-already-applied'
    | 'hard-stop';
  signatureHash: string;
  history: LoopRepairHistoryRecord[];
}

export interface LoopRepairOverrideProjectionResult {
  history: LoopRepairHistoryRecord[];
  eventProjection: LoopRepairTrajectoryProjection;
}

interface LoopRepairHistoryProjection {
  history: LoopRepairHistoryRecord[];
  latestProjection: LoopRepairTrajectoryProjection | null;
}

interface DataBudget {
  nodes: number;
  characters: number;
  ancestors: Set<object>;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort(compareText);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} fields are invalid`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function hash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    throw new Error(`${label} must be a SHA-256 hash`);
  }
  return value;
}

function failedAcceptanceIds(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > LOOP_REPAIR_STAGNATION_LIMITS.maxFailedAcceptanceIds ||
    value.some((entry) => typeof entry !== 'string' || !/^acceptance-[a-f0-9]{64}$/u.test(entry))
  ) {
    throw new Error('Loop repair trajectory failed acceptance IDs are invalid');
  }
  return [...new Set(value as string[])].sort(compareText);
}

/**
 * Identify repair progress from the executable contract and project snapshot, not from
 * content-addressed evidence prose such as `noCodeReason`.
 */
export function loopRepairScopeHash(bundle: LoopImplementationScopeBundle): string {
  const scope = parseLoopImplementationScopeBundle(bundle).scope;
  return canonicalHash(REPAIR_SCOPE_HASH_TAG, {
    schema: REPAIR_SCOPE_HASH_TAG,
    contractHash: scope.contractHash,
    artifactSnapshotHash: scope.currentProjectionHash,
  });
}

function boundedRunId(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > LOOP_REPAIR_TRAJECTORY_LIMITS.maxRunIdCharacters ||
    Array.from(value).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new Error('Loop repair trajectory run ID is invalid');
  }
  return value;
}

function boundedData(
  value: unknown,
  depth: number,
  budget: DataBudget,
  label: string,
  legacyTransitionText = false,
): void {
  budget.nodes += 1;
  if (budget.nodes > LOOP_REPAIR_TRAJECTORY_LIMITS.maxDataNodes) {
    throw new Error('Loop repair trajectory event data exceeds its node boundary');
  }
  if (depth > LOOP_REPAIR_TRAJECTORY_LIMITS.maxDataDepth) {
    throw new Error('Loop repair trajectory event data exceeds its depth boundary');
  }
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} contains a non-finite number`);
    }
    return;
  }
  if (typeof value === 'string') {
    if (
      value.length > LOOP_REPAIR_TRAJECTORY_LIMITS.maxTextCharacters &&
      (!legacyTransitionText || value.length > LOOP_REPAIR_TRAJECTORY_LIMITS.maxEventDataCharacters)
    ) {
      throw new Error(`${label} contains oversized text`);
    }
    budget.characters += value.length;
    if (budget.characters > LOOP_REPAIR_TRAJECTORY_LIMITS.maxEventDataCharacters) {
      throw new Error('Loop repair trajectory event data exceeds its text boundary');
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new Error(`${label} contains a non-JSON value`);
  }
  if (budget.ancestors.has(value)) throw new Error(`${label} contains a cycle`);
  budget.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > LOOP_REPAIR_TRAJECTORY_LIMITS.maxArrayEntries) {
        throw new Error(`${label} contains an oversized array`);
      }
      value.forEach((entry, index) => boundedData(entry, depth + 1, budget, `${label}[${index}]`));
      return;
    }
    const object = record(value, label);
    const keys = Object.keys(object);
    if (keys.length > LOOP_REPAIR_TRAJECTORY_LIMITS.maxObjectFields) {
      throw new Error(`${label} contains too many fields`);
    }
    for (const key of keys) {
      if (key.length === 0 || key.length > LOOP_REPAIR_TRAJECTORY_LIMITS.maxKeyCharacters) {
        throw new Error(`${label} contains an invalid field name`);
      }
      budget.characters += key.length;
      if (budget.characters > LOOP_REPAIR_TRAJECTORY_LIMITS.maxEventDataCharacters) {
        throw new Error('Loop repair trajectory event data exceeds its text boundary');
      }
      boundedData(
        object[key],
        depth + 1,
        budget,
        `${label}.${key}`,
        depth === 0 && (key === 'summary' || key === 'noCodeReason'),
      );
    }
  } finally {
    budget.ancestors.delete(value);
  }
}

function parseTimestamp(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64) {
    throw new Error('Loop repair trajectory timestamp is invalid');
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error('Loop repair trajectory timestamp is invalid');
  }
  return value;
}

function parseEvent(
  value: unknown,
  index: number,
  runId: string,
): { event: TrajectoryEvent; dataNodes: number; dataCharacters: number } {
  const event = record(value, `Loop repair trajectory event ${index + 1}`);
  exactKeys(event, EVENT_KEYS, `Loop repair trajectory event ${index + 1}`);
  if (!Number.isSafeInteger(event.sequence) || event.sequence !== index + 1) {
    throw new Error('Loop repair trajectory sequence is invalid');
  }
  parseTimestamp(event.timestamp);
  if (typeof event.type !== 'string' || !EVENT_TYPES.has(event.type as TrajectoryEvent['type'])) {
    throw new Error('Loop repair trajectory event type is invalid');
  }
  if (boundedRunId(event.runId as string) !== runId) {
    throw new Error('Loop repair trajectory run ID changed inside the committed prefix');
  }
  const budget = { nodes: 0, characters: 0, ancestors: new Set<object>() };
  boundedData(event.data, 0, budget, 'Loop trajectory event data');
  record(event.data, 'Loop repair trajectory event data');
  return {
    event: event as unknown as TrajectoryEvent,
    dataNodes: budget.nodes,
    dataCharacters: budget.characters,
  };
}

export function parseLoopRepairTrajectoryProjection(
  value: unknown,
): LoopRepairTrajectoryProjection {
  const projection = record(value, 'Loop repair trajectory projection');
  const keys = Object.keys(projection).sort(compareText);
  const legacy =
    keys.length === LEGACY_PROJECTION_KEYS.length &&
    keys.every((key, index) => key === LEGACY_PROJECTION_KEYS[index]);
  if (!legacy) {
    exactKeys(projection, PROJECTION_KEYS, 'Loop repair trajectory projection');
  }
  const signatureHash = hash(projection.signatureHash, 'Loop repair trajectory signature hash');
  if (
    projection.disposition !== 'continue' &&
    projection.disposition !== 'warn' &&
    projection.disposition !== 'manual-stop' &&
    projection.disposition !== 'hard-stop'
  ) {
    throw new Error('Loop repair trajectory disposition is invalid');
  }
  const overrideSummaryHash =
    projection.overrideSummaryHash === null
      ? null
      : hash(projection.overrideSummaryHash, 'Loop repair trajectory override summary hash');
  if (overrideSummaryHash !== null && projection.disposition !== 'continue') {
    throw new Error('Loop repair trajectory override must continue exactly once');
  }
  if (legacy) {
    return {
      signatureHash,
      disposition: projection.disposition,
      overrideSummaryHash,
      contractHash: null,
      failedAcceptanceIds: [],
      failedCheckIds: [],
      maxVerifyFailures: null,
    };
  }
  const contractHash = hash(projection.contractHash, 'Loop repair trajectory contract hash');
  const normalizedFailedAcceptanceIds = failedAcceptanceIds(projection.failedAcceptanceIds);
  const failedCheckIds = normalizeLoopRepairFailedCheckIds(projection.failedCheckIds as string[]);
  if (
    !Number.isSafeInteger(projection.maxVerifyFailures) ||
    (projection.maxVerifyFailures as number) < 1
  ) {
    throw new Error('Loop repair trajectory maximum Verify failures is invalid');
  }
  return {
    signatureHash,
    disposition: projection.disposition,
    overrideSummaryHash,
    contractHash,
    failedAcceptanceIds: normalizedFailedAcceptanceIds,
    failedCheckIds,
    maxVerifyFailures: projection.maxVerifyFailures as number,
  };
}

function assertProjectionTransition(
  data: Record<string, unknown>,
  projection: LoopRepairTrajectoryProjection,
): void {
  if (projection.overrideSummaryHash === null) {
    if (
      data.previousPhase !== 'verify' ||
      data.nextPhase !== 'build' ||
      data.verificationResult !== 'fail'
    ) {
      throw new Error(
        'Loop repair failure projection is only valid on a failed Verify-to-Build transition',
      );
    }
    return;
  }
  if (
    projection.disposition !== 'continue' ||
    data.previousPhase !== 'build' ||
    data.nextPhase !== 'verify' ||
    data.verificationResult !== null
  ) {
    throw new Error(
      'Loop repair override projection is only valid on a Build-to-Verify transition',
    );
  }
}

function assertCommittedFailureProjection(
  projection: LoopRepairTrajectoryProjection,
  history: readonly LoopRepairHistoryRecord[],
): void {
  const failures = history.filter((entry) => entry.kind === 'failure');
  const total = failures.length + 1;
  const maxVerifyFailures = projection.maxVerifyFailures ?? LEGACY_MAX_REPAIR_ITERATIONS;
  if (total > maxVerifyFailures) {
    throw new Error('Loop repair trajectory commits a failure beyond the hard-stop boundary');
  }
  const consecutive = loopRepairConsecutiveFailures(
    {
      signatureHash: projection.signatureHash,
      ...(projection.contractHash === null
        ? {}
        : {
            failedAcceptanceIds: projection.failedAcceptanceIds,
            failedCheckIds: projection.failedCheckIds,
          }),
    },
    failures,
  );
  const expectedDisposition =
    total >= maxVerifyFailures
      ? 'hard-stop'
      : consecutive < LOOP_REPAIR_STAGNATION_LIMITS.warningAtConsecutiveFailures
        ? 'continue'
        : consecutive < LOOP_REPAIR_STAGNATION_LIMITS.manualStopAtConsecutiveFailures
          ? 'warn'
          : 'manual-stop';
  if (projection.disposition !== expectedDisposition || projection.overrideSummaryHash !== null) {
    throw new Error(
      `Loop repair trajectory failure disposition is invalid: expected ${expectedDisposition}`,
    );
  }
}

function assertCommittedOverrideProjection(
  projection: LoopRepairTrajectoryProjection,
  history: readonly LoopRepairHistoryRecord[],
  latestProjection: LoopRepairTrajectoryProjection | null,
): void {
  const failures = history.filter((entry) => entry.kind === 'failure');
  const maxVerifyFailures = latestProjection?.maxVerifyFailures ?? LEGACY_MAX_REPAIR_ITERATIONS;
  if (failures.length >= maxVerifyFailures) {
    throw new Error('Loop repair trajectory cannot override a hard stop');
  }
  if (
    latestProjection?.disposition !== 'manual-stop' ||
    latestProjection.signatureHash !== projection.signatureHash ||
    failures.at(-1)?.signatureHash !== projection.signatureHash
  ) {
    throw new Error('Loop repair trajectory override does not match the latest manual stop');
  }
  if (
    history.some(
      (entry) => entry.kind === 'override' && entry.signatureHash === projection.signatureHash,
    )
  ) {
    throw new Error('Loop repair trajectory signature was already overridden');
  }
}

function projectLoopRepairHistory(
  options: LoopCommittedRepairTrajectory,
): LoopRepairHistoryProjection {
  if (
    !Array.isArray(options.trajectory) ||
    options.trajectory.length > LOOP_REPAIR_TRAJECTORY_LIMITS.maxEvents
  ) {
    throw new Error('Loop repair trajectory exceeds its event boundary');
  }
  const runId = boundedRunId(options.runId);
  if (
    !Number.isSafeInteger(options.committedTrajectoryOffset) ||
    options.committedTrajectoryOffset < 0 ||
    options.committedTrajectoryOffset > options.trajectory.length
  ) {
    throw new Error('Loop repair committed trajectory offset is invalid');
  }
  const history: LoopRepairHistoryRecord[] = [];
  let latestProjection: LoopRepairTrajectoryProjection | null = null;
  let activeScopeHash: string | null = null;
  let activeContractHash: string | null = null;
  let iteration = 0;
  let totalDataNodes = 0;
  let totalDataCharacters = 0;
  for (let index = 0; index < options.committedTrajectoryOffset; index += 1) {
    const parsed = parseEvent(options.trajectory[index], index, runId);
    const { event } = parsed;
    totalDataNodes += parsed.dataNodes;
    totalDataCharacters += parsed.dataCharacters;
    if (
      totalDataNodes > LOOP_REPAIR_TRAJECTORY_LIMITS.maxTotalDataNodes ||
      totalDataCharacters > LOOP_REPAIR_TRAJECTORY_LIMITS.maxTotalDataCharacters
    ) {
      throw new Error('Loop repair committed trajectory exceeds its aggregate data boundary');
    }
    const data = event.data;
    const eventScopeHash = Object.hasOwn(data, 'repairScopeHash')
      ? hash(data.repairScopeHash, 'Loop repair trajectory repair scope hash')
      : Object.hasOwn(data, 'implementationScopeHash')
        ? hash(data.implementationScopeHash, 'Loop repair trajectory implementation scope hash')
        : null;
    if (!Object.hasOwn(data, LOOP_REPAIR_TRAJECTORY_FIELD)) {
      if (
        latestProjection?.contractHash === null &&
        event.type === 'state_transitioned' &&
        data.previousPhase === 'build' &&
        data.nextPhase === 'verify' &&
        ((eventScopeHash !== null &&
          activeScopeHash !== null &&
          eventScopeHash !== activeScopeHash) ||
          (eventScopeHash === null &&
            (latestProjection?.disposition === 'manual-stop' ||
              latestProjection?.disposition === 'hard-stop')))
      ) {
        // Every real implementation-scope change starts a fresh semantic repair episode. Legacy
        // trajectories did not persist the scope hash, so only their manual/hard-stop transitions
        // can be inferred safely from the Build guard.
        history.length = 0;
        latestProjection = null;
        activeScopeHash = eventScopeHash;
        iteration = 0;
        continue;
      }
      continue;
    }
    if (event.type !== 'state_transitioned') {
      throw new Error('Loop repair projection must belong to a state_transitioned event');
    }
    const projection = parseLoopRepairTrajectoryProjection(data[LOOP_REPAIR_TRAJECTORY_FIELD]);
    assertProjectionTransition(data, projection);
    if (projection.overrideSummaryHash === null) {
      if (
        projection.contractHash !== null &&
        activeContractHash !== null &&
        projection.contractHash !== activeContractHash
      ) {
        history.length = 0;
        iteration = 0;
      }
      if (projection.contractHash !== null) activeContractHash = projection.contractHash;
      if (
        projection.contractHash === null &&
        eventScopeHash !== null &&
        activeScopeHash !== null &&
        eventScopeHash !== activeScopeHash
      ) {
        history.length = 0;
        iteration = 0;
      }
      if (eventScopeHash !== null) activeScopeHash = eventScopeHash;
      assertCommittedFailureProjection(projection, history);
      iteration += 1;
      history.push({
        kind: 'failure',
        revision: event.sequence,
        iteration,
        signatureHash: projection.signatureHash,
        ...(projection.contractHash === null
          ? {}
          : {
              failedAcceptanceIds: [...projection.failedAcceptanceIds],
              failedCheckIds: [...projection.failedCheckIds],
            }),
      });
    } else {
      if (
        latestProjection?.contractHash === null &&
        eventScopeHash !== null &&
        activeScopeHash !== null &&
        eventScopeHash !== activeScopeHash
      ) {
        throw new Error('Loop repair override cannot cross implementation scope progress');
      }
      assertCommittedOverrideProjection(projection, history, latestProjection);
      const failure = history.at(-1);
      if (!failure || failure.kind !== 'failure') {
        throw new Error('Loop repair trajectory override has no failure history');
      }
      history.push({
        kind: 'override',
        revision: event.sequence,
        iteration: failure.iteration,
        signatureHash: projection.signatureHash,
        summaryHash: projection.overrideSummaryHash,
      });
    }
    latestProjection = projection;
    if (history.length > LOOP_REPAIR_STAGNATION_LIMITS.maxHistoryRecords) {
      throw new Error('Loop repair trajectory history exceeds its record boundary');
    }
  }
  return { history, latestProjection };
}

export function rebuildLoopRepairHistory(
  options: LoopCommittedRepairTrajectory,
): LoopRepairHistoryRecord[] {
  return projectLoopRepairHistory(options).history;
}

export function inspectLatestLoopRepairProjection(
  options: LoopCommittedRepairTrajectory,
): LoopRepairTrajectoryProjection | null {
  const projection = projectLoopRepairHistory(options).latestProjection;
  return projection ? { ...projection } : null;
}

export function acceptLatestLoopRepairOverride(
  options: LoopCommittedRepairTrajectory & { override: LoopRepairOverrideRequest },
): LoopRepairOverrideProjectionResult {
  const projected = projectLoopRepairHistory(options);
  const request = record(options.override, 'Loop repair override request');
  exactKeys(request, ['expectedSignatureHash', 'summary'], 'Loop repair override request');
  const expectedSignatureHash = hash(
    request.expectedSignatureHash,
    'Loop repair override expected signature',
  );
  if (typeof request.summary !== 'string') {
    throw new Error('Loop repair override summary is invalid');
  }
  if (projected.latestProjection?.disposition === 'hard-stop') {
    throw new Error('Loop repair hard stop cannot be overridden');
  }
  if (
    projected.latestProjection?.disposition !== 'manual-stop' ||
    projected.latestProjection.signatureHash !== expectedSignatureHash
  ) {
    throw new Error('Loop repair override does not match the latest manual stop');
  }
  if (
    projected.history.some(
      (entry) => entry.kind === 'override' && entry.signatureHash === expectedSignatureHash,
    )
  ) {
    throw new Error('Loop repair signature was already overridden');
  }
  const overrideSummaryHash = hashLoopRepairOverrideSummary(request.summary);
  return {
    history: projected.history,
    eventProjection: {
      signatureHash: expectedSignatureHash,
      disposition: 'continue',
      overrideSummaryHash,
      contractHash: projected.latestProjection.contractHash,
      failedAcceptanceIds: [...projected.latestProjection.failedAcceptanceIds],
      failedCheckIds: [...projected.latestProjection.failedCheckIds],
      maxVerifyFailures: projected.latestProjection.maxVerifyFailures,
    },
  };
}

export function loopRepairFailureFacts(input: LoopRepairEvidenceInput): LoopRepairFailureFacts {
  const envelope = parseLoopVerificationEvidenceEnvelope(input.envelope);
  const bundle = parseLoopImplementationScopeBundle(input.implementationScope);
  if (envelope.result !== 'fail') {
    throw new Error('Loop repair stagnation requires a failed verification envelope');
  }
  if (
    envelope.contractHash !== bundle.scope.contractHash ||
    envelope.implementationScopeHash !== bundle.scope.scopeHash
  ) {
    throw new Error('Loop repair evidence does not match the implementation scope authority');
  }
  return {
    contractHash: bundle.scope.contractHash,
    implementationScopeHash: loopRepairScopeHash(bundle),
    artifactSnapshotHash: bundle.scope.currentProjectionHash,
    failedAcceptanceIds: envelope.acceptanceTrace.entries
      .filter((entry) => entry.status === 'failed' || entry.status === 'missing')
      .map((entry) => entry.acceptanceId)
      .sort(compareText),
    failedCheckIds: normalizeLoopRepairFailedCheckIds(input.failedCheckIds),
  };
}

function projectionForDecision(
  decision: LoopRepairStagnationDecision,
  overrideSummaryHash: string | null,
): LoopRepairTrajectoryProjection {
  return {
    signatureHash: decision.signature.signatureHash,
    disposition: decision.disposition,
    overrideSummaryHash,
    contractHash: decision.signature.contractHash,
    failedAcceptanceIds: [...decision.signature.failedAcceptanceIds],
    failedCheckIds: [...decision.signature.failedCheckIds],
    maxVerifyFailures: decision.totalRepairFailures + decision.remainingIterations,
  };
}

function runtimeContext(input: LoopRepairRuntimeInput): {
  facts: LoopRepairFailureFacts;
  history: LoopRepairHistoryRecord[];
} {
  const facts = loopRepairFailureFacts(input);
  const projected = projectLoopRepairHistory(input);
  return {
    facts,
    history:
      projected.latestProjection?.contractHash !== null &&
      projected.latestProjection?.contractHash !== facts.contractHash
        ? []
        : projected.history,
  };
}

export function inspectLoopRepairResume(input: LoopRepairResumeInput): LoopRepairResumeInspection {
  const projected = projectLoopRepairHistory(input);
  const facts = loopRepairFailureFacts(input);
  const latestProjection = projected.latestProjection;
  const signatureHash = buildLoopRepairSignature(facts).signatureHash;
  const currentScope = parseLoopImplementationScopeBundle(input.currentImplementationScope);
  if (
    latestProjection?.contractHash === null &&
    loopRepairScopeHash(currentScope) !== loopRepairScopeHash(input.implementationScope)
  ) {
    return {
      disposition: 'proceed',
      reason: 'scope-progress',
      signatureHash,
      history: projected.history,
    };
  }
  if (latestProjection?.disposition === 'hard-stop') {
    return {
      disposition: 'hard-stop',
      reason: 'hard-stop',
      signatureHash: latestProjection.signatureHash,
      history: projected.history,
    };
  }
  if (latestProjection?.disposition !== 'manual-stop') {
    return {
      disposition: 'proceed',
      reason:
        latestProjection === null || latestProjection.overrideSummaryHash === null
          ? 'no-stopped-failure'
          : 'override-already-applied',
      signatureHash,
      history: projected.history,
    };
  }
  if (latestProjection.signatureHash !== signatureHash) {
    throw new Error('Loop repair current evidence does not match the latest manual stop');
  }
  const alreadyUsed = projected.history.some(
    (entry) => entry.kind === 'override' && entry.signatureHash === signatureHash,
  );
  return {
    disposition: alreadyUsed ? 'hard-stop' : 'override-required',
    reason: alreadyUsed ? 'override-already-applied' : 'override-required',
    signatureHash,
    history: projected.history,
  };
}

export function inspectLoopRepairFailure(input: LoopRepairRuntimeInput): LoopRepairRuntimeResult {
  const context = runtimeContext(input);
  const decision = decideLoopRepairStagnation({
    ...context,
    maxVerifyFailures: input.maxVerifyFailures,
  });
  return {
    ...context,
    decision,
    eventProjection: projectionForDecision(decision, null),
  };
}

export function acceptLoopRepairOverride(
  input: LoopRepairRuntimeInput & { override: LoopRepairOverrideRequest },
): LoopRepairRuntimeResult {
  const context = runtimeContext(input);
  const decision = decideLoopRepairOverride({
    ...context,
    override: input.override,
    maxVerifyFailures: input.maxVerifyFailures,
  });
  const summaryHash = decision.overrideAccepted
    ? hashLoopRepairOverrideSummary(input.override.summary)
    : null;
  return {
    ...context,
    decision,
    eventProjection: decision.overrideAccepted
      ? projectionForDecision(decision, summaryHash)
      : null,
  };
}

export function buildLoopRepairSignatureFromEvidence(
  input: LoopRepairEvidenceInput,
): ReturnType<typeof buildLoopRepairSignature> {
  return buildLoopRepairSignature(loopRepairFailureFacts(input));
}
