import { describe, expect, it } from 'vitest';

import {
  compareLoopReceiptBindings,
  loadLoopVerificationReceiptContext,
  loopReceiptBindingsMatch,
} from '../../../domains/owner-loop/loop-verification-receipt-runtime.js';
import type { LoopVerificationReceiptBindings } from '../../../domains/owner-loop/loop-verification-receipt.js';
import { buildLoopVerificationReceipt } from '../../../domains/owner-loop/loop-verification-receipt.js';
import {
  loopRepairFailedCheckIdsFromReceipts,
  projectLoopRepairDecision,
} from '../../../domains/owner-loop/loop-repair-integration.js';

const hash = (character: string) => character.repeat(64);
const baseBindings: LoopVerificationReceiptBindings = {
  change: 'typed-evidence',
  sourceRevision: 3,
  contractHash: hash('1'),
  scopeHash: hash('2'),
  snapshotHash: hash('3'),
  artifactHash: hash('4'),
};

describe('compareLoopReceiptBindings', () => {
  it('reports ok with no mismatches when bindings are identical', () => {
    const result = compareLoopReceiptBindings({ bindings: baseBindings }, baseBindings);
    expect(result).toEqual({ ok: true, mismatches: [] });
  });

  it('loopReceiptBindingsMatch stays a boolean wrapper over the comparison', () => {
    expect(loopReceiptBindingsMatch({ bindings: baseBindings }, baseBindings)).toBe(true);
    expect(
      loopReceiptBindingsMatch({ bindings: { ...baseBindings, sourceRevision: 5 } }, baseBindings),
    ).toBe(false);
  });

  it.each([
    ['change', 'typed-evidence', 'other-change'],
    ['sourceRevision', 3, 6],
    ['contractHash', hash('1'), hash('9')],
    ['scopeHash', hash('2'), hash('8')],
    ['snapshotHash', hash('3'), hash('7')],
    ['artifactHash', hash('4'), hash('6')],
  ] as const)(
    'reports a per-field mismatch for %s with expected/got values',
    (field, expected, actual) => {
      const divergent: LoopVerificationReceiptBindings = {
        ...baseBindings,
        [field]: actual,
      } as LoopVerificationReceiptBindings;
      const result = compareLoopReceiptBindings({ bindings: divergent }, baseBindings);
      expect(result.ok).toBe(false);
      expect(result.mismatches).toEqual([
        `${field}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      ]);
    },
  );

  it('collects every diverging field at once rather than the first', () => {
    const divergent: LoopVerificationReceiptBindings = {
      ...baseBindings,
      sourceRevision: 6,
      artifactHash: hash('6'),
    };
    const result = compareLoopReceiptBindings({ bindings: divergent }, baseBindings);
    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual([
      'sourceRevision: expected 3, got 6',
      `artifactHash: expected ${JSON.stringify(hash('4'))}, got ${JSON.stringify(hash('6'))}`,
    ]);
  });

  it('rejects receipt context creation before reading files when Verify prerequisites are absent', async () => {
    const paths = {} as never;
    await expect(
      loadLoopVerificationReceiptContext(paths, {
        phase: 'shape',
      } as never),
    ).rejects.toThrow(/requires Verify/u);
    await expect(
      loadLoopVerificationReceiptContext(paths, {
        phase: 'verify',
        implementation_scope: null,
      } as never),
    ).rejects.toThrow(/implementation scope/u);
  });

  it('projects repair decisions and derives stable failed-check identifiers', () => {
    const bindings = { ...baseBindings };
    const acceptanceId = `acceptance-${'a'.repeat(64)}`;
    const failedManual = buildLoopVerificationReceipt({
      kind: 'manual-evidence',
      role: 'acceptance-evidence',
      status: 'failed',
      bindings,
      acceptanceIds: [acceptanceId],
      actor: 'loop-runtime:test',
      issuedAt: '2026-08-12T00:00:00.000Z',
      evidence: { steps: ['step'], observations: ['failed'] },
    });
    const passedManual = buildLoopVerificationReceipt({
      kind: 'manual-evidence',
      role: 'acceptance-evidence',
      status: 'passed',
      bindings,
      acceptanceIds: [acceptanceId],
      actor: 'loop-runtime:test',
      issuedAt: '2026-08-12T00:00:00.000Z',
      evidence: { steps: ['step'], observations: ['passed'] },
    });
    const failedIds = loopRepairFailedCheckIdsFromReceipts([failedManual, passedManual]);
    expect(failedIds).toHaveLength(1);
    expect(failedIds[0]).toMatch(/^manual:/u);
    expect(
      projectLoopRepairDecision({
        decision: {
          disposition: 'manual-stop',
          reasonCode: 'repeated-failure-stop',
          signature: { signatureHash: 'f'.repeat(64) },
          consecutiveFailures: 2,
          totalRepairFailures: 3,
          remainingIterations: 2,
          overrideAccepted: false,
        },
      } as never),
    ).toEqual({
      disposition: 'manual-stop',
      reasonCode: 'repeated-failure-stop',
      signatureHash: 'f'.repeat(64),
      consecutiveFailures: 2,
      totalRepairFailures: 3,
      remainingIterations: 2,
      overrideAccepted: false,
    });
  });
});
