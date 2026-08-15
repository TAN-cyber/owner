import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLoopChange } from '../../../domains/owner-loop/loop-change.js';
import {
  structureLoopFindings,
  summarizeLoopFindings,
} from '../../../domains/owner-loop/loop-findings.js';
import { loopProjectPaths } from '../../../domains/owner-loop/loop-paths.js';
import type { LoopChangeState, LoopProjectPaths } from '../../../domains/owner-loop/loop-types.js';

describe('Loop structured findings', () => {
  let projectRoot: string;
  let paths: LoopProjectPaths;
  let state: LoopChangeState;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-findings-'));
    paths = await loopProjectPaths(projectRoot, '.');
    state = await createLoopChange({
      paths,
      name: 'finding-shape',
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('normalizes project-relative paths and emits stable metadata order', () => {
    const findings = structureLoopFindings({
      paths,
      state,
      findings: [
        { code: 'spec-base-conflict', message: 'spec conflict', path: paths.specsDir },
        { code: 'brief-section-empty', message: 'empty brief', path: 'brief.md' },
      ],
    });

    expect(findings.map((finding) => finding.code)).toEqual([
      'brief-section-empty',
      'spec-base-conflict',
    ]);
    expect(findings[0]).toMatchObject({
      severity: 'error',
      path: 'owner/changes/finding-shape/brief.md',
      requiredAction: 'complete-brief',
      retryCommand: 'owner loop next finding-shape --summary "<summary>"',
      repairCommand: null,
      requiresUserDecision: false,
    });
    expect(findings[1].path).toBe('owner/specs');
  });

  it('reserves user-decision pauses for explicit clarification decisions', () => {
    const findings = structureLoopFindings({
      paths,
      state,
      findings: [
        { code: 'brief-blocking-question', message: 'decision needed', path: 'brief.md' },
        {
          code: 'shape-confirmation-required',
          message: 'shared understanding must be confirmed',
        },
        { code: 'build-evidence-missing', message: 'model work needed' },
      ],
    });
    expect(findings.find((finding) => finding.code === 'brief-blocking-question')).toMatchObject({
      requiredAction: 'answer-blocking-question',
      requiresUserDecision: true,
    });
    expect(
      findings.find((finding) => finding.code === 'shape-confirmation-required'),
    ).toMatchObject({
      requiredAction: 'confirm-shared-understanding',
      retryCommand: 'owner loop next finding-shape --summary "<summary>" --confirmed',
      requiresUserDecision: true,
    });
    expect(findings.find((finding) => finding.code === 'build-evidence-missing')).toMatchObject({
      requiredAction: 'record-build-evidence',
      requiresUserDecision: false,
    });
    expect(summarizeLoopFindings(findings)).toMatchObject({
      total: 3,
      errors: 3,
      requiresUserDecision: true,
      truncated: false,
    });
  });

  it('routes stale implementation scope back to Build without a user decision', () => {
    const [finding] = structureLoopFindings({
      paths,
      state: { ...state, phase: 'verify' },
      findings: [
        {
          code: 'verification-implementation-stale',
          message: 'The implementation changed after Build.',
        },
      ],
    });

    expect(finding).toMatchObject({
      requiredAction: 'return-to-build-and-refresh-implementation-scope',
      retryCommand: 'owner loop next finding-shape --summary "<summary>"',
      repairCommand: null,
      requiresUserDecision: false,
    });
  });

  it('reserves repair decisions for exhausted overrides and verification budgets', () => {
    const findings = structureLoopFindings({
      paths,
      state,
      findings: [
        { code: 'repair-stagnation-stop', message: 'A repeated failure needs a new hypothesis.' },
        { code: 'repair-override-exhausted', message: 'The one repair override was exhausted.' },
        { code: 'repair-iteration-limit', message: 'The verification budget was exhausted.' },
      ],
    });

    expect(findings.find((finding) => finding.code === 'repair-stagnation-stop')).toMatchObject({
      requiredAction: 'try-new-repair-hypothesis-with-status-override',
      requiresUserDecision: false,
    });
    for (const code of ['repair-override-exhausted', 'repair-iteration-limit']) {
      expect(findings.find((finding) => finding.code === code)).toMatchObject({
        requiredAction: 'choose-repair-continuation',
        requiresUserDecision: true,
      });
    }
  });

  it('fails closed without advertising an impossible repair for an invalid checkpoint', () => {
    const [finding] = structureLoopFindings({
      paths,
      state,
      findings: [
        {
          code: 'checkpoint-progress-invalid',
          message: 'checkpoint document is malformed',
          path: 'owner/changes/finding-shape/runtime/checkpoints/progress.json',
        },
      ],
    });

    expect(finding).toMatchObject({
      requiredAction: 'manually-isolate-invalid-checkpoint',
      retryCommand: null,
      repairCommand: null,
      requiresUserDecision: false,
    });
  });

  it('advertises doctor only for findings with a real automatic repair path', () => {
    const repairable = structureLoopFindings({
      paths,
      state,
      findings: [
        { code: 'transition-incomplete', message: 'valid journal is pending' },
        { code: 'trajectory-tail-incomplete', message: 'partial final line' },
        { code: 'checkpoint-progress-incomplete', message: 'valid checkpoint journal is pending' },
      ],
    });
    expect(repairable.every((finding) => finding.repairCommand?.includes('doctor'))).toBe(true);

    const notAutomaticallyRepairable = structureLoopFindings({
      paths,
      state,
      findings: [
        { code: 'run-state-missing', message: 'missing Run state' },
        { code: 'run-id-mismatch', message: 'mismatched Run ID' },
        { code: 'trajectory-invalid', message: 'complete but invalid trajectory' },
        { code: 'checkpoint-missing', message: 'missing checkpoint' },
        { code: 'checkpoint-mismatch', message: 'mismatched checkpoint' },
        { code: 'checkpoint-invalid', message: 'invalid checkpoint' },
        { code: 'transition-invalid', message: 'invalid transition journal' },
      ],
    });
    for (const finding of notAutomaticallyRepairable) {
      expect(finding).toMatchObject({
        requiredAction: 'isolate-or-restore-loop-runtime-from-a-trusted-copy',
        retryCommand: null,
        repairCommand: null,
      });
    }
  });
});
