import { describe, expect, it } from 'vitest';

import { loopAdvanceEvidenceHash } from '../../../domains/owner-loop/loop-transition-evidence.js';

describe('Loop transition evidence hashing', () => {
  it('binds the Runtime-owned verification report input without duplicate receipt refs', () => {
    const baseline = {
      summary: 'Verify with report-owned evidence.',
      verificationResult: 'pass' as const,
      verificationReport: 'verification.md',
    };

    expect(
      loopAdvanceEvidenceHash({
        ...baseline,
        verificationReport: 'verification-retry.md',
      }),
    ).not.toBe(loopAdvanceEvidenceHash(baseline));
  });

  it('binds a repair override independently from verification evidence', () => {
    const evidence = {
      summary: 'Retry with a new repair hypothesis.',
      artifacts: ['src/repair.ts'],
    };
    expect(loopAdvanceEvidenceHash(evidence)).not.toBe(
      loopAdvanceEvidenceHash({
        ...evidence,
        repairOverrideSignature: 'a'.repeat(64),
        repairOverrideSummary: 'Try the alternate parser boundary.',
      }),
    );
  });
});
