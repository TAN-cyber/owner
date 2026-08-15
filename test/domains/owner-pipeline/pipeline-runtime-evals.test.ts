import { describe, expect, it } from 'vitest';
import { evaluatePipelineRuntimeStep } from '../../../domains/owner-pipeline/pipeline-runtime-evals.js';

describe('Pipeline runtime eval readiness', () => {
  it('requires proposal and tasks evidence for full.open', () => {
    expect(
      evaluatePipelineRuntimeStep('full.open', [
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
      evaluatePipelineRuntimeStep('full.verify.branch', [
        { code: 'verification.report', satisfied: true },
      ]),
    ).toMatchObject({ stepId: 'full.verify.branch', passed: true, missingEvidence: [] });
  });
});
