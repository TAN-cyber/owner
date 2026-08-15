import { promises as fs } from 'fs';
import path from 'path';

import {
  validateLoopBrief,
  validateLoopSpecChanges,
  validateLoopVerification,
} from './loop-artifacts.js';
import { loopChangeDir } from './loop-change.js';
import { isInsidePath } from './loop-paths.js';
import { inspectLoopRunConsistency } from './loop-run-consistency.js';
import {
  filterLoopContentSnapshotToProjectScope,
  readLoopBaselineManifest,
} from './loop-snapshot.js';
import type {
  LoopAdvanceEvidence,
  LoopArtifactValidation,
  LoopChangeState,
  LoopClarificationMode,
  LoopFinding,
  LoopProjectPaths,
} from './loop-types.js';

function validation(findings: LoopFinding[]): LoopArtifactValidation {
  return { valid: findings.length === 0, findings };
}

async function validateBuildArtifacts(
  paths: LoopProjectPaths,
  evidence: LoopAdvanceEvidence,
): Promise<LoopFinding[]> {
  const findings: LoopFinding[] = [];
  if ((evidence.noCodeReason ?? '').trim().length > 0) return findings;
  if (!evidence.artifacts || evidence.artifacts.length === 0) {
    return [
      {
        code: 'build-evidence-missing',
        message: 'Build requires an artifact reference or an explicit no-code reason',
      },
    ];
  }
  for (const artifact of evidence.artifacts) {
    if (
      path.isAbsolute(artifact) ||
      artifact.split(/[\\/]/u).includes('..') ||
      /^(?:[A-Za-z]:|~|[\\/])/u.test(artifact)
    ) {
      findings.push({
        code: 'build-artifact-unsafe',
        message: `Unsafe build artifact: ${artifact}`,
      });
      continue;
    }
    const target = path.resolve(paths.projectRoot, ...artifact.split(/[\\/]/u));
    if (!isInsidePath(paths.projectRoot, target)) {
      findings.push({
        code: 'build-artifact-unsafe',
        message: `Unsafe build artifact: ${artifact}`,
      });
      continue;
    }
    try {
      await fs.access(target);
    } catch {
      findings.push({
        code: 'build-artifact-missing',
        message: `Build artifact does not exist: ${artifact}`,
        path: artifact,
      });
    }
  }
  return findings;
}

export async function inspectLoopGuard(options: {
  paths: LoopProjectPaths;
  state: LoopChangeState;
  evidence: LoopAdvanceEvidence;
  clarificationMode: LoopClarificationMode;
}): Promise<LoopArtifactValidation> {
  const findings: LoopFinding[] = [];
  const changeDir = loopChangeDir(options.paths, options.state.name);
  if (options.evidence.summary.trim().length === 0) {
    findings.push({
      code: 'transition-summary-missing',
      message: 'Phase transition requires a summary',
    });
  }
  if (
    options.evidence.confirmed &&
    options.state.phase !== 'shape' &&
    options.state.phase !== 'build'
  ) {
    findings.push({
      code: 'confirmation-not-shape',
      message: 'Explicit confirmation is only valid while leaving Shape or Build',
    });
  }
  findings.push(...(await inspectLoopRunConsistency(options.paths, options.state)));
  if (options.state.phase === 'shape' || options.state.phase === 'build') {
    const capturedBaseline = await readLoopBaselineManifest(options.paths, options.state.name);
    if (capturedBaseline === null) {
      findings.push({
        code: 'baseline-snapshot-missing',
        message: 'Loop baseline is missing; restore a trusted baseline before advancing',
      });
    } else {
      const baseline = await filterLoopContentSnapshotToProjectScope(
        options.paths,
        capturedBaseline,
      );
      if (!baseline.complete) {
        findings.push({
          code: 'baseline-snapshot-incomplete',
          message: `Loop baseline is incomplete within the project-owned scope (${baseline.omittedCount} omitted entries); resolve the omissions before advancing`,
        });
      }
    }
  }
  if (options.state.phase === 'shape') {
    const brief = await validateLoopBrief(changeDir, options.state.brief);
    const specs = await validateLoopSpecChanges(options.paths, options.state);
    findings.push(...brief.findings, ...specs.findings);
    if (findings.length === 0 && !options.evidence.confirmed) {
      findings.push({
        code: 'shape-confirmation-required',
        message:
          'Loop clarification requires explicit user confirmation of the shared understanding before Build',
      });
    }
  } else if (options.state.phase === 'build') {
    findings.push(
      ...(await validateLoopBrief(changeDir, options.state.brief)).findings,
      ...(await validateLoopSpecChanges(options.paths, options.state)).findings,
    );
    findings.push(...(await validateBuildArtifacts(options.paths, options.evidence)));
    if (
      findings.length === 0 &&
      options.state.approval !== 'confirmed' &&
      !options.evidence.confirmed
    ) {
      findings.push({
        code: 'approval-confirmation-required',
        message:
          'Loop approval is implicit; confirm the current shared understanding before leaving Build',
      });
    }
  } else if (options.state.phase === 'verify') {
    const report = options.evidence.verificationReport ?? options.state.verification_report;
    if (!report) {
      findings.push({
        code: 'verification-report-missing',
        message: 'Verify requires a report path',
      });
    } else {
      findings.push(...(await validateLoopVerification(changeDir, report)).findings);
    }
    if (!options.evidence.verificationResult) {
      findings.push({
        code: 'verification-result-missing',
        message: 'Verify requires pass or fail',
      });
    }
    findings.push(...(await validateLoopSpecChanges(options.paths, options.state)).findings);
  } else {
    findings.push({
      code: 'archive-command-required',
      message: 'Use owner loop archive for the Archive phase',
    });
  }
  return validation(findings);
}
