import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  parseLoopVerificationMachineBlock,
  serializeLoopVerificationMachineBlock,
} from '../../../domains/owner-loop/loop-acceptance.js';
import { prepareLoopBuildEvidence } from '../../../domains/owner-loop/loop-build-evidence.js';
import { createLoopChange, loopChangeDir } from '../../../domains/owner-loop/loop-change.js';
import { collectLoopContractFiles } from '../../../domains/owner-loop/loop-contract-files.js';
import { buildLoopCheckReceipt } from '../../../domains/owner-loop/loop-check-receipt-model.js';
import {
  readLoopCheckReceipt,
  writeLoopCheckReceipt,
} from '../../../domains/owner-loop/loop-check-receipt-storage.js';
import {
  readLoopImplementationScopeBundle,
  readLoopVerificationEvidence,
  readLoopVerificationReceipt,
  writeLoopVerificationReceipt,
} from '../../../domains/owner-loop/loop-evidence-storage.js';
import {
  loopChangeRuntimeDir,
  loopProjectPaths,
  loopRuntimeRefFile,
} from '../../../domains/owner-loop/loop-paths.js';
import type { LoopChangeState, LoopProjectPaths } from '../../../domains/owner-loop/loop-types.js';
import {
  inspectLoopVerificationFreshness,
  prepareLoopVerificationEvidence,
} from '../../../domains/owner-loop/loop-verification-runtime.js';
import { persistLoopStaticInspectionReceipt } from '../../../domains/owner-loop/loop-verification-receipt-runtime.js';
import {
  buildLoopVerificationReceipt,
  loopArtifactBindingHash,
} from '../../../domains/owner-loop/loop-verification-receipt.js';

const brief = `# Outcome
Ship the focused behavior.
# Scope
Update one implementation file.
# Non-goals
No unrelated changes.
# Acceptance examples
- The focused behavior works.
- The focused result remains observable.
# Constraints and invariants
Keep callers stable.
# Decisions
Use the current module.
# Open questions
None.
# Verification expectations
Run the focused check.
`;

describe('Loop verification evidence runtime', () => {
  let projectRoot: string;
  let paths: LoopProjectPaths;
  let changeDir: string;
  let runtimeDir: string;
  let verifyState: LoopChangeState;
  let report: string;
  let acceptanceReceiptRef: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-verification-runtime-'));
    await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await fs.mkdir(path.join(projectRoot, 'domains', 'owner-loop'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'src', 'feature.ts'), 'export const value = 1;\n');
    await fs.writeFile(
      path.join(projectRoot, 'domains', 'owner-loop', 'policy.ts'),
      'export const policy = 1;\n',
    );
    paths = await loopProjectPaths(projectRoot, '.');
    const created = await createLoopChange({
      paths,
      name: 'verified-change',
      language: 'en',
      now: new Date('2026-07-17T00:00:00.000Z'),
    });
    changeDir = loopChangeDir(paths, created.name);
    runtimeDir = loopChangeRuntimeDir(paths, created.name);
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
    verifyState = {
      ...buildState,
      phase: 'verify',
      revision: buildState.revision + 1,
      implementation_scope: build.scopeRef as LoopChangeState['implementation_scope'],
      partial_allowance: null,
    };
    const contract = await collectLoopContractFiles({
      changeDir,
      briefRef: verifyState.brief,
      specChanges: verifyState.spec_changes,
    });
    acceptanceReceiptRef = await writeAcceptanceReceipt(
      verifyState,
      contract.contract.acceptance.map((criterion) => criterion.id),
    );
    const machineBlock = serializeLoopVerificationMachineBlock(
      contract.contract.acceptance.map((criterion) => ({
        acceptance_id: criterion.id,
        status: 'passed' as const,
        evidence_refs: [acceptanceReceiptRef],
      })),
    );
    report = `# Acceptance evidence
${machineBlock}
# Commands and results
Focused check passed.
# Skipped checks
None.
# Spec consistency
Consistent.
# Known limitations and risks
None.
# Conclusion
Pass.
`;
    await fs.writeFile(path.join(changeDir, 'verification.md'), report);
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  async function currentBindings(state: LoopChangeState) {
    const [scope, contract] = await Promise.all([
      readLoopImplementationScopeBundle(paths, state.name, state.implementation_scope!),
      collectLoopContractFiles({
        changeDir,
        briefRef: state.brief,
        specChanges: state.spec_changes,
      }),
    ]);
    return {
      scope,
      contract,
      bindings: {
        change: state.name,
        sourceRevision: state.revision,
        contractHash: contract.contract.contractHash,
        scopeHash: scope.scope.scopeHash,
        snapshotHash: scope.scope.currentProjectionHash,
        artifactHash: loopArtifactBindingHash(scope.scope.declaredArtifacts),
      },
    };
  }

  async function writeAcceptanceReceipt(
    state: LoopChangeState,
    acceptanceIds: readonly string[],
  ): Promise<string> {
    const { bindings } = await currentBindings(state);
    return writeLoopVerificationReceipt({
      paths,
      name: state.name,
      receipt: buildLoopVerificationReceipt({
        kind: 'manual-evidence',
        role: 'acceptance-evidence',
        status: 'passed',
        bindings,
        acceptanceIds: [...acceptanceIds],
        actor: 'runtime-test',
        issuedAt: '2026-07-17T01:20:00.000Z',
        evidence: {
          steps: ['Execute the focused acceptance check.'],
          observations: ['The focused behavior matched the contract.'],
        },
      }),
    });
  }

  async function writeFailedAcceptanceReceipt(
    state: LoopChangeState,
    acceptanceIds: readonly string[],
  ): Promise<string> {
    const { bindings } = await currentBindings(state);
    return writeLoopVerificationReceipt({
      paths,
      name: state.name,
      receipt: buildLoopVerificationReceipt({
        kind: 'automated-check',
        role: 'acceptance-evidence',
        status: 'failed',
        bindings,
        acceptanceIds: [...acceptanceIds],
        actor: 'loop-runtime:command:node',
        issuedAt: '2026-07-17T01:20:00.000Z',
        evidence: {
          executable: 'node',
          args: ['--test', 'focused.test.ts'],
          cwd: '.',
          exitCode: 1,
          signal: null,
          timedOut: false,
          timeoutMs: 120_000,
          startedAt: '2026-07-17T01:19:59.000Z',
          endedAt: '2026-07-17T01:20:00.000Z',
          worktree: {
            provider: 'none',
            root: '.',
            beforeCommit: null,
            afterCommit: null,
          },
          afterFence: {
            snapshotHash: bindings.snapshotHash,
            scopeHash: bindings.scopeHash,
            matched: true,
          },
          outputHash: '9'.repeat(64),
          outputSummary: 'The focused test failed.',
          outputTruncated: false,
        },
      }),
    });
  }

  async function writeCheckReceipt(options?: {
    stale?: boolean;
    status?: 'passed' | 'failed';
  }): Promise<string> {
    const scope = await readLoopImplementationScopeBundle(
      paths,
      verifyState.name,
      verifyState.implementation_scope!,
    );
    const contract = await collectLoopContractFiles({
      changeDir,
      briefRef: verifyState.brief,
      specChanges: verifyState.spec_changes,
    });
    const stale = options?.stale ?? false;
    const status = options?.status ?? 'passed';
    const snapshotHash = scope.scope.currentProjectionHash;
    const failed = status === 'failed';
    const selected = scope.scope.changes.filter((change) => change.after !== null);
    const receipt = buildLoopCheckReceipt({
      change: verifyState.name,
      sourceRevision: verifyState.revision,
      status,
      startedAt: '2026-07-17T01:30:00.000Z',
      endedAt: '2026-07-17T01:30:01.000Z',
      contract: {
        expectedHash: contract.contract.contractHash,
        beforeHash: contract.contract.contractHash,
        afterHash: contract.contract.contractHash,
      },
      implementation: {
        scopeHash: scope.scope.scopeHash,
        expectedSnapshotHash: snapshotHash,
        beforeSnapshotHash: stale ? '3'.repeat(64) : snapshotHash,
        afterSnapshotHash: snapshotHash,
      },
      counts: {
        filesSelected: selected.length,
        filesScanned: selected.length,
        binaryFilesSkipped: 0,
        bytesScanned: selected.reduce((total, change) => total + change.after!.size, 0),
        issueCount: failed ? 1 : 0,
        recordedIssueCount: failed ? 1 : 0,
      },
      issues: failed ? [{ path: selected[0]!.path, line: 1, kind: 'trailing-whitespace' }] : [],
      issuesTruncated: false,
      stale,
      staleReasons: stale ? ['implementation-before-does-not-match-scope'] : [],
    });
    const checkReceiptRef = await writeLoopCheckReceipt({
      paths,
      name: verifyState.name,
      receipt,
    });
    return (
      await persistLoopStaticInspectionReceipt({
        paths,
        state: verifyState,
        checkReceipt: receipt,
        checkReceiptRef,
      })
    ).ref;
  }

  async function checkDependencyRef(receiptRef: string): Promise<string> {
    const receipt = await readLoopVerificationReceipt(paths, verifyState.name, receiptRef);
    if (receipt.kind !== 'static-inspection') throw new Error('Expected static receipt');
    return receipt.evidence.checkReceiptRef;
  }

  async function archiveState(receiptRef?: string): Promise<{
    state: LoopChangeState;
    evidenceRef: string;
  }> {
    const effectiveReceiptRef = receiptRef ?? (await writeCheckReceipt());
    const prepared = await prepareLoopVerificationEvidence({
      paths,
      state: verifyState,
      result: 'pass',
      reportRef: 'verification.md',
      receiptRef: effectiveReceiptRef,
      now: new Date('2026-07-17T02:00:00.000Z'),
    });
    expect(prepared.ready).toBe(true);
    const state: LoopChangeState = {
      ...verifyState,
      phase: 'archive',
      revision: verifyState.revision + 1,
      verification_result: 'pass',
      verification_report: 'verification.md',
      verification_evidence: prepared.evidenceRef as LoopChangeState['verification_evidence'],
    };
    return { state, evidenceRef: prepared.evidenceRef! };
  }

  it('creates a content-bound envelope and reports complete freshness', async () => {
    const { state } = await archiveState();

    const inspection = await inspectLoopVerificationFreshness({ paths, state });

    expect(inspection).toMatchObject({
      freshness: 'complete',
      findingCodes: [],
      evidence: {
        result: 'pass',
        freshness: 'complete',
        skippedAcceptanceCount: 0,
      },
    });
    expect(inspection.evidence.envelopeHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('preserves an immutable report snapshot after the live report is rewritten', async () => {
    const { evidenceRef } = await archiveState();
    const envelope = await readLoopVerificationEvidence(paths, verifyState.name, evidenceRef);
    const snapshot = path.join(runtimeDir, 'evidence', 'reports', `${envelope.reportHash}.json`);

    expect(JSON.parse(await fs.readFile(snapshot, 'utf8'))).toMatchObject({ content: report });
    await fs.writeFile(path.join(changeDir, 'verification.md'), `${report}\nReverified later.\n`);
    expect(JSON.parse(await fs.readFile(snapshot, 'utf8'))).toMatchObject({ content: report });
  });

  it('binds a fresh Loop check receipt and revalidates its policy during freshness inspection', async () => {
    const receiptRef = await writeCheckReceipt();
    const { state } = await archiveState(receiptRef);

    const fresh = await inspectLoopVerificationFreshness({ paths, state });
    expect(fresh).toMatchObject({
      freshness: 'complete',
      findingCodes: [],
      envelope: { requiredReceiptRefs: [receiptRef] },
    });

    const receiptFile = loopRuntimeRefFile(runtimeDir, await checkDependencyRef(receiptRef));
    const persisted = JSON.parse(await fs.readFile(receiptFile, 'utf8')) as {
      checker: { version: number };
    };
    persisted.checker.version = 0;
    await fs.writeFile(receiptFile, JSON.stringify(persisted));
    const invalidPolicy = await inspectLoopVerificationFreshness({ paths, state });
    expect(invalidPolicy).toMatchObject({
      freshness: 'stale',
      findingCodes: ['verification-receipt-invalid'],
    });
  });

  it('rejects an unsupported check policy before binding Verify evidence', async () => {
    const receiptRef = await writeCheckReceipt();
    const receiptFile = loopRuntimeRefFile(runtimeDir, await checkDependencyRef(receiptRef));
    const persisted = JSON.parse(await fs.readFile(receiptFile, 'utf8')) as {
      checker: { version: number };
    };
    persisted.checker.version = 0;
    await fs.writeFile(receiptFile, JSON.stringify(persisted));

    await expect(
      prepareLoopVerificationEvidence({
        paths,
        state: verifyState,
        result: 'pass',
        reportRef: 'verification.md',
        receiptRef,
      }),
    ).rejects.toThrow('checker policy is unsupported');
  });

  it('refuses to bind a stale Loop check receipt', async () => {
    const receiptRef = await writeCheckReceipt({ stale: true, status: 'failed' });

    await expect(
      prepareLoopVerificationEvidence({
        paths,
        state: verifyState,
        result: 'pass',
        reportRef: 'verification.md',
        receiptRef,
      }),
    ).rejects.toThrow('receipt is blocked');
  });

  it('rejects a failed receipt for pass while allowing it to explain a failed outcome', async () => {
    const failedRef = await writeCheckReceipt({ status: 'failed' });
    await expect(
      prepareLoopVerificationEvidence({
        paths,
        state: verifyState,
        result: 'pass',
        reportRef: 'verification.md',
        receiptRef: failedRef,
      }),
    ).rejects.toThrow('receipt is failed');
    await expect(
      prepareLoopVerificationEvidence({
        paths,
        state: verifyState,
        result: 'fail',
        reportRef: 'verification.md',
        receiptRef: failedRef,
      }),
    ).resolves.toMatchObject({ ready: true });
  });

  it('accepts an incomplete matrix only for fail and records omitted criteria as missing', async () => {
    const contract = await collectLoopContractFiles({
      changeDir,
      briefRef: verifyState.brief,
      specChanges: verifyState.spec_changes,
    });
    const machineBlock = serializeLoopVerificationMachineBlock([
      {
        acceptance_id: contract.contract.acceptance[0].id,
        status: 'passed',
        evidence_refs: [acceptanceReceiptRef],
      },
    ]);
    await fs.writeFile(
      path.join(changeDir, 'verification.md'),
      `# Acceptance evidence
${machineBlock}
# Conclusion
Fail.
`,
    );
    const failedRef = await writeCheckReceipt({ status: 'failed' });

    await expect(
      prepareLoopVerificationEvidence({
        paths,
        state: verifyState,
        result: 'pass',
        reportRef: 'verification.md',
        receiptRef: failedRef,
      }),
    ).rejects.toThrow('missing 1 acceptance evidence entry');
    const failed = await prepareLoopVerificationEvidence({
      paths,
      state: verifyState,
      result: 'fail',
      reportRef: 'verification.md',
      receiptRef: failedRef,
    });
    expect(failed.envelope?.acceptanceTrace.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          acceptanceId: contract.contract.acceptance[1].id,
          status: 'missing',
        }),
      ]),
    );
  });

  it('validates and retains failed automated receipts for a failed acceptance', async () => {
    const contract = await collectLoopContractFiles({
      changeDir,
      briefRef: verifyState.brief,
      specChanges: verifyState.spec_changes,
    });
    const failedReceiptRef = await writeFailedAcceptanceReceipt(verifyState, [
      contract.contract.acceptance[0].id,
    ]);
    const machineBlock = serializeLoopVerificationMachineBlock([
      {
        acceptance_id: contract.contract.acceptance[0].id,
        status: 'failed',
        evidence_refs: [failedReceiptRef],
        skipped_reason: 'The focused automated check failed.',
      },
      {
        acceptance_id: contract.contract.acceptance[1].id,
        status: 'passed',
        evidence_refs: [acceptanceReceiptRef],
      },
    ]);
    await fs.writeFile(
      path.join(changeDir, 'verification.md'),
      `# Acceptance evidence
${machineBlock}
# Conclusion
Fail.
`,
    );

    const failed = await prepareLoopVerificationEvidence({
      paths,
      state: verifyState,
      result: 'fail',
      reportRef: 'verification.md',
    });

    expect(failed.envelope).toMatchObject({
      result: 'fail',
      receiptRefs: expect.arrayContaining([failedReceiptRef, acceptanceReceiptRef]),
    });
  });

  it('refuses a passing result without a current Runtime receipt', async () => {
    await expect(
      prepareLoopVerificationEvidence({
        paths,
        state: verifyState,
        result: 'pass',
        reportRef: 'verification.md',
      }),
    ).rejects.toThrow('typed required-check receipt');
  });

  it('rejects bare project paths as acceptance evidence even when the built-in check passed', async () => {
    const contract = await collectLoopContractFiles({
      changeDir,
      briefRef: verifyState.brief,
      specChanges: verifyState.spec_changes,
    });
    const entries = contract.contract.acceptance.map((criterion) => ({
      acceptance_id: criterion.id,
      status: 'passed',
      evidence_refs: ['src/feature.ts'],
    }));
    await fs.writeFile(
      path.join(changeDir, 'verification.md'),
      `# Acceptance evidence
<!-- owner-loop:acceptance-evidence:start -->
${JSON.stringify(entries, null, 2)}
<!-- owner-loop:acceptance-evidence:end -->
`,
    );
    await expect(
      prepareLoopVerificationEvidence({
        paths,
        state: verifyState,
        result: 'pass',
        reportRef: 'verification.md',
        receiptRef: await writeCheckReceipt(),
      }),
    ).rejects.toThrow('content-addressed typed receipt');
  });

  it('refuses a passing result when any acceptance criterion is skipped', async () => {
    const contract = await collectLoopContractFiles({
      changeDir,
      briefRef: verifyState.brief,
      specChanges: verifyState.spec_changes,
    });
    const skippedBlock = serializeLoopVerificationMachineBlock(
      contract.contract.acceptance.map((criterion) => ({
        acceptance_id: criterion.id,
        status: 'failed' as const,
        evidence_refs: [],
        skipped_reason: 'The required check was not run.',
      })),
    );
    await fs.writeFile(changeDir + '/verification.md', `# Acceptance evidence\n${skippedBlock}\n`);

    await expect(
      prepareLoopVerificationEvidence({
        paths,
        state: verifyState,
        result: 'pass',
        reportRef: 'verification.md',
        receiptRef: await writeCheckReceipt(),
      }),
    ).rejects.toThrow('failed or missing acceptance criteria');
  });

  it('refuses to create evidence when implementation changed after Build capture', async () => {
    await fs.writeFile(path.join(projectRoot, 'src', 'feature.ts'), 'export const value = 3;\n');

    const prepared = await prepareLoopVerificationEvidence({
      paths,
      state: verifyState,
      result: 'pass',
      reportRef: 'verification.md',
    });

    expect(prepared).toEqual({
      ready: false,
      findingCodes: ['verification-implementation-stale'],
      envelope: null,
      evidenceRef: null,
      reportSnapshot: null,
    });
  });

  it.each([
    ['implementation', 'verification-implementation-stale'],
    ['contract', 'verification-contract-stale'],
    ['report', 'verification-report-stale'],
  ] as const)('marks a changed %s boundary stale', async (boundary, expectedCode) => {
    const { state } = await archiveState();
    if (boundary === 'implementation') {
      await fs.writeFile(path.join(projectRoot, 'src', 'feature.ts'), 'export const value = 4;\n');
    } else if (boundary === 'contract') {
      await fs.writeFile(path.join(changeDir, 'brief.md'), brief.replace('works.', 'is correct.'));
    } else {
      await fs.writeFile(path.join(changeDir, 'verification.md'), report.replace('Pass.', 'Pass!'));
    }

    const inspection = await inspectLoopVerificationFreshness({ paths, state });

    expect(inspection.freshness).toBe('stale');
    expect(inspection.findingCodes).toContain(expectedCode);
  });

  it('fails closed when the evidence document is tampered with', async () => {
    const { state, evidenceRef } = await archiveState();
    const evidenceFile = loopRuntimeRefFile(runtimeDir, evidenceRef);
    const value = JSON.parse(await fs.readFile(evidenceFile, 'utf8')) as Record<string, unknown>;
    value.result = 'fail';
    await fs.writeFile(evidenceFile, JSON.stringify(value));

    const inspection = await inspectLoopVerificationFreshness({ paths, state });

    expect(inspection).toMatchObject({
      freshness: 'invalid',
      findingCodes: ['verification-evidence-invalid'],
      envelope: null,
    });
  });

  it('detects a state/envelope ref mismatch without trusting state booleans', async () => {
    const { state } = await archiveState();
    const mismatched = { ...state, verification_result: 'fail' as const };

    const inspection = await inspectLoopVerificationFreshness({ paths, state: mismatched });

    expect(inspection).toMatchObject({
      freshness: 'stale',
      findingCodes: ['verification-state-mismatch'],
    });
  });
});
