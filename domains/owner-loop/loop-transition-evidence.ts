import { sha256Text } from './loop-hash.js';
import type { LoopAdvanceEvidence } from './loop-types.js';

/** Stable hash for the model-supplied phase evidence; it deliberately excludes hidden reasoning. */
export function loopAdvanceEvidenceHash(evidence: LoopAdvanceEvidence): string {
  return sha256Text(
    JSON.stringify({
      summary: evidence.summary,
      returnToBuild: evidence.returnToBuild ?? false,
      confirmed: evidence.confirmed ?? false,
      artifacts: [...(evidence.artifacts ?? [])].sort(),
      noCodeReason: evidence.noCodeReason ?? null,
      verificationResult: evidence.verificationResult ?? null,
      verificationReport: evidence.verificationReport ?? null,
      allowPartialScopeHash: evidence.allowPartialScopeHash ?? null,
      partialReason: evidence.partialReason ?? null,
      repairOverrideSignature: evidence.repairOverrideSignature ?? null,
      repairOverrideSummary: evidence.repairOverrideSummary ?? null,
    }),
  );
}
