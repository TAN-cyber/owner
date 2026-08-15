import { describe, expect, it } from 'vitest';
import { evaluateClassicRuntimeStep } from '../../../domains/owner-classic/classic-runtime-evals.js';

describe('Classic runtime eval readiness', () => {
  it('requires proposal and tasks evidence for full.open', () => {
    expect(
      evaluateClassicRuntimeStep('full.open', [
        { code: 'openspec.proposal', satisfied: true },
        { code: 'openspec.tasks', satisfied: false },
      ]),
    ).toEqual({
      stepId: 'full.open',
      passed: false,
      requiredEvidence: ['openspec.proposal', 'openspec.tasks'],
      missingEvidence: ['openspec.tasks'],
    });
  });

  it('passes when all required evidence is satisfied', () => {
    expect(
      evaluateClassicRuntimeStep('full.verify.branch', [
        { code: 'verification.report', satisfied: true },
      ]),
    ).toMatchObject({ stepId: 'full.verify.branch', passed: true, missingEvidence: [] });
  });
});
