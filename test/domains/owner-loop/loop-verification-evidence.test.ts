import { describe, expect, it } from 'vitest';

import {
  buildLoopAcceptanceEvidenceTrace,
  buildLoopPartialAllowance,
  buildLoopVerificationEvidenceEnvelope,
  parseLoopAcceptanceEvidenceTrace,
  parseLoopVerificationEvidenceEnvelope,
} from '../../../domains/owner-loop/loop-verification-evidence.js';
import { buildLoopContractSnapshot } from '../../../domains/owner-loop/loop-contract.js';
import { canonicalHash } from '../../../domains/owner-loop/loop-canonical-hash.js';
import type { LoopContentSnapshotManifest } from '../../../domains/owner-loop/loop-types.js';
import { buildLoopImplementationScopeBundle } from '../../../domains/owner-loop/loop-verification-scope.js';

const contract = buildLoopContractSnapshot({
  briefMarkdown: '# Acceptance examples\n- The command succeeds.\n- Failure is visible.\n',
  specs: [],
});
const requiredReceiptRef = `runtime/evidence/receipts/${'b'.repeat(64)}.json`;

function evidenceForAll() {
  return contract.acceptance.map((criterion) => ({
    acceptance_id: criterion.id,
    status: 'passed' as const,
    evidence_refs: [`runtime/evidence/receipts/${criterion.id.slice('acceptance-'.length)}.json`],
  }));
}

function buildTrace(evidence = evidenceForAll()) {
  return buildLoopAcceptanceEvidenceTrace(contract.acceptance, evidence, {
    loopRootRef: 'owner',
  });
}

function snapshot(entries: LoopContentSnapshotManifest['entries']): LoopContentSnapshotManifest {
  return {
    schema: 'owner.loop.content-snapshot.v1',
    origin: 'explicit',
    createdAt: '2026-07-17T00:00:00.000Z',
    complete: true,
    limits: {
      maxFiles: 10,
      maxFileBytes: 1024,
      maxTotalBytes: 4096,
      maxManifestBytes: 4096,
    },
    entries,
    omitted: [],
    omittedCount: 0,
  };
}

function scopeBundle(declared: boolean) {
  return buildLoopImplementationScopeBundle({
    baseline: snapshot([]),
    current: snapshot([
      { path: 'src/login.ts', hash: 'a'.repeat(64), size: 10, type: 'file' },
      { path: 'src/session.ts', hash: 'b'.repeat(64), size: 12, type: 'file' },
    ]),
    contractHash: contract.contractHash,
    declaredArtifacts: declared
      ? [
          { path: 'src/login.ts', kind: 'file' },
          { path: 'src/session.ts', kind: 'file' },
        ]
      : [],
  });
}

describe('Loop acceptance evidence trace', () => {
  it('requires exact coverage and is stable across evidence order', () => {
    const first = buildTrace();
    const reordered = buildTrace(evidenceForAll().reverse());

    expect(first).toEqual(reordered);
    expect(first).toMatchObject({ total: 2, evidenced: 2, skipped: 0 });
    expect(first.traceHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('rejects missing, unknown, duplicate, or ambiguous entries', () => {
    const [first] = evidenceForAll();
    expect(() => buildTrace([first])).toThrow('missing 1 acceptance evidence entry');
    expect(() =>
      buildTrace([
        ...evidenceForAll(),
        {
          acceptance_id: `acceptance-${'f'.repeat(64)}`,
          evidence_refs: [`runtime/evidence/receipts/${'f'.repeat(64)}.json`],
        },
      ]),
    ).toThrow('unknown acceptance ID');
    expect(() => buildTrace([first, first])).toThrow('repeats acceptance ID');
    expect(() =>
      buildTrace([{ ...first, skipped_reason: 'not run' }, evidenceForAll()[1]]),
    ).toThrow('invalid evidence state');
  });

  it('projects omitted evidence as a validated missing gap for failed verification', () => {
    const [first] = evidenceForAll();
    const trace = buildLoopAcceptanceEvidenceTrace(contract.acceptance, [first], {
      loopRootRef: 'owner',
      allowMissing: true,
    });

    expect(trace.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ acceptanceId: first.acceptance_id, status: 'passed' }),
        expect.objectContaining({ status: 'missing', evidenceRefs: [], skippedReason: null }),
      ]),
    );
    expect(parseLoopAcceptanceEvidenceTrace(trace)).toEqual(trace);
  });

  it('bounds missing-coverage diagnostics instead of echoing every acceptance ID', () => {
    const criteria = Array.from({ length: 100 }, (_, index) => ({
      id: `acceptance-${index.toString(16).padStart(64, '0')}`,
      kind: 'brief-example' as const,
      source: 'brief.md',
      context: [],
      text: `Criterion ${index}.`,
    }));
    let message = '';
    try {
      buildLoopAcceptanceEvidenceTrace(criteria, [], { loopRootRef: 'owner' });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('missing 100 acceptance evidence entries');
    expect(message).toContain('(92 more)');
    expect(Buffer.byteLength(message, 'utf8')).toBeLessThan(1_024);
    expect(message).not.toContain(criteria[8].id);
  });

  it('preserves an explicit skipped reason without calling it evidence', () => {
    const entries = evidenceForAll();
    entries[0] = {
      ...entries[0],
      status: 'failed',
      evidence_refs: [],
      skipped_reason: 'Platform unavailable',
    };
    const trace = buildTrace(entries);

    expect(trace).toMatchObject({ total: 2, evidenced: 1, skipped: 1 });
  });

  it('binds a failed typed receipt instead of discarding executed failure evidence', () => {
    const entries = evidenceForAll();
    entries[0] = {
      ...entries[0],
      status: 'failed',
      skipped_reason: 'The automated check returned a non-zero exit code.',
    };
    const trace = buildTrace(entries);

    expect(trace).toMatchObject({ total: 2, evidenced: 2, skipped: 1 });
    expect(trace.entries).toContainEqual(
      expect.objectContaining({
        acceptanceId: entries[0].acceptance_id,
        status: 'failed',
        evidenceRefs: entries[0].evidence_refs,
      }),
    );
  });

  it('rejects sensitive refs and deeply invalid traces even when their self-hash is refreshed', () => {
    const sensitive = evidenceForAll();
    sensitive[0] = { ...sensitive[0], evidence_refs: ['runtime/forged-receipt.json'] };
    expect(() => buildTrace(sensitive)).toThrow('typed v3 receipt');

    const trace = buildTrace();
    const malformed = structuredClone(trace) as typeof trace & {
      entries: Array<(typeof trace.entries)[number] & { trusted?: boolean }>;
    };
    malformed.entries[0].trusted = true;
    const content = { ...malformed } as Partial<typeof malformed>;
    delete content.traceHash;
    malformed.traceHash = canonicalHash('owner.loop.acceptance-trace.v1', content);
    expect(() => parseLoopAcceptanceEvidenceTrace(malformed)).toThrow('unknown field');
  });

  it.each(['docs/owner/changes/secure-login/runtime/receipt.json', '.npmrc', '.pypirc', '.netrc'])(
    'rejects dynamic Loop-root or credential ref %s',
    (reference) => {
      const evidence = evidenceForAll();
      evidence[0] = { ...evidence[0], evidence_refs: [reference] };
      expect(() =>
        buildLoopAcceptanceEvidenceTrace(contract.acceptance, evidence, {
          loopRootRef: 'docs/owner',
        }),
      ).toThrow('typed v3 receipt');
    },
  );
});

describe('Loop partial allowance and verification envelope', () => {
  it('requires confirmation to name every unresolved scope exactly', () => {
    const partialBundle = scopeBundle(false);
    const partialScope = partialBundle.scope;
    const scopeIds = partialScope.unresolvedScopes.map((entry) => entry.id);
    expect(() =>
      buildLoopPartialAllowance({
        change: 'secure-login',
        scopeBundle: partialBundle,
        allowedScopeIds: [scopeIds[0]],
        reason: 'Known fixture limitation',
        confirmedSummary: 'User accepted both missing scopes',
        sourceRevision: 3,
      }),
    ).toThrow('missing scope IDs');

    const allowance = buildLoopPartialAllowance({
      change: 'secure-login',
      scopeBundle: partialBundle,
      allowedScopeIds: [...scopeIds].reverse(),
      reason: 'Known fixture limitation',
      confirmedSummary: 'User accepted the exact partial boundary',
      sourceRevision: 3,
      now: new Date('2026-07-17T00:00:00.000Z'),
    });
    expect(allowance.scopeIds).toEqual([...scopeIds].sort());
    expect(allowance.allowanceHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('builds complete evidence without allowance and partial evidence only with a matching one', () => {
    const trace = buildTrace();
    const completeBundle = scopeBundle(true);
    const completeScope = completeBundle.scope;
    const complete = buildLoopVerificationEvidenceEnvelope({
      change: 'secure-login',
      sourceRevision: 4,
      result: 'pass',
      contractHash: contract.contractHash,
      acceptanceHash: contract.acceptanceHash,
      implementationScope: {
        ref: `runtime/evidence/scopes/${completeScope.scopeHash}.json`,
        bundle: completeBundle,
      },
      reportRef: 'verification.md',
      reportHash: 'd'.repeat(64),
      acceptanceTrace: trace,
      requiredReceiptRefs: [requiredReceiptRef],
      now: new Date('2026-07-17T00:00:00.000Z'),
    });
    expect(complete).toMatchObject({ freshness: 'complete', partialAllowanceRef: null });
    expect(() => parseLoopVerificationEvidenceEnvelope({ ...complete, waiverRefs: [] })).toThrow(
      'unknown field',
    );
    expect(() =>
      parseLoopVerificationEvidenceEnvelope({
        ...complete,
        independentReviewReceiptRef: null,
      }),
    ).toThrow('unknown field');

    const partialBundle = scopeBundle(false);
    const partialScope = partialBundle.scope;
    expect(() =>
      buildLoopVerificationEvidenceEnvelope({
        change: 'secure-login',
        sourceRevision: 4,
        result: 'pass',
        contractHash: contract.contractHash,
        acceptanceHash: contract.acceptanceHash,
        implementationScope: {
          ref: `runtime/evidence/scopes/${partialScope.scopeHash}.json`,
          bundle: partialBundle,
        },
        reportRef: 'verification.md',
        reportHash: 'd'.repeat(64),
        acceptanceTrace: trace,
        requiredReceiptRefs: [requiredReceiptRef],
      }),
    ).toThrow('requires a confirmed allowance');

    const scopeIds = partialScope.unresolvedScopes.map((entry) => entry.id);
    const allowance = buildLoopPartialAllowance({
      change: 'secure-login',
      scopeBundle: partialBundle,
      allowedScopeIds: scopeIds,
      reason: 'Known fixture limitation',
      confirmedSummary: 'Accepted partial verification',
      sourceRevision: 3,
      now: new Date('2026-07-17T00:00:00.000Z'),
    });
    const partial = buildLoopVerificationEvidenceEnvelope({
      change: 'secure-login',
      sourceRevision: 4,
      result: 'pass',
      contractHash: contract.contractHash,
      acceptanceHash: contract.acceptanceHash,
      implementationScope: {
        ref: `runtime/evidence/scopes/${partialScope.scopeHash}.json`,
        bundle: partialBundle,
      },
      reportRef: 'verification.md',
      reportHash: 'd'.repeat(64),
      acceptanceTrace: trace,
      requiredReceiptRefs: [requiredReceiptRef],
      partialAllowance: {
        ref: `runtime/evidence/allowances/${allowance.allowanceHash}.json`,
        allowance,
      },
      now: new Date('2026-07-17T00:00:00.000Z'),
    });
    expect(partial).toMatchObject({
      freshness: 'partial',
      partialAllowanceHash: allowance.allowanceHash,
    });
  });

  it('derives completeness and contract identity from the supplied scope', () => {
    const completeBundle = scopeBundle(true);
    const completeScope = completeBundle.scope;
    expect(() =>
      buildLoopPartialAllowance({
        change: 'secure-login',
        scopeBundle: completeBundle,
        allowedScopeIds: [],
        reason: 'Should never be accepted',
        confirmedSummary: 'Should never be accepted',
        sourceRevision: 3,
      }),
    ).toThrow('cannot be partially allowed');

    const trace = buildTrace();
    expect(() =>
      buildLoopVerificationEvidenceEnvelope({
        change: 'secure-login',
        sourceRevision: 4,
        result: 'pass',
        contractHash: 'f'.repeat(64),
        acceptanceHash: contract.acceptanceHash,
        implementationScope: {
          ref: `runtime/evidence/scopes/${completeScope.scopeHash}.json`,
          bundle: completeBundle,
        },
        reportRef: 'verification.md',
        reportHash: 'd'.repeat(64),
        acceptanceTrace: trace,
        requiredReceiptRefs: [requiredReceiptRef],
      }),
    ).toThrow('does not match the verification contract');
  });
});
