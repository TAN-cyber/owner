import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLoopChange, loopChangeDir } from '../../../domains/owner-loop/loop-change.js';
import { inspectLoopStatus } from '../../../domains/owner-loop/loop-diagnostics.js';
import { loopCheckpointJournalFile } from '../../../domains/owner-loop/loop-checkpoint-storage.js';
import { loopProjectPaths } from '../../../domains/owner-loop/loop-paths.js';
import { checkpointLoopChange } from '../../../domains/owner-loop/loop-progress-checkpoint.js';
import type { LoopProjectPaths } from '../../../domains/owner-loop/loop-types.js';

const validBrief = `# Outcome
Resume safely.
# Scope
Loop status.
# Non-goals
No background worker.
# Acceptance examples
- A checkpoint can resume.
# Constraints and invariants
Keep state explicit.
# Decisions
Use a durable checkpoint.
# Open questions
None.
# Verification expectations
Run focused tests.
`;

describe('Loop resume status view', () => {
  let projectRoot: string;
  let paths: LoopProjectPaths;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-resume-view-'));
    paths = await loopProjectPaths(projectRoot, '.');
    await createLoopChange({
      paths,
      name: 'compact-resume',
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });
    await fs.writeFile(path.join(loopChangeDir(paths, 'compact-resume'), 'brief.md'), validBrief);
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('keeps default status compact and exposes bounded details on demand', async () => {
    await fs.writeFile(path.join(projectRoot, 'feature.ts'), 'export const feature = true;\n');
    await checkpointLoopChange({
      paths,
      name: 'compact-resume',
      summary: 'Feature implementation is ready',
      nextAction: 'Advance after reviewing the focused diff',
      artifacts: ['feature.ts'],
      expectedRevision: 1,
    });

    const compact = await inspectLoopStatus(paths, 'compact-resume');
    expect(compact).toMatchObject({
      revision: 2,
      inspection: {
        freshness: 'fresh',
        codes: [],
        reasonCount: 0,
        codesTruncated: false,
      },
      findingSummary: { total: 0, requiresUserDecision: false },
      detailsCommand: 'owner loop status compact-resume --details',
      checkpoint: { artifactCount: 1, stateRevision: 2 },
      continuation: {
        schema: 'owner.loop.continuation.v1',
        disposition: 'continue',
        action: 'advance-phase',
      },
    });
    expect(compact.findings).toBeUndefined();
    expect(compact.inspectionDetails).toBeUndefined();
    expect(compact.checkpointDetails).toBeUndefined();

    const details = await inspectLoopStatus(paths, 'compact-resume', { details: true });
    expect(details).toMatchObject({
      inspectionDetails: { freshness: 'fresh', reasons: [], reasonsTruncated: false },
      findings: [],
      checkpointDetails: {
        summary: 'Feature implementation is ready',
        manifestRef: expect.stringMatching(/^runtime\/checkpoints\/manifests\//u),
        artifacts: [{ path: 'feature.ts', size: 29 }],
      },
      budgets: {
        maxFindings: 50,
        maxInspectionReasons: 50,
        maxCheckpointArtifacts: 128,
        findingsTruncated: false,
        inspectionReasonsTruncated: false,
        checkpointArtifactsTruncated: false,
      },
    });
  });

  it('bounds stale artifact diagnostics in default status and exposes paths only in details', async () => {
    const artifacts = Array.from({ length: 128 }, (_, index) => `artifacts/item-${index}.txt`);
    await fs.mkdir(path.join(projectRoot, 'artifacts'));
    await Promise.all(
      artifacts.map((artifact) =>
        fs.writeFile(path.join(projectRoot, ...artifact.split('/')), `${artifact}\n`),
      ),
    );
    await checkpointLoopChange({
      paths,
      name: 'compact-resume',
      summary: 'All bounded artifacts were recorded',
      nextAction: 'Resume after checking freshness',
      artifacts,
      expectedRevision: 1,
    });
    await fs.rm(path.join(projectRoot, 'artifacts'), { recursive: true });

    const compact = await inspectLoopStatus(paths, 'compact-resume');
    expect(compact.inspection).toEqual({
      freshness: 'stale',
      codes: ['artifact-unavailable'],
      reasonCount: 128,
      codesTruncated: false,
    });
    expect(JSON.stringify(compact)).not.toContain('item-0.txt');

    const details = await inspectLoopStatus(paths, 'compact-resume', { details: true });
    expect(details.inspectionDetails).toMatchObject({
      reasonCount: 128,
      reasonsTruncated: true,
    });
    expect(details.inspectionDetails?.reasons).toHaveLength(50);
    expect(details.inspectionDetails?.reasons[0]).toMatch(/^artifact-unavailable:artifacts\//u);
    expect(details.budgets).toMatchObject({
      maxInspectionReasons: 50,
      inspectionReasonsTruncated: true,
    });
  });

  it('awaits the user only for an explicitly blocking brief question', async () => {
    const file = path.join(loopChangeDir(paths, 'compact-resume'), 'brief.md');
    await fs.writeFile(file, validBrief.replace('None.', '- [blocking] Which public behavior?'));
    const status = await inspectLoopStatus(paths, 'compact-resume', { details: true });
    expect(status.continuation).toMatchObject({
      disposition: 'await-user',
      requiresUserDecision: true,
      command: null,
    });
    expect(status.findings).toContainEqual(
      expect.objectContaining({
        code: 'brief-blocking-question',
        requiresUserDecision: true,
        path: 'owner/changes/compact-resume/brief.md',
      }),
    );
  });

  it('requires manual isolation for an invalid checkpoint journal without a repair loop', async () => {
    const journal = loopCheckpointJournalFile(paths, 'compact-resume');
    await fs.writeFile(journal, '{}\n');

    const status = await inspectLoopStatus(paths, 'compact-resume', { details: true });
    expect(status.findings).toContainEqual(
      expect.objectContaining({
        code: 'checkpoint-progress-invalid',
        requiredAction: 'manually-isolate-invalid-checkpoint',
        retryCommand: null,
        repairCommand: null,
      }),
    );
    expect(status.error).toContain('Automatic repair is unavailable');
  });
});
