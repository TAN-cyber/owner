import { canonicalHash } from './loop-canonical-hash.js';

export const LOOP_REPAIR_SIGNATURE_SCHEMA = 'owner.loop.repair-signature.v1' as const;
export const LOOP_REPAIR_STAGNATION_LIMITS = {
  warningAtConsecutiveFailures: 2,
  manualStopAtConsecutiveFailures: 3,
  maxHistoryRecords: 64,
  maxFailedAcceptanceIds: 1_024,
  maxFailedCheckIds: 128,
  maxOverrideSummaryCharacters: 2_000,
} as const;

const SIGNATURE_HASH_TAG = 'owner.loop.repair-signature.v1';
const OVERRIDE_SUMMARY_HASH_TAG = 'owner.loop.repair-override-summary.v1';
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const TOKEN_PATTERN = /^[a-z0-9][a-z0-9._:/-]{0,255}$/u;

export interface LoopRepairFailureFacts {
  contractHash: string;
  implementationScopeHash: string;
  artifactSnapshotHash: string;
  failedAcceptanceIds: readonly string[];
  failedCheckIds: readonly string[];
}

export interface LoopRepairSignature {
  schema: typeof LOOP_REPAIR_SIGNATURE_SCHEMA;
  contractHash: string;
  failedAcceptanceIds: string[];
  failedCheckIds: string[];
  signatureHash: string;
}

export interface LoopRepairFailureRecord {
  kind: 'failure';
  revision: number;
  iteration: number;
  signatureHash: string;
  failedAcceptanceIds?: string[];
  failedCheckIds?: string[];
}

export interface LoopRepairOverrideRecord {
  kind: 'override';
  revision: number;
  iteration: number;
  signatureHash: string;
  summaryHash: string;
}

export type LoopRepairHistoryRecord = LoopRepairFailureRecord | LoopRepairOverrideRecord;

export interface LoopRepairOverrideRequest {
  expectedSignatureHash: string;
  summary: string;
}

export interface LoopRepairStagnationDecision {
  disposition: 'continue' | 'warn' | 'manual-stop' | 'hard-stop';
  reasonCode:
    | 'new-failure-signature'
    | 'repeated-failure-warning'
    | 'repeated-failure-stop'
    | 'override-accepted'
    | 'override-already-used'
    | 'repair-iteration-limit';
  signature: LoopRepairSignature;
  consecutiveFailures: number;
  totalRepairFailures: number;
  remainingIterations: number;
  overrideAccepted: boolean;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function hash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    throw new Error(`${label} must be a SHA-256 hash`);
  }
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function normalizedTokens(
  values: readonly string[],
  label: string,
  max: number,
  allowEmpty: boolean,
): string[] {
  if (!Array.isArray(values) || values.length > max || (!allowEmpty && values.length === 0)) {
    throw new Error(`${label} exceeds its count boundary`);
  }
  const tokens = values.map((value) => {
    if (typeof value !== 'string' || !TOKEN_PATTERN.test(value)) {
      throw new Error(`${label} contains an invalid token: ${String(value)}`);
    }
    return value;
  });
  return [...new Set(tokens)].sort(compareText);
}

export function normalizeLoopRepairFailedCheckIds(values: readonly string[] = []): string[] {
  return normalizedTokens(
    values,
    'Loop repair failed check IDs',
    LOOP_REPAIR_STAGNATION_LIMITS.maxFailedCheckIds,
    true,
  );
}

export function buildLoopRepairSignature(facts: LoopRepairFailureFacts): LoopRepairSignature {
  const failedCheckIds = normalizeLoopRepairFailedCheckIds(facts.failedCheckIds);
  const failedAcceptanceIds = normalizedTokens(
    facts.failedAcceptanceIds,
    'Loop repair failed acceptance IDs',
    LOOP_REPAIR_STAGNATION_LIMITS.maxFailedAcceptanceIds,
    true,
  );
  const content = {
    schema: LOOP_REPAIR_SIGNATURE_SCHEMA,
    contractHash: hash(facts.contractHash, 'Loop repair contract hash'),
    failedAcceptanceIds,
    failedCheckIds,
  };
  return {
    ...content,
    signatureHash: canonicalHash(SIGNATURE_HASH_TAG, content),
  };
}

function normalizeHistory(history: readonly LoopRepairHistoryRecord[]): LoopRepairHistoryRecord[] {
  if (!Array.isArray(history) || history.length > LOOP_REPAIR_STAGNATION_LIMITS.maxHistoryRecords) {
    throw new Error('Loop repair history exceeds its record boundary');
  }
  let previousIteration = 0;
  let previousRevision = 0;
  return history.map((record, index) => {
    if (!record || (record.kind !== 'failure' && record.kind !== 'override')) {
      throw new Error(`Loop repair history record ${index} is invalid`);
    }
    const expectedKeys =
      record.kind === 'failure'
        ? record.failedAcceptanceIds === undefined && record.failedCheckIds === undefined
          ? ['iteration', 'kind', 'revision', 'signatureHash']
          : [
              'failedAcceptanceIds',
              'failedCheckIds',
              'iteration',
              'kind',
              'revision',
              'signatureHash',
            ]
        : ['iteration', 'kind', 'revision', 'signatureHash', 'summaryHash'];
    const keys = Object.keys(record).sort(compareText);
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key, keyIndex) => key !== expectedKeys[keyIndex])
    ) {
      throw new Error(`Loop repair history record ${index} fields are invalid`);
    }
    const iteration = positiveInteger(record.iteration, `Loop repair history ${index} iteration`);
    const revision = positiveInteger(record.revision, `Loop repair history ${index} revision`);
    const previous = index > 0 ? history[index - 1] : null;
    const pairedOverride =
      record.kind === 'override' &&
      previous?.kind === 'failure' &&
      iteration === previousIteration &&
      revision >= previousRevision &&
      record.signatureHash === previous.signatureHash;
    if (!pairedOverride && (iteration <= previousIteration || revision <= previousRevision)) {
      throw new Error('Loop repair history must be strictly ordered by revision and iteration');
    }
    previousIteration = iteration;
    previousRevision = revision;
    const signatureHash = hash(record.signatureHash, `Loop repair history ${index} signature`);
    if (record.kind === 'failure') {
      if (record.failedAcceptanceIds === undefined && record.failedCheckIds === undefined) {
        return { kind: 'failure', iteration, revision, signatureHash };
      }
      return {
        kind: 'failure',
        iteration,
        revision,
        signatureHash,
        failedAcceptanceIds: normalizedTokens(
          record.failedAcceptanceIds ?? [],
          `Loop repair history ${index} failed acceptance IDs`,
          LOOP_REPAIR_STAGNATION_LIMITS.maxFailedAcceptanceIds,
          true,
        ),
        failedCheckIds: normalizedTokens(
          record.failedCheckIds ?? [],
          `Loop repair history ${index} failed check IDs`,
          LOOP_REPAIR_STAGNATION_LIMITS.maxFailedCheckIds,
          true,
        ),
      };
    }
    return {
      kind: 'override',
      iteration,
      revision,
      signatureHash,
      summaryHash: hash(record.summaryHash, `Loop repair history ${index} summary`),
    };
  });
}

function isSubset(values: readonly string[], other: readonly string[]): boolean {
  const available = new Set(other);
  return values.every((value) => available.has(value));
}

function semanticProgress(
  current: Pick<
    LoopRepairFailureRecord,
    'signatureHash' | 'failedAcceptanceIds' | 'failedCheckIds'
  >,
  previous: Pick<
    LoopRepairFailureRecord,
    'signatureHash' | 'failedAcceptanceIds' | 'failedCheckIds'
  >,
): boolean {
  if (
    current.failedAcceptanceIds === undefined ||
    current.failedCheckIds === undefined ||
    previous.failedAcceptanceIds === undefined ||
    previous.failedCheckIds === undefined
  ) {
    return current.signatureHash !== previous.signatureHash;
  }
  return (
    isSubset(current.failedAcceptanceIds, previous.failedAcceptanceIds) &&
    isSubset(current.failedCheckIds, previous.failedCheckIds) &&
    (current.failedAcceptanceIds.length < previous.failedAcceptanceIds.length ||
      current.failedCheckIds.length < previous.failedCheckIds.length)
  );
}

export function loopRepairConsecutiveFailures(
  current: Pick<
    LoopRepairFailureRecord,
    'signatureHash' | 'failedAcceptanceIds' | 'failedCheckIds'
  >,
  failures: readonly LoopRepairFailureRecord[],
): number {
  let consecutive = 1;
  let later = current;
  for (let index = failures.length - 1; index >= 0; index -= 1) {
    const previous = failures[index];
    if (semanticProgress(later, previous)) break;
    consecutive += 1;
    later = previous;
  }
  return consecutive;
}

function overrideSummary(value: string): string {
  const summary = value.trim();
  if (
    summary.length === 0 ||
    summary.length > LOOP_REPAIR_STAGNATION_LIMITS.maxOverrideSummaryCharacters
  ) {
    throw new Error('Loop repair override summary is invalid');
  }
  return summary;
}

export function hashLoopRepairOverrideSummary(summary: string): string {
  return canonicalHash(OVERRIDE_SUMMARY_HASH_TAG, {
    summary: overrideSummary(summary),
  });
}

/**
 * Decide an override for a failure that was already committed as a manual stop.
 *
 * Unlike `decideLoopRepairStagnation`, this function does not add another failure attempt. The
 * accepted override belongs to the following Build-to-Verify transition.
 */
export function decideLoopRepairOverride(options: {
  facts: LoopRepairFailureFacts;
  history: readonly LoopRepairHistoryRecord[];
  override: LoopRepairOverrideRequest;
  maxVerifyFailures: number;
}): LoopRepairStagnationDecision {
  const signature = buildLoopRepairSignature(options.facts);
  const history = normalizeHistory(options.history);
  const failures = history.filter(
    (record): record is LoopRepairFailureRecord => record.kind === 'failure',
  );
  const totalRepairFailures = failures.length;
  const maxVerifyFailures = positiveInteger(
    options.maxVerifyFailures,
    'Loop maximum Verify failures',
  );
  const remainingIterations = Math.max(0, maxVerifyFailures - totalRepairFailures);
  const consecutiveFailures =
    failures.length === 0
      ? 0
      : loopRepairConsecutiveFailures(
          {
            signatureHash: signature.signatureHash,
            failedAcceptanceIds: signature.failedAcceptanceIds,
            failedCheckIds: signature.failedCheckIds,
          },
          failures.slice(0, -1),
        );
  if (totalRepairFailures >= maxVerifyFailures) {
    return {
      disposition: 'hard-stop',
      reasonCode: 'repair-iteration-limit',
      signature,
      consecutiveFailures,
      totalRepairFailures,
      remainingIterations,
      overrideAccepted: false,
    };
  }
  if (
    failures.at(-1)?.signatureHash !== signature.signatureHash ||
    consecutiveFailures < LOOP_REPAIR_STAGNATION_LIMITS.manualStopAtConsecutiveFailures
  ) {
    throw new Error('Loop repair override is only available for the latest manual stop');
  }
  const expected = hash(
    options.override.expectedSignatureHash,
    'Loop repair override expected signature',
  );
  if (expected !== signature.signatureHash) {
    throw new Error('Loop repair override does not match the current failure signature');
  }
  overrideSummary(options.override.summary);
  const alreadyUsed = history.some(
    (record) => record.kind === 'override' && record.signatureHash === signature.signatureHash,
  );
  return {
    disposition: alreadyUsed ? 'manual-stop' : 'continue',
    reasonCode: alreadyUsed ? 'override-already-used' : 'override-accepted',
    signature,
    consecutiveFailures,
    totalRepairFailures,
    remainingIterations,
    overrideAccepted: !alreadyUsed,
  };
}

/**
 * Decide whether another Verify-fail repair loop is useful.
 *
 * The caller persists failure/override events; this pure function never weakens a test, changes a
 * phase, or invents a pass result.
 */
export function decideLoopRepairStagnation(options: {
  facts: LoopRepairFailureFacts;
  history: readonly LoopRepairHistoryRecord[];
  maxVerifyFailures: number;
  override?: LoopRepairOverrideRequest | null;
}): LoopRepairStagnationDecision {
  const signature = buildLoopRepairSignature(options.facts);
  const history = normalizeHistory(options.history);
  const failures = history.filter(
    (record): record is LoopRepairFailureRecord => record.kind === 'failure',
  );
  const totalRepairFailures = failures.length + 1;
  const maxVerifyFailures = positiveInteger(
    options.maxVerifyFailures,
    'Loop maximum Verify failures',
  );
  const remainingIterations = Math.max(0, maxVerifyFailures - totalRepairFailures);
  const consecutiveFailures = loopRepairConsecutiveFailures(
    {
      signatureHash: signature.signatureHash,
      failedAcceptanceIds: signature.failedAcceptanceIds,
      failedCheckIds: signature.failedCheckIds,
    },
    failures,
  );
  if (totalRepairFailures >= maxVerifyFailures) {
    return {
      disposition: 'hard-stop',
      reasonCode: 'repair-iteration-limit',
      signature,
      consecutiveFailures,
      totalRepairFailures,
      remainingIterations,
      overrideAccepted: false,
    };
  }
  if (consecutiveFailures < LOOP_REPAIR_STAGNATION_LIMITS.warningAtConsecutiveFailures) {
    return {
      disposition: 'continue',
      reasonCode: 'new-failure-signature',
      signature,
      consecutiveFailures,
      totalRepairFailures,
      remainingIterations,
      overrideAccepted: false,
    };
  }
  if (consecutiveFailures < LOOP_REPAIR_STAGNATION_LIMITS.manualStopAtConsecutiveFailures) {
    return {
      disposition: 'warn',
      reasonCode: 'repeated-failure-warning',
      signature,
      consecutiveFailures,
      totalRepairFailures,
      remainingIterations,
      overrideAccepted: false,
    };
  }
  if (options.override) {
    const expected = hash(
      options.override.expectedSignatureHash,
      'Loop repair override expected signature',
    );
    if (expected !== signature.signatureHash) {
      throw new Error('Loop repair override does not match the current failure signature');
    }
    overrideSummary(options.override.summary);
    const alreadyUsed = history.some(
      (record) => record.kind === 'override' && record.signatureHash === signature.signatureHash,
    );
    return {
      disposition: alreadyUsed ? 'manual-stop' : 'continue',
      reasonCode: alreadyUsed ? 'override-already-used' : 'override-accepted',
      signature,
      consecutiveFailures,
      totalRepairFailures,
      remainingIterations,
      overrideAccepted: !alreadyUsed,
    };
  }
  const alreadyUsed = history.some(
    (record) => record.kind === 'override' && record.signatureHash === signature.signatureHash,
  );
  return {
    disposition: 'manual-stop',
    reasonCode: alreadyUsed ? 'override-already-used' : 'repeated-failure-stop',
    signature,
    consecutiveFailures,
    totalRepairFailures,
    remainingIterations,
    overrideAccepted: false,
  };
}
