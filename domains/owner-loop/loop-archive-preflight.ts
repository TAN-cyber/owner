import path from 'node:path';

import { canonicalHash } from './loop-canonical-hash.js';
import type { LoopArchiveConfirmation, LoopPhase, LoopSpecOperation } from './loop-types.js';
import type { LoopWorkspaceFinish, LoopWorkspaceIsolation } from './loop-workspace.js';

export const LOOP_ARCHIVE_PREFLIGHT_SCHEMA = 'owner.loop.archive-preflight.v1' as const;

const PREFLIGHT_HASH_TAG = 'owner.loop.archive-preflight.v1';
const OPERATION_HASH_TAG = 'owner.loop.archive-operation.v1';
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const FINDING_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

export type LoopVerificationFreshness = 'missing' | 'invalid' | 'stale' | 'complete' | 'partial';

export interface LoopArchiveSpecFact {
  capability: string;
  operation: LoopSpecOperation;
  expectedBaseHash: string | null;
  actualBaseHash: string | null;
  proposedHash: string | null;
}

export interface LoopArchiveEvidenceFact {
  result: 'pending' | 'pass' | 'fail';
  freshness: LoopVerificationFreshness;
  contractHash: string | null;
  acceptanceHash: string | null;
  implementationScopeHash: string | null;
  reportHash: string | null;
  envelopeHash: string | null;
  partialAllowanceHash: string | null;
  skippedAcceptanceCount: number;
}

export interface LoopArchivePreflightInput {
  change: string;
  archiveConfirmation: LoopArchiveConfirmation;
  stateSchema: string;
  revision: number;
  phase: LoopPhase;
  archived: boolean;
  pendingJournal: boolean;
  targetRef: string;
  targetExists: boolean;
  specs: readonly LoopArchiveSpecFact[];
  evidence: LoopArchiveEvidenceFact;
  workspace?: LoopArchiveWorkspaceFact | null;
  findingCodes?: readonly string[];
}

export interface LoopArchiveWorkspaceFact {
  schema: 'owner.loop.workspace.v3';
  isolation: LoopWorkspaceIsolation;
  changeBranch: string | null;
  targetBranch: string | null;
  finish: LoopWorkspaceFinish | null;
}

export interface LoopArchiveOperationPreview extends LoopArchiveSpecFact {
  operationHash: string;
}

export interface LoopArchivePreflight {
  schema: typeof LOOP_ARCHIVE_PREFLIGHT_SCHEMA;
  change: string;
  archiveConfirmation: LoopArchiveConfirmation;
  revision: number;
  targetRef: string;
  ready: boolean;
  evidenceFreshness: LoopVerificationFreshness;
  operationCount: number;
  operations: LoopArchiveOperationPreview[];
  workspace: LoopArchiveWorkspaceFact | null;
  findingCodes: string[];
  preflightHash: string;
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

function optionalHash(value: unknown, label: string): string | null {
  return value === null ? null : hash(value, label);
}

function normalizedRef(value: string, label: string): string {
  const normalized = path.posix.normalize(value);
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes('\\') ||
    path.posix.isAbsolute(normalized) ||
    /^(?:[A-Za-z]:|~)/u.test(value) ||
    value.split('/').includes('..') ||
    normalized !== value ||
    normalized === '.' ||
    value.endsWith('/')
  ) {
    throw new Error(`${label} must be a normalized Loop-relative ref`);
  }
  return value;
}

function positiveRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('Loop archive preflight revision must be a positive integer');
  }
  return value;
}

function normalizeWorkspace(
  value: LoopArchiveWorkspaceFact | null | undefined,
): LoopArchiveWorkspaceFact | null {
  if (value === undefined || value === null) return null;
  if (value.schema !== 'owner.loop.workspace.v3') {
    throw new Error('Loop archive workspace schema is invalid');
  }
  if (
    value.isolation !== 'current' &&
    value.isolation !== 'branch' &&
    value.isolation !== 'worktree'
  ) {
    throw new Error('Loop archive workspace isolation is invalid');
  }
  for (const [label, branch] of [
    ['change', value.changeBranch],
    ['target', value.targetBranch],
  ] as const) {
    if (
      branch !== null &&
      (branch.length === 0 ||
        branch.trim() !== branch ||
        Array.from(branch).some((character) => {
          const code = character.codePointAt(0) ?? 0;
          return code <= 0x1f || code === 0x7f;
        }))
    ) {
      throw new Error(`Loop archive workspace ${label} branch is invalid`);
    }
  }
  if (
    value.finish !== null &&
    value.finish !== 'merge' &&
    value.finish !== 'push' &&
    value.finish !== 'pull-request' &&
    value.finish !== 'keep'
  ) {
    throw new Error('Loop archive workspace finish is invalid');
  }
  if (
    (value.isolation === 'branch' || value.isolation === 'worktree') &&
    (value.changeBranch === null || value.targetBranch === null || value.finish === null)
  ) {
    throw new Error('Loop isolated archive workspace requires branches and a finish action');
  }
  if (value.isolation === 'current' && value.finish !== null) {
    throw new Error('Loop current archive workspace cannot have a finish action');
  }
  return { ...value };
}

function normalizeSpec(value: LoopArchiveSpecFact, index: number): LoopArchiveSpecFact {
  if (!NAME_PATTERN.test(value.capability)) {
    throw new Error(`Loop archive spec ${index} capability is invalid`);
  }
  if (
    value.operation !== 'create' &&
    value.operation !== 'replace' &&
    value.operation !== 'remove'
  ) {
    throw new Error(`Loop archive spec ${value.capability} operation is invalid`);
  }
  const expectedBaseHash = optionalHash(
    value.expectedBaseHash,
    `Loop archive spec ${value.capability} expected base`,
  );
  const actualBaseHash = optionalHash(
    value.actualBaseHash,
    `Loop archive spec ${value.capability} actual base`,
  );
  const proposedHash = optionalHash(
    value.proposedHash,
    `Loop archive spec ${value.capability} proposed content`,
  );
  if (value.operation === 'create' && expectedBaseHash !== null) {
    throw new Error(`Loop archive create ${value.capability} must expect no canonical base`);
  }
  if (value.operation !== 'create' && expectedBaseHash === null) {
    throw new Error(`Loop archive ${value.operation} ${value.capability} requires a base hash`);
  }
  if ((value.operation === 'remove') !== (proposedHash === null)) {
    throw new Error(`Loop archive ${value.operation} ${value.capability} proposed hash is invalid`);
  }
  return {
    capability: value.capability,
    operation: value.operation,
    expectedBaseHash,
    actualBaseHash,
    proposedHash,
  };
}

function normalizeEvidence(value: LoopArchiveEvidenceFact): LoopArchiveEvidenceFact {
  if (value.result !== 'pending' && value.result !== 'pass' && value.result !== 'fail') {
    throw new Error('Loop archive verification result is invalid');
  }
  if (!['missing', 'invalid', 'stale', 'complete', 'partial'].includes(value.freshness)) {
    throw new Error('Loop archive verification freshness is invalid');
  }
  if (!Number.isSafeInteger(value.skippedAcceptanceCount) || value.skippedAcceptanceCount < 0) {
    throw new Error('Loop archive skipped acceptance count is invalid');
  }
  const normalized = {
    result: value.result,
    freshness: value.freshness,
    contractHash: optionalHash(value.contractHash, 'Loop archive contract hash'),
    acceptanceHash: optionalHash(value.acceptanceHash, 'Loop archive acceptance hash'),
    implementationScopeHash: optionalHash(
      value.implementationScopeHash,
      'Loop archive implementation scope hash',
    ),
    reportHash: optionalHash(value.reportHash, 'Loop archive report hash'),
    envelopeHash: optionalHash(value.envelopeHash, 'Loop archive envelope hash'),
    partialAllowanceHash: optionalHash(
      value.partialAllowanceHash,
      'Loop archive partial allowance hash',
    ),
    skippedAcceptanceCount: value.skippedAcceptanceCount,
  };
  if (
    (value.freshness === 'complete' || value.freshness === 'partial') &&
    [
      normalized.contractHash,
      normalized.acceptanceHash,
      normalized.implementationScopeHash,
      normalized.reportHash,
      normalized.envelopeHash,
    ].some((entry) => entry === null)
  ) {
    throw new Error('Fresh Loop archive evidence requires every bound content hash');
  }
  if (
    (value.freshness === 'partial' && normalized.partialAllowanceHash === null) ||
    (value.freshness === 'complete' && normalized.partialAllowanceHash !== null)
  ) {
    throw new Error('Loop archive partial evidence allowance state is invalid');
  }
  return normalized;
}

function normalizeFindingCodes(values: readonly string[]): string[] {
  if (values.length > 64) throw new Error('Loop archive preflight has too many findings');
  const codes = values.map((value) => {
    if (typeof value !== 'string' || !FINDING_PATTERN.test(value)) {
      throw new Error(`Loop archive preflight finding code is invalid: ${String(value)}`);
    }
    return value;
  });
  const normalized = [...new Set(codes)].sort(compareText);
  if (normalized.length !== codes.length) {
    throw new Error('Loop archive preflight has duplicate finding codes');
  }
  return normalized;
}

function derivedFindings(input: {
  phase: LoopPhase;
  archived: boolean;
  pendingJournal: boolean;
  targetExists: boolean;
  specs: readonly LoopArchiveSpecFact[];
  evidence: LoopArchiveEvidenceFact;
}): string[] {
  const findings: string[] = [];
  if (input.phase !== 'archive') findings.push('archive-phase-required');
  if (input.archived) findings.push('change-already-archived');
  if (input.pendingJournal) findings.push('pending-journal');
  if (input.targetExists) findings.push('archive-target-exists');
  if (input.evidence.result !== 'pass') findings.push('verification-not-passed');
  if (input.evidence.freshness === 'missing') findings.push('verification-evidence-missing');
  if (input.evidence.freshness === 'invalid') findings.push('verification-evidence-invalid');
  if (input.evidence.freshness === 'stale') findings.push('verification-evidence-stale');
  if (input.evidence.skippedAcceptanceCount > 0) {
    findings.push('verification-acceptance-skipped');
  }
  for (const spec of input.specs) {
    if (spec.actualBaseHash !== spec.expectedBaseHash) findings.push('spec-base-conflict');
  }
  return [...new Set(findings)].sort(compareText);
}

/** Build a pure, content-bound Archive preview. No path is read or written here. */
export function buildLoopArchivePreflight(input: LoopArchivePreflightInput): LoopArchivePreflight {
  if (!NAME_PATTERN.test(input.change)) throw new Error('Loop archive change name is invalid');
  if (typeof input.stateSchema !== 'string' || input.stateSchema.length === 0) {
    throw new Error('Loop archive state schema is invalid');
  }
  if (!Array.isArray(input.specs) || input.specs.length > 64) {
    throw new Error('Loop archive preflight exceeds its spec budget');
  }
  const specs = input.specs
    .map(normalizeSpec)
    .sort((left, right) => compareText(left.capability, right.capability));
  if (new Set(specs.map((spec) => spec.capability)).size !== specs.length) {
    throw new Error('Loop archive preflight contains duplicate capabilities');
  }
  const operations = specs.map((spec) => ({
    ...spec,
    operationHash: canonicalHash(OPERATION_HASH_TAG, spec),
  }));
  const evidence = normalizeEvidence(input.evidence);
  const workspace = normalizeWorkspace(input.workspace);
  const findingCodes = [
    ...new Set([
      ...normalizeFindingCodes(input.findingCodes ?? []),
      ...derivedFindings({
        phase: input.phase,
        archived: input.archived,
        pendingJournal: input.pendingJournal,
        targetExists: input.targetExists,
        specs,
        evidence,
      }),
    ]),
  ].sort(compareText);
  const revision = positiveRevision(input.revision);
  const targetRef = normalizedRef(input.targetRef, 'Loop archive target');
  if (input.archiveConfirmation !== 'automatic' && input.archiveConfirmation !== 'required') {
    throw new Error('Loop archive confirmation must be automatic or required');
  }
  const facts = {
    stateSchema: input.stateSchema,
    change: input.change,
    archiveConfirmation: input.archiveConfirmation,
    revision,
    phase: input.phase,
    archived: input.archived,
    pendingJournal: input.pendingJournal,
    targetRef,
    targetExists: input.targetExists,
    operations,
    evidence,
    workspace,
    findingCodes,
  };
  return {
    schema: LOOP_ARCHIVE_PREFLIGHT_SCHEMA,
    change: input.change,
    archiveConfirmation: input.archiveConfirmation,
    revision,
    targetRef,
    ready: findingCodes.length === 0,
    evidenceFreshness: evidence.freshness,
    operationCount: operations.length,
    operations,
    workspace,
    findingCodes,
    preflightHash: canonicalHash(PREFLIGHT_HASH_TAG, facts),
  };
}
