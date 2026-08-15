import path from 'node:path';

import { canonicalHash } from './loop-canonical-hash.js';

export const LOOP_CHECK_RECEIPT_SCHEMA = 'owner.loop.check-receipt.v1' as const;
export const LOOP_CHECK_RECEIPT_HASH_TAG = 'owner.loop.check-receipt.v1';
export const LOOP_CHECK_POLICY = 'scoped-text-safety' as const;
export const LOOP_CHECK_POLICY_VERSION = 1 as const;
export const LOOP_CHECK_LIMITS = Object.freeze({
  // maxFiles and maxTotalBytes apply to each auditable batch; one receipt may aggregate many
  // batches when the complete projection-derived scope is larger than one batch.
  maxFiles: 256,
  // Generated Loop runtimes are deliberately emitted as a single auditable asset and
  // currently exceed 1 MiB. Keep the bounded checker usable for that supported asset
  // while retaining a finite per-file limit that produces a blocking scan-limit receipt.
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxIssues: 128,
} as const);

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const CHANGE_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const CHECKER_HASH_TAG = 'owner.loop.checker-policy.v1';
const CHECK_INPUT_HASH_TAG = 'owner.loop.check-input.v1';
const MAX_ISSUE_PATH_BYTES = 2_048;

export const LOOP_CHECKER_HASH = canonicalHash(CHECKER_HASH_TAG, {
  policy: LOOP_CHECK_POLICY,
  version: LOOP_CHECK_POLICY_VERSION,
  limits: LOOP_CHECK_LIMITS,
  checks: ['conflict-marker', 'space-before-tab', 'trailing-whitespace'],
  binaryHandling: 'skip-and-count',
});

export type LoopCheckReceiptStatus = 'passed' | 'failed';
export type LoopCheckIssueKind =
  | 'conflict-marker'
  | 'trailing-whitespace'
  | 'space-before-tab'
  | 'scope-mismatch'
  | 'unsafe-file'
  | 'binary-skipped'
  | 'scan-limit';

export type LoopCheckReceiptStaleReason =
  | 'contract-before-does-not-match-scope'
  | 'implementation-before-does-not-match-scope'
  | 'contract-changed-during-check'
  | 'implementation-changed-during-check'
  | 'contract-after-does-not-match-scope'
  | 'implementation-after-does-not-match-scope';

export interface LoopCheckIssue {
  path: string;
  line: number;
  kind: LoopCheckIssueKind;
}

export interface LoopCheckBatchCounts {
  filesSelected: number;
  filesScanned: number;
  binaryFilesSkipped: number;
  bytesScanned: number;
  issueCount: number;
  recordedIssueCount: number;
}

export interface LoopCheckReceipt {
  schema: typeof LOOP_CHECK_RECEIPT_SCHEMA;
  change: string;
  sourceRevision: number;
  checker: {
    policy: typeof LOOP_CHECK_POLICY;
    version: typeof LOOP_CHECK_POLICY_VERSION;
    hash: string;
    limits: typeof LOOP_CHECK_LIMITS;
  };
  inputHash: string;
  status: LoopCheckReceiptStatus;
  startedAt: string;
  endedAt: string;
  contract: {
    expectedHash: string;
    beforeHash: string;
    afterHash: string;
  };
  implementation: {
    scopeHash: string;
    expectedSnapshotHash: string;
    beforeSnapshotHash: string;
    afterSnapshotHash: string;
  };
  counts: {
    filesSelected: number;
    filesScanned: number;
    binaryFilesSkipped: number;
    bytesScanned: number;
    issueCount: number;
    recordedIssueCount: number;
    batches?: LoopCheckBatchCounts[];
  };
  issues: LoopCheckIssue[];
  issuesTruncated: boolean;
  stale: boolean;
  staleReasons: LoopCheckReceiptStaleReason[];
  receiptHash: string;
}

export type LoopCheckReceiptBuildInput = Omit<
  LoopCheckReceipt,
  'schema' | 'checker' | 'inputHash' | 'receiptHash'
>;
type LoopCheckReceiptContent = Omit<LoopCheckReceipt, 'receiptHash'>;

const ISSUE_KINDS = new Set<LoopCheckIssueKind>([
  'conflict-marker',
  'trailing-whitespace',
  'space-before-tab',
  'scope-mismatch',
  'unsafe-file',
  'binary-skipped',
  'scan-limit',
]);
const ISSUE_KIND_ORDER: readonly LoopCheckIssueKind[] = [
  'conflict-marker',
  'trailing-whitespace',
  'space-before-tab',
  'scope-mismatch',
  'unsafe-file',
  'binary-skipped',
  'scan-limit',
];
const STALE_REASON_ORDER: readonly LoopCheckReceiptStaleReason[] = [
  'contract-before-does-not-match-scope',
  'implementation-before-does-not-match-scope',
  'contract-changed-during-check',
  'implementation-changed-during-check',
  'contract-after-does-not-match-scope',
  'implementation-after-does-not-match-scope',
];
const STALE_REASONS = new Set(STALE_REASON_ORDER);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
  optional: readonly string[] = [],
): void {
  const keys = new Set([...expected, ...optional]);
  const unknown = Object.keys(value).filter((key) => !keys.has(key));
  const missing = expected.filter((key) => !(key in value));
  if (unknown.length > 0) throw new Error(`${label} has unknown field(s): ${unknown.join(', ')}`);
  if (missing.length > 0) throw new Error(`${label} is missing field(s): ${missing.join(', ')}`);
}

function hash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    throw new Error(`${label} must be a SHA-256 hash`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value as number;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = nonNegativeInteger(value, label);
  if (parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function isoTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be an ISO timestamp`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return value;
}

function projectRelativePath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_ISSUE_PATH_BYTES ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.endsWith('/') ||
    /^[a-zA-Z]:/u.test(value)
  ) {
    throw new Error(`${label} must be a bounded normalized project-relative path`);
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized !== value ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error(`${label} must stay inside the project root`);
  }
  return value;
}

function parseChecker(value: unknown): LoopCheckReceipt['checker'] {
  const checker = record(value, 'Loop check receipt checker');
  exactKeys(checker, ['policy', 'version', 'hash', 'limits'], 'Loop check receipt checker');
  const limits = record(checker.limits, 'Loop check receipt limits');
  exactKeys(
    limits,
    ['maxFiles', 'maxFileBytes', 'maxTotalBytes', 'maxIssues'],
    'Loop check receipt limits',
  );
  if (
    checker.policy !== LOOP_CHECK_POLICY ||
    checker.version !== LOOP_CHECK_POLICY_VERSION ||
    checker.hash !== LOOP_CHECKER_HASH ||
    limits.maxFiles !== LOOP_CHECK_LIMITS.maxFiles ||
    limits.maxFileBytes !== LOOP_CHECK_LIMITS.maxFileBytes ||
    limits.maxTotalBytes !== LOOP_CHECK_LIMITS.maxTotalBytes ||
    limits.maxIssues !== LOOP_CHECK_LIMITS.maxIssues
  ) {
    throw new Error('Loop check receipt checker policy is unsupported');
  }
  return {
    policy: LOOP_CHECK_POLICY,
    version: LOOP_CHECK_POLICY_VERSION,
    hash: LOOP_CHECKER_HASH,
    limits: { ...LOOP_CHECK_LIMITS },
  };
}

function parseContract(value: unknown): LoopCheckReceipt['contract'] {
  const contract = record(value, 'Loop check receipt contract');
  exactKeys(contract, ['expectedHash', 'beforeHash', 'afterHash'], 'Loop check receipt contract');
  return {
    expectedHash: hash(contract.expectedHash, 'Loop check expected contract hash'),
    beforeHash: hash(contract.beforeHash, 'Loop check before contract hash'),
    afterHash: hash(contract.afterHash, 'Loop check after contract hash'),
  };
}

function parseImplementation(value: unknown): LoopCheckReceipt['implementation'] {
  const implementation = record(value, 'Loop check receipt implementation');
  exactKeys(
    implementation,
    ['scopeHash', 'expectedSnapshotHash', 'beforeSnapshotHash', 'afterSnapshotHash'],
    'Loop check receipt implementation',
  );
  return {
    scopeHash: hash(implementation.scopeHash, 'Loop check scope hash'),
    expectedSnapshotHash: hash(
      implementation.expectedSnapshotHash,
      'Loop check expected snapshot hash',
    ),
    beforeSnapshotHash: hash(implementation.beforeSnapshotHash, 'Loop check before snapshot hash'),
    afterSnapshotHash: hash(implementation.afterSnapshotHash, 'Loop check after snapshot hash'),
  };
}

function parseBatchCounts(value: unknown, index: number): LoopCheckBatchCounts {
  const batch = record(value, `Loop check batch ${index}`);
  exactKeys(
    batch,
    [
      'filesSelected',
      'filesScanned',
      'binaryFilesSkipped',
      'bytesScanned',
      'issueCount',
      'recordedIssueCount',
    ],
    `Loop check batch ${index}`,
  );
  const parsed = {
    filesSelected: nonNegativeInteger(
      batch.filesSelected,
      `Loop check batch ${index} filesSelected`,
    ),
    filesScanned: nonNegativeInteger(batch.filesScanned, `Loop check batch ${index} filesScanned`),
    binaryFilesSkipped: nonNegativeInteger(
      batch.binaryFilesSkipped,
      `Loop check batch ${index} binaryFilesSkipped`,
    ),
    bytesScanned: nonNegativeInteger(batch.bytesScanned, `Loop check batch ${index} bytesScanned`),
    issueCount: nonNegativeInteger(batch.issueCount, `Loop check batch ${index} issueCount`),
    recordedIssueCount: nonNegativeInteger(
      batch.recordedIssueCount,
      `Loop check batch ${index} recordedIssueCount`,
    ),
  };
  if (
    parsed.filesSelected > LOOP_CHECK_LIMITS.maxFiles ||
    parsed.filesScanned + parsed.binaryFilesSkipped > parsed.filesSelected ||
    parsed.bytesScanned > LOOP_CHECK_LIMITS.maxTotalBytes ||
    parsed.recordedIssueCount > parsed.issueCount
  ) {
    throw new Error(`Loop check batch ${index} accounting is invalid`);
  }
  return parsed;
}

function parseCounts(value: unknown): LoopCheckReceipt['counts'] {
  const counts = record(value, 'Loop check receipt counts');
  exactKeys(
    counts,
    [
      'filesSelected',
      'filesScanned',
      'binaryFilesSkipped',
      'bytesScanned',
      'issueCount',
      'recordedIssueCount',
    ],
    'Loop check receipt counts',
    ['batches'],
  );
  const parsed = {
    filesSelected: nonNegativeInteger(counts.filesSelected, 'Loop check filesSelected'),
    filesScanned: nonNegativeInteger(counts.filesScanned, 'Loop check filesScanned'),
    binaryFilesSkipped: nonNegativeInteger(
      counts.binaryFilesSkipped,
      'Loop check binaryFilesSkipped',
    ),
    bytesScanned: nonNegativeInteger(counts.bytesScanned, 'Loop check bytesScanned'),
    issueCount: nonNegativeInteger(counts.issueCount, 'Loop check issueCount'),
    recordedIssueCount: nonNegativeInteger(
      counts.recordedIssueCount,
      'Loop check recordedIssueCount',
    ),
    ...(counts.batches === undefined
      ? {}
      : {
          batches: Array.isArray(counts.batches)
            ? counts.batches.map(parseBatchCounts)
            : (() => {
                throw new Error('Loop check receipt batches must be an array');
              })(),
        }),
  };
  const batches = parsed.batches;
  if (batches !== undefined) {
    if (batches.length === 0) throw new Error('Loop check receipt batches must not be empty');
    const totals = batches.reduce(
      (total, batch) => ({
        filesSelected: total.filesSelected + batch.filesSelected,
        filesScanned: total.filesScanned + batch.filesScanned,
        binaryFilesSkipped: total.binaryFilesSkipped + batch.binaryFilesSkipped,
        bytesScanned: total.bytesScanned + batch.bytesScanned,
        issueCount: total.issueCount + batch.issueCount,
        recordedIssueCount: total.recordedIssueCount + batch.recordedIssueCount,
      }),
      {
        filesSelected: 0,
        filesScanned: 0,
        binaryFilesSkipped: 0,
        bytesScanned: 0,
        issueCount: 0,
        recordedIssueCount: 0,
      },
    );
    if (JSON.stringify(totals) !== JSON.stringify({ ...parsed, batches: undefined })) {
      throw new Error('Loop check receipt batch totals are inconsistent');
    }
  }
  if (
    parsed.filesScanned + parsed.binaryFilesSkipped > parsed.filesSelected ||
    parsed.recordedIssueCount > parsed.issueCount ||
    parsed.recordedIssueCount > LOOP_CHECK_LIMITS.maxIssues ||
    (batches === undefined &&
      (parsed.filesScanned + parsed.binaryFilesSkipped > LOOP_CHECK_LIMITS.maxFiles ||
        parsed.bytesScanned > LOOP_CHECK_LIMITS.maxTotalBytes))
  ) {
    throw new Error('Loop check receipt count accounting is invalid');
  }
  return parsed;
}

function compareIssues(left: LoopCheckIssue, right: LoopCheckIssue): number {
  return (
    left.path.localeCompare(right.path, 'en') ||
    left.line - right.line ||
    ISSUE_KIND_ORDER.indexOf(left.kind) - ISSUE_KIND_ORDER.indexOf(right.kind)
  );
}

function parseIssues(value: unknown): LoopCheckIssue[] {
  if (!Array.isArray(value) || value.length > LOOP_CHECK_LIMITS.maxIssues) {
    throw new Error('Loop check receipt issues must be a bounded array');
  }
  const issues = value.map((entry, index): LoopCheckIssue => {
    const issue = record(entry, `Loop check issue ${index}`);
    exactKeys(issue, ['path', 'line', 'kind'], `Loop check issue ${index}`);
    if (typeof issue.kind !== 'string' || !ISSUE_KINDS.has(issue.kind as LoopCheckIssueKind)) {
      throw new Error(`Loop check issue ${index} kind is invalid`);
    }
    return {
      path: projectRelativePath(issue.path, `Loop check issue ${index} path`),
      line: positiveInteger(issue.line, `Loop check issue ${index} line`),
      kind: issue.kind as LoopCheckIssueKind,
    };
  });
  const canonical = [...issues].sort(compareIssues);
  if (JSON.stringify(canonical) !== JSON.stringify(issues)) {
    throw new Error('Loop check receipt issues must be canonical');
  }
  return issues;
}

function parseStaleReasons(value: unknown): LoopCheckReceiptStaleReason[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (entry) =>
        typeof entry !== 'string' || !STALE_REASONS.has(entry as LoopCheckReceiptStaleReason),
    )
  ) {
    throw new Error('Loop check receipt stale reasons are invalid');
  }
  const reasons = value as LoopCheckReceiptStaleReason[];
  const canonical = STALE_REASON_ORDER.filter((reason) => reasons.includes(reason));
  if (
    new Set(reasons).size !== reasons.length ||
    JSON.stringify(canonical) !== JSON.stringify(reasons)
  ) {
    throw new Error('Loop check receipt stale reasons must be canonical');
  }
  return [...reasons];
}

function loopCheckInputHash(value: {
  change: string;
  sourceRevision: number;
  checkerHash: string;
  contractHash: string;
  scopeHash: string;
  snapshotHash: string;
}): string {
  return canonicalHash(CHECK_INPUT_HASH_TAG, value);
}

/** Parse a persisted receipt and recompute all policy and content-bound identities. */
export function parseLoopCheckReceipt(value: unknown): LoopCheckReceipt {
  const receipt = record(value, 'Loop check receipt');
  exactKeys(
    receipt,
    [
      'schema',
      'change',
      'sourceRevision',
      'checker',
      'inputHash',
      'status',
      'startedAt',
      'endedAt',
      'contract',
      'implementation',
      'counts',
      'issues',
      'issuesTruncated',
      'stale',
      'staleReasons',
      'receiptHash',
    ],
    'Loop check receipt',
  );
  if (receipt.schema !== LOOP_CHECK_RECEIPT_SCHEMA) {
    throw new Error('Loop check receipt schema is invalid');
  }
  if (
    typeof receipt.change !== 'string' ||
    Buffer.byteLength(receipt.change, 'utf8') > 128 ||
    !CHANGE_NAME_PATTERN.test(receipt.change)
  ) {
    throw new Error('Loop check receipt change name is invalid');
  }
  const sourceRevision = positiveInteger(receipt.sourceRevision, 'Loop check source revision');
  const checker = parseChecker(receipt.checker);
  const contract = parseContract(receipt.contract);
  const implementation = parseImplementation(receipt.implementation);
  const expectedInputHash = loopCheckInputHash({
    change: receipt.change,
    sourceRevision,
    checkerHash: checker.hash,
    contractHash: contract.expectedHash,
    scopeHash: implementation.scopeHash,
    snapshotHash: implementation.expectedSnapshotHash,
  });
  if (hash(receipt.inputHash, 'Loop check input hash') !== expectedInputHash) {
    throw new Error('Loop check receipt input hash mismatch');
  }
  if (receipt.status !== 'passed' && receipt.status !== 'failed') {
    throw new Error('Loop check receipt status is invalid');
  }
  const startedAt = isoTimestamp(receipt.startedAt, 'Loop check receipt startedAt');
  const endedAt = isoTimestamp(receipt.endedAt, 'Loop check receipt endedAt');
  if (endedAt < startedAt) throw new Error('Loop check receipt endedAt precedes startedAt');
  const counts = parseCounts(receipt.counts);
  const issues = parseIssues(receipt.issues);
  if (counts.recordedIssueCount !== issues.length) {
    throw new Error('Loop check receipt recorded issue count is inconsistent');
  }
  if (
    typeof receipt.issuesTruncated !== 'boolean' ||
    receipt.issuesTruncated !== counts.issueCount > issues.length
  ) {
    throw new Error('Loop check receipt issue truncation flag is inconsistent');
  }
  const staleReasons = parseStaleReasons(receipt.staleReasons);
  if (typeof receipt.stale !== 'boolean' || receipt.stale !== staleReasons.length > 0) {
    throw new Error('Loop check receipt stale flag is inconsistent');
  }
  const expectedStatus: LoopCheckReceiptStatus =
    counts.issueCount === 0 && !receipt.stale ? 'passed' : 'failed';
  if (receipt.status !== expectedStatus) {
    throw new Error('Loop check receipt status is inconsistent with its evidence');
  }
  if (
    receipt.status === 'passed' &&
    ((counts.batches === undefined && counts.filesSelected > LOOP_CHECK_LIMITS.maxFiles) ||
      counts.filesScanned + counts.binaryFilesSkipped !== counts.filesSelected)
  ) {
    throw new Error('Passed Loop check receipt must cover every selected file');
  }
  if (
    counts.batches === undefined &&
    counts.filesSelected > LOOP_CHECK_LIMITS.maxFiles &&
    !issues.some((issue) => issue.kind === 'scan-limit')
  ) {
    throw new Error('Loop check receipt exceeds its file budget without a scan-limit issue');
  }
  const content: LoopCheckReceiptContent = {
    schema: LOOP_CHECK_RECEIPT_SCHEMA,
    change: receipt.change,
    sourceRevision,
    checker,
    inputHash: expectedInputHash,
    status: receipt.status,
    startedAt,
    endedAt,
    contract,
    implementation,
    counts,
    issues,
    issuesTruncated: receipt.issuesTruncated,
    stale: receipt.stale,
    staleReasons,
  };
  const receiptHash = hash(receipt.receiptHash, 'Loop check receipt content hash');
  if (canonicalHash(LOOP_CHECK_RECEIPT_HASH_TAG, content) !== receiptHash) {
    throw new Error('Loop check receipt content hash mismatch');
  }
  return { ...content, receiptHash };
}

export function buildLoopCheckReceipt(input: LoopCheckReceiptBuildInput): LoopCheckReceipt {
  const checker: LoopCheckReceipt['checker'] = {
    policy: LOOP_CHECK_POLICY,
    version: LOOP_CHECK_POLICY_VERSION,
    hash: LOOP_CHECKER_HASH,
    limits: { ...LOOP_CHECK_LIMITS },
  };
  const content: LoopCheckReceiptContent = {
    schema: LOOP_CHECK_RECEIPT_SCHEMA,
    ...input,
    checker,
    inputHash: loopCheckInputHash({
      change: input.change,
      sourceRevision: input.sourceRevision,
      checkerHash: checker.hash,
      contractHash: input.contract.expectedHash,
      scopeHash: input.implementation.scopeHash,
      snapshotHash: input.implementation.expectedSnapshotHash,
    }),
  };
  return parseLoopCheckReceipt({
    ...content,
    receiptHash: canonicalHash(LOOP_CHECK_RECEIPT_HASH_TAG, content),
  });
}
