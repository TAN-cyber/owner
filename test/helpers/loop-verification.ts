import { serializeLoopVerificationMachineBlock } from '../../domains/owner-loop/loop-acceptance.js';
import { loopChangeDir, readLoopChange } from '../../domains/owner-loop/loop-change.js';
import { buildLoopCheckReceipt } from '../../domains/owner-loop/loop-check-receipt-model.js';
import {
  readLoopCheckReceipt,
  writeLoopCheckReceipt,
} from '../../domains/owner-loop/loop-check-receipt-storage.js';
import { collectLoopContractFiles } from '../../domains/owner-loop/loop-contract-files.js';
import type { LoopProjectPaths } from '../../domains/owner-loop/loop-types.js';
import { readLoopImplementationScopeBundle } from '../../domains/owner-loop/loop-evidence-storage.js';
import {
  issueLoopAutomatedCheckReceipt,
  issueLoopManualEvidenceReceipt,
  persistLoopStaticInspectionReceipt,
} from '../../domains/owner-loop/loop-verification-receipt-runtime.js';

const TYPED_RECEIPT_REF_PATTERN = /^runtime\/evidence\/receipts\/[a-f0-9]{64}\.json$/u;

/** Build a structurally valid report for lifecycle tests that are not testing evidence content. */
export async function loopVerificationFixtureReport(options: {
  paths: LoopProjectPaths;
  name: string;
  evidenceRefs?: readonly string[];
  conclusion?: 'Pass' | 'Fail';
}): Promise<string> {
  const state = await readLoopChange(options.paths, options.name);
  const collected = await collectLoopContractFiles({
    changeDir: loopChangeDir(options.paths, options.name),
    briefRef: state.brief,
    specChanges: state.spec_changes,
  });
  const conclusion = options.conclusion ?? 'Pass';
  let evidenceRefs = [...(options.evidenceRefs ?? [])].filter((ref) =>
    TYPED_RECEIPT_REF_PATTERN.test(ref),
  );
  if (conclusion === 'Pass' && evidenceRefs.length === 0) {
    const issued = await issueLoopManualEvidenceReceipt({
      paths: options.paths,
      name: options.name,
      acceptanceIds: collected.contract.acceptance.map((criterion) => criterion.id),
      steps: ['Exercise every acceptance criterion in the lifecycle fixture.'],
      observations: ['Every acceptance criterion produced the expected fixture outcome.'],
      now: new Date('2026-07-28T00:00:00.000Z'),
    });
    evidenceRefs = [issued.ref];
  }
  const machineBlock = serializeLoopVerificationMachineBlock(
    collected.contract.acceptance.map((criterion) => ({
      acceptance_id: criterion.id,
      ...(conclusion === 'Pass'
        ? { status: 'passed' as const, evidence_refs: evidenceRefs }
        : {
            status: 'failed' as const,
            evidence_refs: evidenceRefs,
            ...(evidenceRefs.length === 0
              ? {
                  skipped_reason:
                    'Lifecycle fixture records the requested failed verification outcome.',
                }
              : {}),
          }),
    })),
  );
  return `# Acceptance evidence
${machineBlock}
# Commands and results
Lifecycle fixture completed.
# Skipped checks
${evidenceRefs.length > 0 ? 'None.' : 'Acceptance checks are intentionally skipped by this lifecycle fixture.'}
# Spec consistency
Matches.
# Known limitations and risks
This report is test fixture evidence only.
# Conclusion
${conclusion}.
`;
}

/** Create a current, failed automated receipt for repair-loop lifecycle tests. */
export async function loopVerificationFixtureFailedReceipt(options: {
  paths: LoopProjectPaths;
  name: string;
  checkIdentity?: string;
}): Promise<{
  receipt: Awaited<ReturnType<typeof issueLoopAutomatedCheckReceipt>>['receipt'];
  ref: string;
}> {
  const state = await readLoopChange(options.paths, options.name);
  const collected = await collectLoopContractFiles({
    changeDir: loopChangeDir(options.paths, options.name),
    briefRef: state.brief,
    specChanges: state.spec_changes,
  });
  return issueLoopAutomatedCheckReceipt({
    paths: options.paths,
    name: options.name,
    acceptanceIds: collected.contract.acceptance.map((criterion) => criterion.id),
    command: process.execPath,
    args: [
      '-e',
      `process.stdout.write(${JSON.stringify(options.checkIdentity ?? 'focused-check')}); process.exit(1);`,
    ],
  });
}

/** Create a current, passed Runtime receipt for lifecycle tests that do not test check policy. */
export async function loopVerificationFixtureReceipt(options: {
  paths: LoopProjectPaths;
  name: string;
  now?: Date;
}): Promise<string> {
  const state = await readLoopChange(options.paths, options.name);
  if (!state.implementation_scope)
    throw new Error('Fixture receipt requires an implementation scope');
  const [scope, collected] = await Promise.all([
    readLoopImplementationScopeBundle(options.paths, options.name, state.implementation_scope),
    collectLoopContractFiles({
      changeDir: loopChangeDir(options.paths, options.name),
      briefRef: state.brief,
      specChanges: state.spec_changes,
    }),
  ]);
  const selected = scope.scope.changes.filter((change) => change.after !== null);
  const startedAt = (options.now ?? new Date('2026-07-28T00:00:00.000Z')).toISOString();
  const endedAt = new Date(new Date(startedAt).getTime() + 1).toISOString();
  const checkRef = await writeLoopCheckReceipt({
    paths: options.paths,
    name: options.name,
    receipt: buildLoopCheckReceipt({
      change: options.name,
      sourceRevision: state.revision,
      status: 'passed',
      startedAt,
      endedAt,
      contract: {
        expectedHash: collected.contract.contractHash,
        beforeHash: collected.contract.contractHash,
        afterHash: collected.contract.contractHash,
      },
      implementation: {
        scopeHash: scope.scope.scopeHash,
        expectedSnapshotHash: scope.scope.currentProjectionHash,
        beforeSnapshotHash: scope.scope.currentProjectionHash,
        afterSnapshotHash: scope.scope.currentProjectionHash,
      },
      counts: {
        filesSelected: selected.length,
        filesScanned: selected.length,
        binaryFilesSkipped: 0,
        bytesScanned: selected.reduce((total, change) => total + change.after!.size, 0),
        issueCount: 0,
        recordedIssueCount: 0,
      },
      issues: [],
      issuesTruncated: false,
      stale: false,
      staleReasons: [],
    }),
  });
  return (
    await persistLoopStaticInspectionReceipt({
      paths: options.paths,
      state,
      checkReceipt: await readLoopCheckReceipt(options.paths, options.name, checkRef),
      checkReceiptRef: checkRef,
    })
  ).ref;
}
