import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  applyLoopVerifierEnvelope,
  confirmLoopPortableAcceptance,
  reserveLoopVerifierAttempt,
  submitLoopBuilderCandidate,
} from '../../../domains/owner-loop/loop-loop-runtime.js';
import { createLoopPortableState } from '../../../domains/owner-loop/loop-portable-state.js';
import { toLoopPortableText } from '../../../domains/owner-loop/loop-portable-text.js';
import { createLoopRunnerChannel } from '../../../domains/owner-loop/loop-runner-protocol.js';
import {
  inspectLoopVerificationReportAlignment,
  loopVerificationReportStateVersion,
  renderLoopVerificationReport,
  writeLoopVerificationReport,
} from '../../../domains/owner-loop/loop-verification-report-v2.js';

describe('Loop verification report projection', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  function passedState() {
    const runner = createLoopRunnerChannel();
    let state = confirmLoopPortableAcceptance({
      state: createLoopPortableState({ name: 'report-change', language: 'en' }),
      acceptance: [{ id: 'A1', source: 'brief.md', text: 'The report is readable.' }],
    });
    state = submitLoopBuilderCandidate({
      state,
      input: {
        identity: runner.captureExecutionIdentity({
          identityProvider: 'test-host',
          executionRef: 'builder',
        }),
        candidateId: 'candidate',
        summary: 'Built it.',
        addressedAcceptanceIds: ['A1'],
      },
    });
    state = reserveLoopVerifierAttempt(state);
    return applyLoopVerifierEnvelope({
      state,
      checks: [
        {
          id: 'test',
          name: toLoopPortableText('Tests'),
          argv_display: [toLoopPortableText('test')],
          argv_truncated: false,
          cwd_ref: '.',
          status: 'passed',
          exit_code: 0,
          duration_ms: 10,
        },
      ],
      maxVerifyFailures: 5,
      envelope: runner.envelopeVerifierResponse({
        candidateId: 'candidate',
        identity: runner.captureExecutionIdentity({
          identityProvider: 'test-host',
          executionRef: 'verifier',
        }),
        payload: {
          kind: 'final-result',
          result: {
            iteration: 1,
            attempt: 1,
            verdict: 'pass',
            acceptance: [{ id: 'A1', result: 'passed', reason: 'Read the generated report.' }],
            risks: [],
            summary: 'Verification passed.',
          },
        },
      }),
    }).state;
  }

  it('renders a human report bound only to the YAML state version', () => {
    const state = passedState();
    const report = renderLoopVerificationReport(state);
    expect(loopVerificationReportStateVersion(report)).toBe(state.state_version);
    expect(report).toContain('| A1 | passed |');
    expect(report).toContain('Verification passed.');
    expect(report).not.toMatch(/sha-?256|receipt|snapshot|evidence hash/iu);
  });

  it('rebuilds a missing or stale report without rerunning verification', async () => {
    const state = passedState();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-report-'));
    roots.push(root);
    const file = path.join(root, 'verification.md');
    expect(
      await inspectLoopVerificationReportAlignment({ file, stateVersion: state.state_version }),
    ).toBe('missing');
    await fs.writeFile(file, '---\ngenerated_from_state_version: 1\n---\nold\n');
    expect(
      await inspectLoopVerificationReportAlignment({ file, stateVersion: state.state_version }),
    ).toBe('stale');
    await writeLoopVerificationReport({ file, state });
    expect(
      await inspectLoopVerificationReportAlignment({ file, stateVersion: state.state_version }),
    ).toBe('aligned');
  });
});
