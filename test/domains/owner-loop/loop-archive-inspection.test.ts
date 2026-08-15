import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { inspectLoopArchivePreflight } from '../../../domains/owner-loop/loop-archive-inspection.js';
import { prepareLoopBuildEvidence } from '../../../domains/owner-loop/loop-build-evidence.js';
import {
  compareAndSwapLoopChangeFile,
  createLoopChange,
  loopChangeDir,
  writeLoopChange,
} from '../../../domains/owner-loop/loop-change.js';
import { collectLoopContractFiles } from '../../../domains/owner-loop/loop-contract-files.js';
import { loopChangeRuntimeDir, loopProjectPaths } from '../../../domains/owner-loop/loop-paths.js';
import { loopTransitionJournalFile } from '../../../domains/owner-loop/loop-transition-journal.js';
import { writeLoopWorkspaceIdentity } from '../../../domains/owner-loop/loop-workspace.js';
import type { LoopChangeState, LoopProjectPaths } from '../../../domains/owner-loop/loop-types.js';
import { prepareLoopVerificationEvidence } from '../../../domains/owner-loop/loop-verification-runtime.js';
import {
  issueLoopAutomatedCheckReceipt,
  findLoopReusableRequiredCheckReceipt,
  issueLoopManualEvidenceReceipt,
  validateLoopStaticReceiptDependency,
} from '../../../domains/owner-loop/loop-verification-receipt-runtime.js';
import {
  loopVerificationFixtureReceipt,
  loopVerificationFixtureReport,
} from '../../helpers/loop-verification.js';

const brief = `# Outcome
Ship one focused behavior.
# Scope
Update the focused file.
# Non-goals
No unrelated changes.
# Acceptance examples
- The focused behavior works.
# Constraints and invariants
Keep callers stable.
# Decisions
Use the current module.
# Open questions
None.
# Verification expectations
Run the focused check.
`;

describe('Loop Archive inspection', () => {
  let projectRoot: string;
  let paths: LoopProjectPaths;
  let state: LoopChangeState;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-archive-inspection-'));
    await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'src', 'feature.ts'), 'export const value = 1;\n');
    paths = await loopProjectPaths(projectRoot, '.');
    const created = await createLoopChange({
      paths,
      verificationProtocol: 'legacy-v1',
      name: 'archive-preview',
      language: 'en',
      now: new Date('2026-07-17T00:00:00.000Z'),
    });
    const changeDir = loopChangeDir(paths, created.name);
    await fs.writeFile(path.join(changeDir, 'brief.md'), brief);
    const buildState: LoopChangeState = {
      ...created,
      phase: 'build',
      approval: 'implicit',
    };
    await fs.writeFile(path.join(projectRoot, 'src', 'feature.ts'), 'export const value = 2;\n');
    const build = await prepareLoopBuildEvidence({
      paths,
      state: buildState,
      artifactRefs: ['src/feature.ts'],
      now: new Date('2026-07-17T01:00:00.000Z'),
    });
    const verifyCandidate: LoopChangeState = {
      ...buildState,
      phase: 'verify',
      implementation_scope: build.scopeRef as LoopChangeState['implementation_scope'],
    };
    const stateFile = path.join(changeDir, 'owner-state.yaml');
    const verifyState = await compareAndSwapLoopChangeFile(stateFile, verifyCandidate, 1);
    const contract = await collectLoopContractFiles({
      changeDir,
      briefRef: verifyState.brief,
      specChanges: verifyState.spec_changes,
    });
    const receiptRef = (
      await issueLoopManualEvidenceReceipt({
        paths,
        name: verifyState.name,
        acceptanceIds: contract.contract.acceptance.map((criterion) => criterion.id),
        steps: ['Run the focused archive inspection fixture.'],
        observations: ['The focused behavior matched the acceptance contract.'],
        confirmed: true,
        now: new Date('2026-07-17T01:30:00.000Z'),
      })
    ).ref;
    await fs.writeFile(
      path.join(changeDir, 'verification.md'),
      await loopVerificationFixtureReport({
        paths,
        name: verifyState.name,
        evidenceRefs: [receiptRef],
      }),
    );
    const requiredReceiptRef = await loopVerificationFixtureReceipt({
      paths,
      name: verifyState.name,
      now: new Date('2026-07-17T01:45:00.000Z'),
    });
    const verification = await prepareLoopVerificationEvidence({
      paths,
      state: verifyState,
      result: 'pass',
      reportRef: 'verification.md',
      receiptRef: requiredReceiptRef,
      now: new Date('2026-07-17T02:00:00.000Z'),
    });
    const archiveCandidate: LoopChangeState = {
      ...verifyState,
      phase: 'archive',
      verification_result: 'pass',
      verification_report: 'verification.md',
      verification_evidence: verification.evidenceRef as LoopChangeState['verification_evidence'],
    };
    state = await compareAndSwapLoopChangeFile(stateFile, archiveCandidate, 2);
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('returns a stable ready preview without writing project state', async () => {
    const changeFile = path.join(loopChangeDir(paths, state.name), 'owner-state.yaml');
    const before = await fs.readFile(changeFile, 'utf8');

    const first = await inspectLoopArchivePreflight({
      paths,
      name: state.name,
      now: new Date('2026-07-17T03:00:00.000Z'),
    });
    const second = await inspectLoopArchivePreflight({
      paths,
      name: state.name,
      now: new Date('2026-07-17T03:00:00.000Z'),
    });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      ready: true,
      revision: 3,
      targetRef: 'archive/2026-07-17-archive-preview',
      evidenceFreshness: 'complete',
      findingCodes: [],
    });
    expect(await fs.readFile(changeFile, 'utf8')).toBe(before);
  });

  it('validates manual acceptance IDs and automated command timeouts before execution', async () => {
    const verifyState = {
      ...state,
      phase: 'verify' as const,
      verification_result: 'pending' as const,
      verification_report: null,
      verification_evidence: null,
      revision: state.revision,
    };
    await writeLoopChange(paths, verifyState);
    await expect(
      findLoopReusableRequiredCheckReceipt({ paths, state: verifyState }),
    ).resolves.toBeNull();
    await expect(
      validateLoopStaticReceiptDependency({
        paths,
        state: verifyState,
        receipt: { kind: 'manual-evidence' } as never,
      }),
    ).resolves.toBeNull();
    await expect(
      issueLoopManualEvidenceReceipt({
        paths,
        name: verifyState.name,
        acceptanceIds: [],
        steps: ['step'],
        observations: ['observation'],
        now: new Date('2026-07-17T03:00:00.000Z'),
      }),
    ).rejects.toThrow('acceptance IDs do not match');
    await expect(
      issueLoopAutomatedCheckReceipt({
        paths,
        name: verifyState.name,
        acceptanceIds: [],
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        timeoutMs: 0,
      }),
    ).rejects.toThrow('timeout must be an integer');
    await expect(
      issueLoopAutomatedCheckReceipt({
        paths,
        name: verifyState.name,
        acceptanceIds: [],
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        timeoutMs: 60 * 60 * 1_000 + 1,
      }),
    ).rejects.toThrow('timeout must be an integer');
    const contract = await collectLoopContractFiles({
      changeDir: loopChangeDir(paths, verifyState.name),
      briefRef: verifyState.brief,
      specChanges: verifyState.spec_changes,
    });
    const acceptanceIds = contract.contract.acceptance.map((criterion) => criterion.id);
    const passed = await issueLoopAutomatedCheckReceipt({
      paths,
      name: verifyState.name,
      acceptanceIds,
      command: process.execPath,
      args: ['-e', "process.stdout.write('automated output')"],
      timeoutMs: 10_000,
      now: () => new Date('2026-07-17T03:01:00.000Z'),
    });
    expect(passed.receipt.status).toBe('passed');
    expect(passed.receipt.evidence).toMatchObject({
      exitCode: 0,
      signal: null,
      timedOut: false,
      outputSummary: 'automated output',
      outputTruncated: false,
    });
    const failed = await issueLoopAutomatedCheckReceipt({
      paths,
      name: verifyState.name,
      acceptanceIds,
      command: process.execPath,
      args: ['-e', 'process.exit(3)'],
      timeoutMs: 10_000,
      now: () => new Date('2026-07-17T03:02:00.000Z'),
    });
    expect(failed.receipt.status).toBe('failed');
    expect(failed.receipt.evidence).toMatchObject({
      exitCode: 3,
      signal: null,
      outputSummary: '(exit 3)',
    });
  });

  it('changes the preflight hash and blocks when implementation becomes stale', async () => {
    const before = await inspectLoopArchivePreflight({
      paths,
      name: state.name,
      now: new Date('2026-07-17T03:00:00.000Z'),
    });
    await fs.writeFile(path.join(projectRoot, 'src', 'feature.ts'), 'export const value = 3;\n');

    const after = await inspectLoopArchivePreflight({
      paths,
      name: state.name,
      now: new Date('2026-07-17T03:00:00.000Z'),
    });

    expect(after.ready).toBe(false);
    expect(after.findingCodes).toContain('verification-evidence-stale');
    expect(after.findingCodes).toContain('verification-implementation-stale');
    expect(after.preflightHash).not.toBe(before.preflightHash);
  });

  it('binds an existing archive target and pending journal into readiness', async () => {
    await fs.mkdir(path.join(paths.archiveDir, '2026-07-17-archive-preview'), {
      recursive: true,
    });
    await fs.writeFile(loopTransitionJournalFile(paths, state.name), '{}\n');

    const preview = await inspectLoopArchivePreflight({
      paths,
      name: state.name,
      now: new Date('2026-07-17T03:00:00.000Z'),
    });

    expect(preview.ready).toBe(false);
    expect(preview.findingCodes).toEqual(
      expect.arrayContaining(['archive-target-exists', 'pending-journal']),
    );
  });

  it('blocks when another visible change claims the same implementation artifact', async () => {
    const competing = await createLoopChange({
      paths,
      verificationProtocol: 'legacy-v1',
      name: 'competing-change',
      language: 'en',
    });
    const sourceEvidence = path.join(loopChangeRuntimeDir(paths, state.name), 'evidence');
    const targetEvidence = path.join(loopChangeRuntimeDir(paths, competing.name), 'evidence');
    await fs.cp(sourceEvidence, targetEvidence, { recursive: true });
    await writeLoopChange(paths, {
      ...competing,
      phase: 'build',
      approval: 'implicit',
      implementation_scope: state.implementation_scope,
    });

    const preview = await inspectLoopArchivePreflight({
      paths,
      name: state.name,
      now: new Date('2026-07-17T03:00:00.000Z'),
    });

    expect(preview.ready).toBe(false);
    expect(preview.findingCodes).toContain('loop-change-conflict');
  });

  it('includes the current workspace finishing contract when present', async () => {
    await writeLoopWorkspaceIdentity({
      paths,
      name: state.name,
      revision: state.revision,
      binding: { isolation: 'current', changeBranch: null, targetBranch: null },
    });

    const preview = await inspectLoopArchivePreflight({
      paths,
      name: state.name,
      now: new Date('2026-07-17T03:00:00.000Z'),
    });

    expect(preview.workspace).toMatchObject({
      schema: 'owner.loop.workspace.v3',
      isolation: 'current',
      finish: null,
    });
  });
});
