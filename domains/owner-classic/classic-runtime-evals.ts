import type { ClassicEvidence } from './classic-evidence.js';
import { evidenceSatisfied } from './classic-evidence.js';

export interface ClassicRuntimeEvalStatus {
  stepId: string;
  passed: boolean;
  requiredEvidence: string[];
  missingEvidence: string[];
}

const STEP_EVIDENCE: Record<string, string[]> = {
  'full.open': ['openspec.proposal', 'openspec.tasks'],
  'full.design.handoff': ['openspec.proposal', 'openspec.design', 'openspec.tasks'],
  'full.design.document': ['design.handoff'],
  'full.build.plan': ['openspec.tasks'],
  'full.build.plan-ready': ['build.plan'],
  'full.build.configure': ['build.plan'],
  'full.build.execute': ['build.plan'],
  'full.build.complete': ['build.tasks-complete'],
  'full.verify.run': ['build.tasks-complete'],
  'full.verify.branch': ['verification.report'],
  'full.archive.confirm': ['verification.report'],
  'full.archive.execute': ['archive.confirmed'],
};

function requirementsFor(stepId: string): string[] {
  if (STEP_EVIDENCE[stepId]) return STEP_EVIDENCE[stepId];
  if (stepId.endsWith('.open')) return ['openspec.proposal', 'openspec.tasks'];
  if (stepId.endsWith('.build.execute')) return [];
  if (stepId.endsWith('.build.complete')) return ['build.tasks-complete'];
  if (stepId.endsWith('.verify.run')) return ['build.tasks-complete'];
  if (stepId.endsWith('.verify.branch')) return ['verification.report'];
  if (stepId.endsWith('.archive.confirm')) return ['verification.report'];
  if (stepId.endsWith('.archive.execute')) return ['archive.confirmed'];
  return [];
}

export function evaluateClassicRuntimeStep(
  stepId: string,
  evidence: readonly ClassicEvidence[],
): ClassicRuntimeEvalStatus {
  const requiredEvidence = requirementsFor(stepId);
  const missingEvidence = requiredEvidence.filter((code) => !evidenceSatisfied(evidence, code));
  return {
    stepId,
    passed: missingEvidence.length === 0,
    requiredEvidence,
    missingEvidence,
  };
}
