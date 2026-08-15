import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildLoopCheckReceipt } from '../../../domains/owner-loop/loop-check-receipt-model.js';
import { writeLoopCheckReceipt } from '../../../domains/owner-loop/loop-check-receipt-storage.js';
import { createLoopChange, writeLoopChange } from '../../../domains/owner-loop/loop-change.js';
import { buildLoopContractSnapshot } from '../../../domains/owner-loop/loop-contract.js';
import {
  defaultProjectConfig,
  writeProjectConfig,
} from '../../../domains/owner-loop/loop-config.js';
import { doctorLoopProject } from '../../../domains/owner-loop/loop-doctor.js';
import {
  inspectLoopEvidenceRetention,
  LOOP_EVIDENCE_RETENTION_POLICY,
} from '../../../domains/owner-loop/loop-evidence-retention.js';
import {
  writeLoopVerificationReceipt,
  writeLoopImplementationScope,
  writeLoopPartialAllowance,
  writeLoopVerificationReportSnapshot,
  writeLoopVerificationEvidence,
} from '../../../domains/owner-loop/loop-evidence-storage.js';
import {
  loopChangeRuntimeDir,
  loopProjectPaths,
  loopRuntimeRefFile,
} from '../../../domains/owner-loop/loop-paths.js';
import { createLoopTransaction } from '../../../domains/owner-loop/loop-transaction.js';
import type {
  LoopChangeState,
  LoopContentSnapshotManifest,
  LoopProjectPaths,
} from '../../../domains/owner-loop/loop-types.js';
import { buildLoopImplementationScopeBundle } from '../../../domains/owner-loop/loop-verification-scope.js';
import {
  buildLoopVerificationReceipt,
  loopArtifactBindingHash,
} from '../../../domains/owner-loop/loop-verification-receipt.js';
import {
  buildLoopAcceptanceEvidenceTrace,
  buildLoopPartialAllowance,
  buildLoopVerificationEvidenceEnvelope,
} from '../../../domains/owner-loop/loop-verification-evidence.js';

const CHANGE = 'retention-change';
const NOW = new Date('2026-10-01T00:00:00.000Z');
const OLD = new Date(
  NOW.getTime() - LOOP_EVIDENCE_RETENTION_POLICY.minimumAgeMs - 10 * 24 * 60 * 60 * 1_000,
);
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const REPORT_TEXT = 'Verification passed.';
const REPORT_HASH = createHash('sha256').update(REPORT_TEXT).digest('hex');

function snapshot(entries: LoopContentSnapshotManifest['entries']): LoopContentSnapshotManifest {
  return {
    schema: 'owner.loop.content-snapshot.v1',
    origin: 'explicit',
    createdAt: '2026-07-01T00:00:00.000Z',
    complete: true,
    limits: {
      maxFiles: 128,
      maxFileBytes: 1024 * 1024,
      maxTotalBytes: 8 * 1024 * 1024,
      maxManifestBytes: 1024 * 1024,
    },
    entries,
    omitted: [],
    omittedCount: 0,
  };
}

function receipt(sourceRevision: number, scopeHash = HASH_B, snapshotHash = HASH_C) {
  const timestamp = new Date(
    Date.parse('2026-07-01T00:00:00.000Z') + sourceRevision * 1_000,
  ).toISOString();
  return buildLoopCheckReceipt({
    change: CHANGE,
    sourceRevision,
    status: 'passed',
    startedAt: timestamp,
    endedAt: timestamp,
    contract: { expectedHash: HASH_A, beforeHash: HASH_A, afterHash: HASH_A },
    implementation: {
      scopeHash,
      expectedSnapshotHash: snapshotHash,
      beforeSnapshotHash: snapshotHash,
      afterSnapshotHash: snapshotHash,
    },
    counts: {
      filesSelected: 0,
      filesScanned: 0,
      binaryFilesSkipped: 0,
      bytesScanned: 0,
      issueCount: 0,
      recordedIssueCount: 0,
    },
    issues: [],
    issuesTruncated: false,
    stale: false,
    staleReasons: [],
  });
}

function refFile(paths: LoopProjectPaths, ref: string): string {
  return loopRuntimeRefFile(loopChangeRuntimeDir(paths, CHANGE), ref);
}

async function setOldMtime(
  paths: LoopProjectPaths,
  ref: string,
  offsetHours: number,
): Promise<void> {
  const time = new Date(OLD.getTime() + offsetHours * 60 * 60 * 1_000);
  await fs.utimes(refFile(paths, ref), time, time);
}

describe('Loop evidence retention', () => {
  let projectRoot: string;
  let paths: LoopProjectPaths;
  let state: LoopChangeState;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-retention-'));
    paths = await loopProjectPaths(projectRoot, '.');
    state = await createLoopChange({
      paths,
      verificationProtocol: 'legacy-v1',
      name: CHANGE,
      language: 'en',
      now: new Date('2026-07-01T00:00:00.000Z'),
    });
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  async function writeOldReceipts(count: number): Promise<string[]> {
    const refs: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const ref = await writeLoopCheckReceipt({
        paths,
        name: CHANGE,
        receipt: receipt(index + 1),
      });
      await setOldMtime(paths, ref, index);
      refs.push(ref);
    }
    return refs;
  }

  it('keeps doctor read-only by default, prunes only old excess documents, and is idempotent', async () => {
    await writeOldReceipts(LOOP_EVIDENCE_RETENTION_POLICY.keepLatestUnreferencedPerKind + 11);
    const receiptDirectory = path.join(
      loopChangeRuntimeDir(paths, CHANGE),
      'evidence',
      'check-receipts',
    );

    const inspected = await doctorLoopProject({ paths, name: CHANGE, now: NOW });
    expect(inspected.findings).toContainEqual(
      expect.objectContaining({
        code: 'evidence-retention-candidates',
        severity: 'info',
        message: expect.stringMatching(/11 old unreferenced.*\.\.\. \(3 more\)/u),
      }),
    );
    expect(await fs.readdir(receiptDirectory)).toHaveLength(43);

    const repaired = await doctorLoopProject({ paths, name: CHANGE, now: NOW, repair: true });
    expect(repaired.findings).toContainEqual(
      expect.objectContaining({
        code: 'evidence-retention-cleaned',
        severity: 'info',
        message: expect.stringMatching(/11 old unreferenced.*\.\.\. \(3 more\)/u),
      }),
    );
    expect(await fs.readdir(receiptDirectory)).toHaveLength(32);

    const repeated = await doctorLoopProject({ paths, name: CHANGE, now: NOW, repair: true });
    expect(
      repeated.findings.some((finding) => finding.code.startsWith('evidence-retention-')),
    ).toBe(false);
    expect(await fs.readdir(receiptDirectory)).toHaveLength(32);
  });

  it('defers every cleanup while archive or root-move recovery can still relocate a change', async () => {
    await writeOldReceipts(LOOP_EVIDENCE_RETENTION_POLICY.keepLatestUnreferencedPerKind + 2);
    const receiptDirectory = path.join(
      loopChangeRuntimeDir(paths, CHANGE),
      'evidence',
      'check-receipts',
    );

    const rootMoveConfig = defaultProjectConfig('.');
    rootMoveConfig.loop.pending_root_move = {
      id: '11111111-2222-3333-4444-555555555555',
      fromArtifactRoot: '.',
      toArtifactRoot: 'docs',
      stage: 'copying',
    };
    await writeProjectConfig(projectRoot, rootMoveConfig);
    await expect(
      inspectLoopEvidenceRetention({ paths, name: CHANGE, repair: true, now: NOW }),
    ).resolves.toEqual([]);
    expect(await fs.readdir(receiptDirectory)).toHaveLength(34);

    await writeProjectConfig(projectRoot, defaultProjectConfig('.'));
    await createLoopTransaction(paths, {
      schema: 'owner.loop.transaction.v1',
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      kind: 'archive',
      status: 'prepared',
      projectRoot,
      loopRoot: paths.loopRoot,
      change: CHANGE,
      createdAt: '2026-07-01T00:00:00.000Z',
      operations: [],
    });
    await expect(
      inspectLoopEvidenceRetention({ paths, name: CHANGE, repair: true, now: NOW }),
    ).resolves.toEqual([]);
    expect(await fs.readdir(receiptDirectory)).toHaveLength(34);
  });

  it('reports and safely restores an interrupted cleanup quarantine before pruning', async () => {
    const [ref] = await writeOldReceipts(1);
    const original = refFile(paths, ref);
    const quarantine = path.join(
      path.dirname(original),
      `.${path.basename(original)}.11111111-2222-3333-4444-555555555555.gc`,
    );
    await fs.rename(original, quarantine);

    const inspected = await inspectLoopEvidenceRetention({ paths, name: CHANGE, now: NOW });
    expect(inspected).toContainEqual(
      expect.objectContaining({
        code: 'evidence-retention-recovery-required',
        severity: 'warning',
        path: expect.not.stringMatching(/^[A-Za-z]:|^\//u),
      }),
    );
    await expect(fs.access(original)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(quarantine)).resolves.toBeUndefined();

    const repaired = await inspectLoopEvidenceRetention({
      paths,
      name: CHANGE,
      repair: true,
      now: NOW,
    });
    expect(repaired).toContainEqual(
      expect.objectContaining({
        code: 'evidence-retention-cleanup-recovered',
        severity: 'info',
      }),
    );
    await expect(fs.access(original)).resolves.toBeUndefined();
    await expect(fs.access(quarantine)).rejects.toMatchObject({ code: 'ENOENT' });

    await expect(
      inspectLoopEvidenceRetention({ paths, name: CHANGE, repair: true, now: NOW }),
    ).resolves.toEqual([]);
  });

  it('finishes an interrupted recovery when original and quarantine have trusted content', async () => {
    const [ref] = await writeOldReceipts(1);
    const original = refFile(paths, ref);
    const quarantine = path.join(
      path.dirname(original),
      `.${path.basename(original)}.11111111-2222-3333-4444-555555555555.gc`,
    );
    await fs.copyFile(original, quarantine);

    const result = await inspectLoopEvidenceRetention({
      paths,
      name: CHANGE,
      repair: true,
      now: NOW,
    });
    expect(result).toContainEqual(
      expect.objectContaining({
        code: 'evidence-retention-cleanup-recovered',
        severity: 'info',
      }),
    );
    await expect(fs.access(original)).resolves.toBeUndefined();
    await expect(fs.access(quarantine)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('finishes recovery after a crash immediately after linking the original', async () => {
    const [ref] = await writeOldReceipts(1);
    const original = refFile(paths, ref);
    const quarantine = path.join(
      path.dirname(original),
      `.${path.basename(original)}.11111111-2222-3333-4444-555555555555.gc`,
    );
    await fs.rename(original, quarantine);
    let interrupted = false;
    const first = await inspectLoopEvidenceRetention({
      paths,
      name: CHANGE,
      repair: true,
      now: NOW,
      hooks: {
        afterRecoveryLink: () => {
          interrupted = true;
          throw new Error('simulated crash after recovery link');
        },
      },
    });
    expect(interrupted).toBe(true);
    expect(first).toContainEqual(
      expect.objectContaining({ code: 'evidence-retention-unsafe', severity: 'error' }),
    );
    await expect(fs.access(original)).resolves.toBeUndefined();
    await expect(fs.access(quarantine)).resolves.toBeUndefined();

    const recovered = await inspectLoopEvidenceRetention({
      paths,
      name: CHANGE,
      repair: true,
      now: NOW,
    });
    expect(recovered).toContainEqual(
      expect.objectContaining({
        code: 'evidence-retention-cleanup-recovered',
        severity: 'info',
      }),
    );
    await expect(fs.access(original)).resolves.toBeUndefined();
    await expect(fs.access(quarantine)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses original and quarantine when either document is not trusted content', async () => {
    const [ref] = await writeOldReceipts(1);
    const original = refFile(paths, ref);
    const quarantine = path.join(
      path.dirname(original),
      `.${path.basename(original)}.11111111-2222-3333-4444-555555555555.gc`,
    );
    await fs.copyFile(original, quarantine);
    await fs.writeFile(original, '{}\n');

    const result = await inspectLoopEvidenceRetention({
      paths,
      name: CHANGE,
      repair: true,
      now: NOW,
    });
    expect(result).toContainEqual(
      expect.objectContaining({ code: 'evidence-retention-unsafe', severity: 'error' }),
    );
    await expect(fs.access(original)).resolves.toBeUndefined();
    await expect(fs.access(quarantine)).resolves.toBeUndefined();
  });

  it('retains the complete verification, allowance, scope, snapshot, and receipt dependency closure', async () => {
    const contract = buildLoopContractSnapshot({
      briefMarkdown: '# Acceptance examples\n- Retention remains safe.\n',
      specs: [],
    });
    const graphs: Array<{
      scopeRef: string;
      allowanceRef: string;
      currentSnapshotRef: string;
      receiptRefs: string[];
      verificationRef: string;
      bundle: ReturnType<typeof buildLoopImplementationScopeBundle>;
      allowance: ReturnType<typeof buildLoopPartialAllowance>;
    }> = [];
    for (let index = 0; index < 34; index += 1) {
      const bundle = buildLoopImplementationScopeBundle({
        baseline: snapshot([]),
        current: snapshot([
          {
            path: `src/file-${index}.ts`,
            hash: index.toString(16).padStart(64, '0'),
            size: index + 1,
            type: 'file',
          },
        ]),
        contractHash: contract.contractHash,
        declaredArtifacts: [],
      });
      const scopeRef = await writeLoopImplementationScope({ paths, name: CHANGE, bundle });
      const allowance = buildLoopPartialAllowance({
        change: CHANGE,
        scopeBundle: bundle,
        allowedScopeIds: bundle.scope.unresolvedScopes.map((entry) => entry.id),
        reason: `Known retained scope ${index}`,
        confirmedSummary: `Confirmed retained scope ${index}`,
        sourceRevision: index + 1,
        now: new Date('2026-07-01T00:00:00.000Z'),
      });
      const allowanceRef = await writeLoopPartialAllowance({
        paths,
        name: CHANGE,
        allowance,
      });
      const builtReceipt = receipt(
        index + 1,
        bundle.scope.scopeHash,
        bundle.scope.currentProjectionHash,
      );
      const checkReceiptRef = await writeLoopCheckReceipt({
        paths,
        name: CHANGE,
        receipt: builtReceipt,
      });
      const bindings = {
        change: CHANGE,
        sourceRevision: 100 + index,
        contractHash: contract.contractHash,
        scopeHash: bundle.scope.scopeHash,
        snapshotHash: bundle.scope.currentProjectionHash,
        artifactHash: loopArtifactBindingHash(bundle.scope.declaredArtifacts),
      };
      const requiredReceiptRef = await writeLoopVerificationReceipt({
        paths,
        name: CHANGE,
        receipt: buildLoopVerificationReceipt({
          kind: 'static-inspection',
          role: 'required-check',
          status: 'passed',
          bindings,
          acceptanceIds: [],
          actor: `loop-runtime:${builtReceipt.checker.policy}`,
          issuedAt: new Date('2026-07-01T00:00:00.000Z').toISOString(),
          evidence: {
            subjects: [],
            rule: builtReceipt.checker.policy,
            resultSummary: 'The retained static inspection passed.',
            checkReceiptRef,
            checkReceiptHash: builtReceipt.receiptHash,
          },
        }),
      });
      const acceptanceReceiptRef = await writeLoopVerificationReceipt({
        paths,
        name: CHANGE,
        receipt: buildLoopVerificationReceipt({
          kind: 'manual-evidence',
          role: 'acceptance-evidence',
          status: 'passed',
          bindings,
          acceptanceIds: [contract.acceptance[0].id],
          actor: 'loop-retention-test',
          issuedAt: new Date('2026-07-01T00:00:00.000Z').toISOString(),
          evidence: {
            steps: ['Inspect retained acceptance evidence.'],
            observations: ['The evidence remains available.'],
          },
        }),
      });
      const trace = buildLoopAcceptanceEvidenceTrace(
        contract.acceptance,
        [
          {
            acceptance_id: contract.acceptance[0].id,
            status: 'passed',
            evidence_refs: [acceptanceReceiptRef],
          },
        ],
        { loopRootRef: 'owner' },
      );
      const verification = buildLoopVerificationEvidenceEnvelope({
        change: CHANGE,
        sourceRevision: 100 + index,
        result: 'pass',
        contractHash: contract.contractHash,
        acceptanceHash: contract.acceptanceHash,
        implementationScope: { ref: scopeRef, bundle },
        reportRef: 'verification.md',
        reportHash: REPORT_HASH,
        acceptanceTrace: trace,
        partialAllowance: { ref: allowanceRef, allowance },
        requiredReceiptRefs: [requiredReceiptRef],
        now: new Date('2026-07-01T00:00:00.000Z'),
      });
      await writeLoopVerificationReportSnapshot({
        paths,
        name: CHANGE,
        hash: REPORT_HASH,
        text: REPORT_TEXT,
      });
      const verificationRef = await writeLoopVerificationEvidence({
        paths,
        name: CHANGE,
        evidence: verification,
      });
      await setOldMtime(paths, scopeRef, index);
      await setOldMtime(paths, allowanceRef, index);
      await setOldMtime(paths, bundle.scope.currentProjectionRef, index);
      await setOldMtime(paths, checkReceiptRef, index);
      await setOldMtime(paths, requiredReceiptRef, index);
      await setOldMtime(paths, acceptanceReceiptRef, index);
      await setOldMtime(paths, verificationRef, index);
      graphs.push({
        scopeRef,
        allowanceRef,
        currentSnapshotRef: bundle.scope.currentProjectionRef,
        receiptRefs: [checkReceiptRef, requiredReceiptRef, acceptanceReceiptRef],
        verificationRef,
        bundle,
        allowance,
      });
    }
    const protectedGraph = graphs[0];
    const removableGraph = graphs[1];
    state = await writeLoopChange(paths, {
      ...state,
      phase: 'archive',
      approval: 'implicit',
      verification_result: 'pass',
      verification_report: 'verification.md',
      implementation_scope: protectedGraph.scopeRef as LoopChangeState['implementation_scope'],
      partial_allowance: protectedGraph.allowanceRef as LoopChangeState['partial_allowance'],
      verification_evidence:
        protectedGraph.verificationRef as LoopChangeState['verification_evidence'],
    });

    const interrupted = await inspectLoopEvidenceRetention({
      paths,
      name: CHANGE,
      repair: true,
      now: NOW,
      hooks: {
        beforeDelete: ({ ref }) => {
          if (ref === removableGraph.scopeRef) throw new Error('simulated cleanup interruption');
        },
      },
    });
    expect(interrupted).toContainEqual(
      expect.objectContaining({
        code: 'evidence-retention-cleanup-failed',
        severity: 'error',
      }),
    );
    await expect(fs.access(refFile(paths, removableGraph.verificationRef))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.access(refFile(paths, removableGraph.scopeRef))).resolves.toBeUndefined();

    const resumed = await inspectLoopEvidenceRetention({
      paths,
      name: CHANGE,
      repair: true,
      now: NOW,
    });
    expect(resumed).toContainEqual(
      expect.objectContaining({ code: 'evidence-retention-cleaned', severity: 'info' }),
    );
    expect(resumed.some((finding) => finding.code === 'evidence-retention-unsafe')).toBe(false);
    for (const ref of [
      protectedGraph.verificationRef,
      protectedGraph.allowanceRef,
      protectedGraph.scopeRef,
      protectedGraph.currentSnapshotRef,
      ...protectedGraph.receiptRefs,
    ]) {
      await expect(fs.access(refFile(paths, ref))).resolves.toBeUndefined();
    }
    for (const ref of [
      removableGraph.verificationRef,
      removableGraph.allowanceRef,
      removableGraph.scopeRef,
      removableGraph.currentSnapshotRef,
      ...removableGraph.receiptRefs,
    ]) {
      await expect(fs.access(refFile(paths, ref))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  }, 60_000);

  it('fails closed for unknown, damaged, and special evidence entries', async () => {
    await writeOldReceipts(LOOP_EVIDENCE_RETENTION_POLICY.keepLatestUnreferencedPerKind + 2);
    const receiptDirectory = path.join(
      loopChangeRuntimeDir(paths, CHANGE),
      'evidence',
      'check-receipts',
    );
    const unknown = path.join(receiptDirectory, 'unknown.txt');
    await fs.writeFile(unknown, '{}\n');
    let result = await inspectLoopEvidenceRetention({
      paths,
      name: CHANGE,
      repair: true,
      now: NOW,
    });
    expect(result).toContainEqual(
      expect.objectContaining({ code: 'evidence-retention-unsafe', severity: 'error' }),
    );
    expect(await fs.readdir(receiptDirectory)).toHaveLength(35);

    await fs.rm(unknown);
    const regularFiles = (await fs.readdir(receiptDirectory)).sort();
    await fs.writeFile(path.join(receiptDirectory, regularFiles[0]), '{}\n');
    result = await inspectLoopEvidenceRetention({
      paths,
      name: CHANGE,
      repair: true,
      now: NOW,
    });
    expect(result).toContainEqual(
      expect.objectContaining({ code: 'evidence-retention-unsafe', severity: 'error' }),
    );
    expect(await fs.readdir(receiptDirectory)).toHaveLength(34);

    await fs.rm(path.join(receiptDirectory, regularFiles[0]));
    const special = path.join(receiptDirectory, `${'f'.repeat(64)}.json`);
    await fs.mkdir(special);
    result = await inspectLoopEvidenceRetention({
      paths,
      name: CHANGE,
      repair: true,
      now: NOW,
    });
    expect(result).toContainEqual(
      expect.objectContaining({ code: 'evidence-retention-unsafe', severity: 'error' }),
    );
    expect((await fs.lstat(special)).isDirectory()).toBe(true);
  });

  it.runIf(process.platform !== 'win32')(
    'fails closed for a symbolic-link evidence entry',
    async () => {
      await writeOldReceipts(LOOP_EVIDENCE_RETENTION_POLICY.keepLatestUnreferencedPerKind + 2);
      const receiptDirectory = path.join(
        loopChangeRuntimeDir(paths, CHANGE),
        'evidence',
        'check-receipts',
      );
      const outside = path.join(projectRoot, 'outside.json');
      const link = path.join(receiptDirectory, `${'f'.repeat(64)}.json`);
      await fs.writeFile(outside, '{}\n');
      await fs.symlink(outside, link, 'file');

      const result = await inspectLoopEvidenceRetention({
        paths,
        name: CHANGE,
        repair: true,
        now: NOW,
      });
      expect(result).toContainEqual(
        expect.objectContaining({ code: 'evidence-retention-unsafe', severity: 'error' }),
      );
      expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(outside, 'utf8')).toBe('{}\n');
    },
  );

  it('does not delete a candidate replaced concurrently after planning', async () => {
    await writeOldReceipts(LOOP_EVIDENCE_RETENTION_POLICY.keepLatestUnreferencedPerKind + 2);
    let replacementFile: string | null = null;
    let displacedFile: string | null = null;
    const result = await inspectLoopEvidenceRetention({
      paths,
      name: CHANGE,
      repair: true,
      now: NOW,
      hooks: {
        beforeDelete: async ({ file }) => {
          if (replacementFile) return;
          replacementFile = file;
          displacedFile = `${file}.displaced`;
          await fs.rename(file, displacedFile);
          await fs.writeFile(file, JSON.stringify(receipt(999), null, 2) + '\n');
        },
      },
    });
    expect(result).toContainEqual(
      expect.objectContaining({
        code: 'evidence-retention-cleanup-failed',
        severity: 'error',
      }),
    );
    expect(replacementFile).not.toBeNull();
    expect(displacedFile).not.toBeNull();
    await expect(fs.access(replacementFile!)).resolves.toBeUndefined();
    await expect(fs.access(displacedFile!)).resolves.toBeUndefined();
  });

  it('does not delete a candidate rewritten in place after planning', async () => {
    await writeOldReceipts(LOOP_EVIDENCE_RETENTION_POLICY.keepLatestUnreferencedPerKind + 2);
    let rewrittenFile: string | null = null;
    const result = await inspectLoopEvidenceRetention({
      paths,
      name: CHANGE,
      repair: true,
      now: NOW,
      hooks: {
        beforeDelete: async ({ file }) => {
          if (rewrittenFile) return;
          rewrittenFile = file;
          await fs.appendFile(file, '\n');
        },
      },
    });
    expect(result).toContainEqual(
      expect.objectContaining({
        code: 'evidence-retention-cleanup-failed',
        severity: 'error',
      }),
    );
    expect(rewrittenFile).not.toBeNull();
    await expect(fs.access(rewrittenFile!)).resolves.toBeUndefined();
  });
});
