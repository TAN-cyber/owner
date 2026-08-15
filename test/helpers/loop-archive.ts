import { promises as fs } from 'node:fs';
import path from 'node:path';

import { serializeLoopVerificationMachineBlock } from '../../domains/owner-loop/loop-acceptance.js';
import { inspectLoopArchivePreflight } from '../../domains/owner-loop/loop-archive-inspection.js';
import { prepareLoopBuildEvidence } from '../../domains/owner-loop/loop-build-evidence.js';
import {
  compareAndSwapLoopChangeFile,
  createLoopChange,
  loopChangeDir,
} from '../../domains/owner-loop/loop-change.js';
import { collectLoopContractFiles } from '../../domains/owner-loop/loop-contract-files.js';
import {
  LOOP_RUNTIME_HASH,
  LOOP_RUNTIME_PACKAGE,
} from '../../domains/owner-loop/loop-runtime-package.js';
import { loopChangeRuntimeDir } from '../../domains/owner-loop/loop-paths.js';
import { startLoopRun, writeLoopRunState } from '../../domains/owner-loop/loop-run-store.js';
import type {
  LoopChangeState,
  LoopProjectPaths,
  LoopSpecChange,
} from '../../domains/owner-loop/loop-types.js';
import { prepareLoopVerificationEvidence } from '../../domains/owner-loop/loop-verification-runtime.js';
import { issueLoopManualEvidenceReceipt } from '../../domains/owner-loop/loop-verification-receipt-runtime.js';
import { loopVerificationFixtureReceipt } from './loop-verification.js';

const brief = `# Outcome
Ship the capability.
# Scope
One focused behavior.
# Non-goals
No Pipeline migration.
# Acceptance examples
- The capability works.
# Constraints and invariants
Keep Loop self-contained.
# Decisions
Use canonical specs.
# Open questions
None.
# Verification expectations
Run focused tests.
`;

/** Build a real, content-bound Archive fixture without production test bypasses. */
export async function prepareLoopArchiveFixture(options: {
  paths: LoopProjectPaths;
  name: string;
  specChanges?: LoopSpecChange[];
  proposedSpecs?: Readonly<Record<string, string>>;
}): Promise<{ state: LoopChangeState; changeDir: string }> {
  const proofFile = path.join(options.paths.projectRoot, 'loop-archive-proof.txt');
  try {
    await fs.access(proofFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await fs.writeFile(proofFile, 'Loop Archive fixture evidence.\n');
  }
  const created = await createLoopChange({
    paths: options.paths,
    verificationProtocol: 'legacy-v1',
    name: options.name,
    language: 'en',
  });
  const changeDir = loopChangeDir(options.paths, options.name);
  await fs.writeFile(path.join(changeDir, 'brief.md'), brief);
  for (const [reference, content] of Object.entries(options.proposedSpecs ?? {})) {
    const target = path.join(changeDir, ...reference.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  const buildState: LoopChangeState = {
    ...created,
    phase: 'build',
    approval: 'implicit',
    spec_changes: options.specChanges ?? [],
    run_id: `run-${options.name}`,
  };
  const build = await prepareLoopBuildEvidence({
    paths: options.paths,
    state: buildState,
    artifactRefs: [],
    noCodeReason: 'The archive fixture changes only Loop specifications.',
  });
  const stateFile = path.join(changeDir, 'owner-state.yaml');
  const verifyState = await compareAndSwapLoopChangeFile(
    stateFile,
    {
      ...buildState,
      phase: 'verify',
      implementation_scope: build.scopeRef as LoopChangeState['implementation_scope'],
    },
    created.revision,
  );
  const contract = await collectLoopContractFiles({
    changeDir,
    briefRef: verifyState.brief,
    specChanges: verifyState.spec_changes,
  });
  const acceptanceReceipt = await issueLoopManualEvidenceReceipt({
    paths: options.paths,
    name: options.name,
    acceptanceIds: contract.contract.acceptance.map((criterion) => criterion.id),
    steps: ['Inspect the archived capability against every acceptance criterion.'],
    observations: ['The focused Loop Archive fixture evidence passed.'],
    confirmed: true,
  });
  const machineBlock = serializeLoopVerificationMachineBlock(
    contract.contract.acceptance.map((criterion) => ({
      acceptance_id: criterion.id,
      status: 'passed' as const,
      evidence_refs: [acceptanceReceipt.ref],
    })),
  );
  await fs.writeFile(
    path.join(changeDir, 'verification.md'),
    `# Acceptance evidence
${machineBlock}
# Commands and results
Focused tests passed.
# Skipped checks
None.
# Spec consistency
Consistent.
# Known limitations and risks
None.
# Conclusion
Pass.
`,
  );
  const evidence = await prepareLoopVerificationEvidence({
    paths: options.paths,
    state: verifyState,
    result: 'pass',
    reportRef: 'verification.md',
    receiptRef: await loopVerificationFixtureReceipt({
      paths: options.paths,
      name: options.name,
    }),
  });
  if (!evidence.ready || !evidence.evidenceRef) {
    throw new Error(`Loop Archive fixture evidence is not ready: ${evidence.findingCodes}`);
  }
  const archiveState = await compareAndSwapLoopChangeFile(
    stateFile,
    {
      ...verifyState,
      phase: 'archive',
      verification_result: 'pass',
      verification_report: 'verification.md',
      verification_evidence: evidence.evidenceRef as LoopChangeState['verification_evidence'],
    },
    verifyState.revision,
  );
  const run = startLoopRun(LOOP_RUNTIME_PACKAGE, archiveState.run_id!, LOOP_RUNTIME_HASH);
  run.currentStep = 'archive';
  run.iteration = 3;
  await writeLoopRunState(loopChangeRuntimeDir(options.paths, options.name), run);
  return { state: archiveState, changeDir };
}

export async function readyLoopArchivePreflight(options: {
  paths: LoopProjectPaths;
  name: string;
  now: Date;
}): Promise<string> {
  const preflight = await inspectLoopArchivePreflight(options);
  if (!preflight.ready) {
    throw new Error(`Loop Archive fixture preflight is blocked: ${preflight.findingCodes}`);
  }
  return preflight.preflightHash;
}
