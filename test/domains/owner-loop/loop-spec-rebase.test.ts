import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { archiveLoopChange } from '../../../domains/owner-loop/loop-archive.js';
import { inspectLoopArchivePreflight } from '../../../domains/owner-loop/loop-archive-inspection.js';
import { createLoopChange, loopChangeDir } from '../../../domains/owner-loop/loop-change.js';
import { sha256File } from '../../../domains/owner-loop/loop-hash.js';
import { loopProjectPaths } from '../../../domains/owner-loop/loop-paths.js';
import {
  markLoopSpecRemoval,
  rebaseLoopSpecChanges,
} from '../../../domains/owner-loop/loop-specs.js';
import type { LoopProjectPaths } from '../../../domains/owner-loop/loop-types.js';
import { loopVerificationFixtureReport } from '../../helpers/loop-verification.js';
import { readyLoopArchivePreflight } from '../../helpers/loop-archive.js';
import { advanceLoopChange } from '../../helpers/loop-confirmed-transition.js';

const brief = `# Outcome
Ship the feature.
# Scope
One capability.
# Non-goals
No migration.
# Acceptance examples
- The feature works.
# Constraints and invariants
Keep compatibility.
# Decisions
Use existing APIs.
# Open questions

# Verification expectations
Run focused tests.
`;

describe('Loop spec conflict rebase', () => {
  let projectRoot: string;
  let paths: LoopProjectPaths;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-spec-rebase-'));
    paths = await loopProjectPaths(projectRoot, '.');
    await fs.writeFile(path.join(projectRoot, 'feature.ts'), 'export const feature = true;\n');
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  async function canonical(capability: string, source: string): Promise<string> {
    const file = path.join(paths.specsDir, capability, 'spec.md');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, source);
    return file;
  }

  async function advanceToArchive(name: string): Promise<string> {
    const changeDir = loopChangeDir(paths, name);
    await advanceLoopChange({ paths, name, evidence: { summary: 'shape is ready' } });
    await fs.appendFile(path.join(projectRoot, 'feature.ts'), '// implementation\n');
    await advanceLoopChange({
      paths,
      name,
      evidence: { summary: 'build is ready', artifacts: ['feature.ts'] },
    });
    await fs.writeFile(
      path.join(changeDir, 'verification.md'),
      await loopVerificationFixtureReport({ paths, name, evidenceRefs: ['feature.ts'] }),
    );
    await advanceLoopChange({
      paths,
      name,
      evidence: {
        summary: 'verification passed',
        verificationResult: 'pass',
        verificationReport: 'verification.md',
      },
    });
    return changeDir;
  }

  async function verifyAgain(name: string): Promise<void> {
    await fs.appendFile(path.join(projectRoot, 'feature.ts'), '// rebased implementation\n');
    const evidence = {
      summary: 'rebased implementation confirmed',
      artifacts: ['feature.ts'],
      confirmed: true,
    } as const;
    const prepared = await advanceLoopChange({
      paths,
      name,
      evidence,
    });
    const build =
      prepared.next === 'manual'
        ? await advanceLoopChange({
            paths,
            name,
            evidence: {
              ...evidence,
              allowPartialScopeHash: prepared.preparedScope!.scopeHash,
              partialReason: 'The concurrent canonical edit is intentionally outside this change.',
            },
          })
        : prepared;
    expect(build.change).toMatchObject({ phase: 'verify', approval: 'confirmed' });
    await fs.writeFile(
      path.join(loopChangeDir(paths, name), 'verification.md'),
      await loopVerificationFixtureReport({ paths, name }),
    );
    await advanceLoopChange({
      paths,
      name,
      evidence: {
        summary: 'rebased verification passed',
        verificationResult: 'pass',
        verificationReport: 'verification.md',
      },
    });
  }

  async function archiveReadyChange(name: string): Promise<void> {
    const now = new Date();
    const expectedPreflightHash = await readyLoopArchivePreflight({ paths, name, now });
    await archiveLoopChange({ paths, name, expectedPreflightHash, now });
  }

  it('refreshes a replace base and reopens Archive to Build for re-verification', async () => {
    const canonicalFile = await canonical('authentication', 'old canonical\n');
    const state = await createLoopChange({
      paths,
      name: 'replace-conflict',
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });
    const changeDir = loopChangeDir(paths, state.name);
    await fs.writeFile(path.join(changeDir, state.brief), brief);
    const proposed = path.join(changeDir, 'specs', 'authentication', 'spec.md');
    await fs.mkdir(path.dirname(proposed), { recursive: true });
    await fs.writeFile(proposed, 'target canonical\n');
    await advanceLoopChange({ paths, name: state.name, evidence: { summary: 'shape ready' } });
    await fs.appendFile(path.join(projectRoot, 'feature.ts'), '// replacement implementation\n');
    await advanceLoopChange({
      paths,
      name: state.name,
      evidence: { summary: 'build ready', artifacts: ['feature.ts'] },
    });
    await fs.writeFile(
      path.join(changeDir, 'verification.md'),
      await loopVerificationFixtureReport({
        paths,
        name: state.name,
        evidenceRefs: ['feature.ts'],
      }),
    );
    await advanceLoopChange({
      paths,
      name: state.name,
      evidence: {
        summary: 'verify ready',
        verificationResult: 'pass',
        verificationReport: 'verification.md',
      },
    });
    await fs.writeFile(canonicalFile, 'concurrent canonical\n');
    const concurrentHash = await sha256File(canonicalFile);
    await expect(inspectLoopArchivePreflight({ paths, name: state.name })).resolves.toMatchObject({
      ready: false,
      findingCodes: expect.arrayContaining(['spec-base-conflict']),
    });

    const rebased = await rebaseLoopSpecChanges({
      paths,
      name: state.name,
      summary: 'Re-read the concurrent authentication spec',
    });
    expect(rebased).toMatchObject({
      phase: 'build',
      verification_result: 'pending',
      verification_report: null,
      implementation_scope: null,
      verification_evidence: null,
      partial_allowance: null,
      spec_changes: [{ operation: 'replace', base_hash: concurrentHash }],
    });
    await verifyAgain(state.name);
    await archiveReadyChange(state.name);
    expect(await fs.readFile(canonicalFile, 'utf8')).toBe('target canonical\n');
  });

  it('refreshes a remove base and preserves the explicit removal intent', async () => {
    const canonicalFile = await canonical('legacy-auth', 'legacy v1\n');
    await createLoopChange({
      paths,
      name: 'remove-conflict',
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });
    await fs.writeFile(path.join(loopChangeDir(paths, 'remove-conflict'), 'brief.md'), brief);
    await markLoopSpecRemoval(paths, 'remove-conflict', 'legacy-auth');
    const changeDir = await advanceToArchive('remove-conflict');
    await fs.writeFile(canonicalFile, 'legacy v2 from another change\n');
    const concurrentHash = await sha256File(canonicalFile);
    await expect(
      inspectLoopArchivePreflight({ paths, name: 'remove-conflict' }),
    ).resolves.toMatchObject({
      ready: false,
      findingCodes: expect.arrayContaining(['spec-base-conflict']),
    });

    const rebased = await rebaseLoopSpecChanges({
      paths,
      name: 'remove-conflict',
      summary: 'Re-read the concurrent legacy spec',
    });
    expect(rebased).toMatchObject({
      phase: 'build',
      spec_changes: [{ operation: 'remove', base_hash: concurrentHash }],
    });
    expect(changeDir).toContain('remove-conflict');
    await verifyAgain('remove-conflict');
    await archiveReadyChange('remove-conflict');
    await expect(fs.access(canonicalFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
