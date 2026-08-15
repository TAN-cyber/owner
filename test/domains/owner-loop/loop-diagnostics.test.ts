import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLoopChange, loopChangeDir } from '../../../domains/owner-loop/loop-change.js';
import {
  inspectLoopStatus,
  listLoopStatus,
  listLoopStatusPage,
  LOOP_STATUS_PAGE_LIMITS,
} from '../../../domains/owner-loop/loop-diagnostics.js';
import { loopContinuation } from '../../../domains/owner-loop/loop-continuation.js';
import { loopChangeRuntimeDir, loopProjectPaths } from '../../../domains/owner-loop/loop-paths.js';
import { selectLoopChange } from '../../../domains/owner-loop/loop-selection.js';
import type { LoopChangeState, LoopProjectPaths } from '../../../domains/owner-loop/loop-types.js';
import { loopVerificationFixtureReport } from '../../helpers/loop-verification.js';
import { advanceLoopChange } from '../../helpers/loop-confirmed-transition.js';

const brief = `# Outcome
Ship a focused outcome.
# Scope
One capability.
# Non-goals
No migration.
# Acceptance examples
- The behavior works.
# Constraints and invariants
Keep compatibility.
# Decisions
Use Loop state.
# Open questions
None.
# Verification expectations
Run focused checks.
`;

describe('Loop status diagnostics', () => {
  let projectRoot: string;
  let paths: LoopProjectPaths;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-status-'));
    paths = await loopProjectPaths(projectRoot, '.');
  });

  it('keeps workspace advisories visible without blocking an otherwise ready Archive', () => {
    const continuation = loopContinuation({
      state: {
        name: 'ready-change',
        phase: 'archive',
        revision: 4,
      } as LoopChangeState,
      archiveReady: true,
      findings: [
        {
          code: 'workspace-root-changed',
          message: 'The physical workspace root changed after implementation.',
          severity: 'warning',
          path: null,
          requiredAction: 'inspect-workspace-advisory',
          retryCommand: 'owner loop status ready-change',
          repairCommand: null,
          requiresUserDecision: false,
        },
      ],
    });

    expect(continuation).toMatchObject({
      disposition: 'continue',
      action: 'archive',
      command: 'owner loop archive ready-change --dry-run',
    });

    const unknownWorkspaceIntegrityFinding = loopContinuation({
      state: {
        name: 'ready-change',
        phase: 'archive',
        revision: 4,
      } as LoopChangeState,
      archiveReady: true,
      findings: [
        {
          code: 'workspace-integrity-failed',
          message: 'The workspace integrity check failed.',
          severity: 'error',
          path: null,
          requiredAction: 'resolve-finding',
          retryCommand: 'owner loop status ready-change',
          repairCommand: null,
          requiresUserDecision: false,
        },
      ],
    });
    expect(unknownWorkspaceIntegrityFinding).toMatchObject({
      disposition: 'blocked',
      action: 'none',
    });
  });

  it('keeps a failed workspace finish blocked after Archive has moved the change', () => {
    const continuation = loopContinuation({
      state: {
        name: 'finish-blocked',
        phase: 'archive',
        revision: 4,
      } as LoopChangeState,
      archiveReady: false,
    });

    expect(continuation).toMatchObject({
      disposition: 'blocked',
      action: 'none',
      command: null,
    });
  });

  it('blocks status when a workspace binding cannot be parsed safely', async () => {
    const state = await createLoopChange({
      paths,
      name: 'invalid-workspace',
      language: 'en',
      workspaceBinding: { isolation: 'current', changeBranch: null, targetBranch: null },
    });
    await fs.writeFile(
      path.join(loopChangeRuntimeDir(paths, state.name), 'workspace.json'),
      '{"schema":"owner.loop.workspace.v3","isolation":"invalid"}\n',
    );

    await expect(inspectLoopStatus(paths, state.name)).resolves.toMatchObject({
      name: state.name,
      phase: 'shape',
      nextCommand: null,
      findingSummary: {
        errors: expect.any(Number),
        codes: expect.arrayContaining(['workspace-binding-invalid']),
      },
      continuation: {
        disposition: 'blocked',
        action: 'none',
        requiredInputs: expect.arrayContaining(['repair-workspace-binding']),
      },
    });
  });

  it('does not route an Archive binding failure to receipt refresh', () => {
    const continuation = loopContinuation({
      state: {
        name: 'archived-change',
        phase: 'archive',
        revision: 4,
      } as LoopChangeState,
      findings: [
        {
          code: 'verification-receipt-binding-mismatch',
          message: 'A verification receipt is stale.',
          severity: 'error',
          path: null,
          requiredAction: 'refresh-verification-receipts',
          retryCommand: null,
          repairCommand: null,
          requiresUserDecision: false,
        },
      ],
    });

    expect(continuation).toMatchObject({
      disposition: 'blocked',
      action: 'none',
      command: null,
    });
  });

  it('returns policy-aware continuation after a ready Archive preview', () => {
    const state = {
      name: 'ready-change',
      phase: 'archive',
      revision: 4,
    } as LoopChangeState;
    const preflightHash = 'a'.repeat(64);

    expect(
      loopContinuation({
        state,
        archiveReady: true,
        archiveConfirmation: 'automatic',
        archivePreflightHash: preflightHash,
      }),
    ).toMatchObject({
      disposition: 'continue',
      action: 'archive',
      command: `owner loop archive ready-change --expect-preflight ${preflightHash}`,
      commandArgs: [
        'owner',
        'loop',
        'archive',
        'ready-change',
        '--expect-preflight',
        preflightHash,
      ],
      requiresUserDecision: false,
      requiredInputs: [],
    });
    expect(
      loopContinuation({
        state,
        archiveReady: true,
        archiveConfirmation: 'required',
        archivePreflightHash: preflightHash,
      }),
    ).toMatchObject({
      disposition: 'await-user',
      action: 'archive',
      command: null,
      commandArgs: [
        'owner',
        'loop',
        'archive',
        'ready-change',
        '--expect-preflight',
        preflightHash,
        '--confirmed',
      ],
      requiresUserDecision: true,
      requiredInputs: ['archive-confirmation'],
      inputOptions: [
        expect.objectContaining({
          input: 'archive-confirmation',
          flags: ['--confirmed'],
          choices: ['confirm', 'keep-active'],
        }),
      ],
    });
  });

  it('returns complete phase argv templates and alterloop Build evidence', () => {
    const build = loopContinuation({
      state: {
        name: 'build-change',
        phase: 'build',
        revision: 3,
        approval: 'confirmed',
        verification_result: 'pending',
      } as LoopChangeState,
    });
    expect(build).toMatchObject({
      commandArgs: [
        'owner',
        'loop',
        'next',
        'build-change',
        '--summary',
        '<summary>',
        '--artifact',
        '<project-relative-path>',
      ],
      requiredInputs: ['summary', 'artifact-or-no-code-reason'],
      inputOptions: expect.arrayContaining([
        expect.objectContaining({
          input: 'artifact-or-no-code-reason',
          flags: ['--artifact'],
          repeatable: true,
          alterloopGroup: 'build-evidence',
        }),
        expect.objectContaining({
          input: 'artifact-or-no-code-reason',
          flags: ['--no-code-reason'],
          alterloopGroup: 'build-evidence',
        }),
      ]),
    });

    const verify = loopContinuation({
      state: {
        name: 'verify-change',
        phase: 'verify',
        revision: 4,
      } as LoopChangeState,
    });
    expect(verify.commandArgs).toEqual([
      'owner',
      'loop',
      'next',
      'verify-change',
      '--summary',
      '<summary>',
      '--result',
      '<pass|fail>',
      '--report',
      '<change-relative-path>',
    ]);
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  async function validChange(name: string): Promise<void> {
    const state = await createLoopChange({
      paths,
      name,
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });
    await fs.writeFile(path.join(loopChangeDir(paths, name), state.brief), brief);
  }

  it('returns an empty projection for an empty Loop root', async () => {
    expect(await listLoopStatus(paths)).toEqual([]);
  });

  it('sorts multiple active changes and projects only Loop next commands', async () => {
    await validChange('zeta-change');
    await validChange('alpha-change');
    await selectLoopChange(paths, 'zeta-change');

    const statuses = await listLoopStatus(paths);
    expect(statuses.map((status) => status.name)).toEqual(['alpha-change', 'zeta-change']);
    expect(statuses[0]).toMatchObject({
      phase: 'shape',
      selected: false,
      nextCommand: 'owner loop next alpha-change --summary "<summary>" --confirmed',
    });
    expect(statuses[1]).toMatchObject({ selected: true });
    expect(JSON.stringify(statuses)).not.toMatch(/openspec|superpowers|owner pipeline/iu);
  });

  it('reports contract drift after approval and requires a fresh confirmation', async () => {
    await validChange('contract-drift');
    const changeDir = loopChangeDir(paths, 'contract-drift');
    await advanceLoopChange({
      paths,
      name: 'contract-drift',
      evidence: { summary: 'shape approved' },
    });
    await fs.writeFile(
      path.join(changeDir, 'brief.md'),
      brief.replace('The behavior works.', 'The changed behavior works.'),
    );

    const status = await inspectLoopStatus(paths, 'contract-drift', { details: true });
    expect(status).toMatchObject({
      phase: 'build',
      findingSummary: {
        errors: 1,
        requiresUserDecision: true,
        codes: expect.arrayContaining(['contract-changed-after-approval']),
      },
      continuation: {
        disposition: 'await-user',
        requiredInputs: ['re-confirm-contract'],
      },
      findings: [
        expect.objectContaining({
          code: 'contract-changed-after-approval',
          retryCommand: 'owner loop next contract-drift --summary "<summary>" --confirmed',
        }),
      ],
    });
  });

  it('pages a bounded status list and rejects stale or tampered cursors', async () => {
    for (let index = 0; index < LOOP_STATUS_PAGE_LIMITS.maxItems + 2; index += 1) {
      const name = `page-change-${String(index).padStart(2, '0')}`;
      const directory = path.join(paths.changesDir, name);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, 'owner-state.yaml'), 'schema: [invalid\n');
    }

    const first = await listLoopStatusPage(paths);
    expect(first).toMatchObject({
      schema: 'owner.loop.status-page.v1',
      total: LOOP_STATUS_PAGE_LIMITS.maxItems + 2,
      offset: 0,
    });
    expect(first.items).toHaveLength(LOOP_STATUS_PAGE_LIMITS.maxItems);
    expect(first.nextCursor).not.toBeNull();
    expect(first.nextPageArgs).toEqual(['owner', 'loop', 'status', '--cursor', first.nextCursor]);
    expect(Buffer.byteLength(JSON.stringify(first), 'utf8')).toBeLessThanOrEqual(
      LOOP_STATUS_PAGE_LIMITS.maxSerializedBytes,
    );

    const second = await listLoopStatusPage(paths, { cursor: first.nextCursor });
    expect(second.offset).toBe(LOOP_STATUS_PAGE_LIMITS.maxItems);
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();

    await fs.mkdir(path.join(paths.changesDir, 'page-change-new'));
    await expect(listLoopStatusPage(paths, { cursor: first.nextCursor })).rejects.toThrow(
      'cursor is stale',
    );
    await expect(
      listLoopStatusPage(paths, { cursor: `${first.nextCursor!.slice(0, -1)}0` }),
    ).rejects.toThrow(/cursor (?:is stale|integrity check failed)/u);
  });

  it('does not hide a malformed current selection as an unselected status list', async () => {
    await validChange('healthy-change');
    await fs.mkdir(path.join(projectRoot, '.owner'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, '.owner', 'current-change.json'), '{broken');

    await expect(listLoopStatusPage(paths)).rejects.toThrow();
  });

  it('reports malformed change YAML without hiding the other changes', async () => {
    await validChange('healthy-change');
    const broken = path.join(paths.changesDir, 'broken-change');
    await fs.mkdir(broken, { recursive: true });
    await fs.writeFile(path.join(broken, 'owner-state.yaml'), 'schema: [invalid\n');

    const statuses = await listLoopStatus(paths);
    expect(statuses).toHaveLength(2);
    expect(statuses.find((status) => status.name === 'broken-change')).toMatchObject({
      phase: 'invalid',
      nextCommand: null,
      archiveReady: false,
    });
  });

  it('keeps large status pages free of synthetic conflict-inspection failures', async () => {
    for (let index = 0; index < 33; index += 1) {
      await validChange(`large-change-${String(index).padStart(2, '0')}`);
    }

    const first = await listLoopStatusPage(paths);

    expect(first.items).toHaveLength(LOOP_STATUS_PAGE_LIMITS.maxItems);
    expect(first.items.flatMap((item) => item.findingSummary.codes)).not.toContain(
      'loop-conflict-inspection-invalid',
    );
  });

  it('only marks Archive ready after brief, spec, and verification checks pass', async () => {
    await validChange('ready-change');
    const changeDir = loopChangeDir(paths, 'ready-change');
    await advanceLoopChange({
      paths,
      name: 'ready-change',
      evidence: { summary: 'shape is ready' },
    });
    await fs.writeFile(path.join(projectRoot, 'feature.ts'), 'export const feature = true;\n');
    await advanceLoopChange({
      paths,
      name: 'ready-change',
      evidence: { summary: 'build is ready', artifacts: ['feature.ts'] },
    });
    await fs.writeFile(
      path.join(changeDir, 'verification.md'),
      await loopVerificationFixtureReport({
        paths,
        name: 'ready-change',
        evidenceRefs: ['feature.ts'],
      }),
    );
    await advanceLoopChange({
      paths,
      name: 'ready-change',
      evidence: {
        summary: 'verification passed',
        verificationResult: 'pass',
        verificationReport: 'verification.md',
      },
    });

    const readyStatus = await inspectLoopStatus(paths, 'ready-change');
    expect(readyStatus).toMatchObject({
      archiveReady: true,
      nextCommand: 'owner loop archive ready-change --dry-run',
    });
    expect(readyStatus).not.toHaveProperty('error');
    await fs.rm(path.join(changeDir, 'verification.md'));
    expect(await inspectLoopStatus(paths, 'ready-change')).toMatchObject({
      archiveReady: false,
      nextCommand: 'owner loop next ready-change --summary "<summary>"',
    });
  });

  it('never scans a fixture openspec tree', async () => {
    await validChange('loop-only');
    await fs.mkdir(path.join(projectRoot, 'openspec', 'changes', 'foreign-change'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(projectRoot, 'openspec', 'changes', 'foreign-change', 'change.yaml'),
      'not: loop\n',
    );
    expect((await listLoopStatus(paths)).map((status) => status.name)).toEqual(['loop-only']);
  });

  it('reports a pending ordinary transition without changing it', async () => {
    await validChange('pending-transition');
    await expect(
      advanceLoopChange({
        paths,
        name: 'pending-transition',
        evidence: { summary: 'shape is ready' },
        hooks: {
          afterPrepared: () => {
            throw new Error('interrupt transition');
          },
        },
      }),
    ).rejects.toThrow('interrupt transition');

    expect(await inspectLoopStatus(paths, 'pending-transition')).toMatchObject({
      phase: 'shape',
      error: 'Loop phase transition recovery is pending',
    });
  });

  it('reports a missing Run state after a change has started', async () => {
    await validChange('missing-run');
    await advanceLoopChange({
      paths,
      name: 'missing-run',
      evidence: { summary: 'shape is ready' },
    });
    await fs.rm(path.join(loopChangeRuntimeDir(paths, 'missing-run'), 'run-state.json'));

    expect(await inspectLoopStatus(paths, 'missing-run')).toMatchObject({
      phase: 'build',
      error: 'Loop change references a missing Run state',
    });
  });

  it('keeps a change discoverable when its whole local Runtime is missing', async () => {
    await validChange('missing-runtime');
    await advanceLoopChange({
      paths,
      name: 'missing-runtime',
      evidence: { summary: 'shape is ready' },
    });
    await fs.rm(loopChangeRuntimeDir(paths, 'missing-runtime'), { recursive: true });

    expect(await inspectLoopStatus(paths, 'missing-runtime', { details: true })).toMatchObject({
      name: 'missing-runtime',
      phase: 'build',
      runtime: { status: 'missing', layout: 'missing' },
      nextCommand: 'owner loop next missing-runtime --summary "<summary>"',
      findingSummary: { codes: ['runtime-missing'], warnings: 1, errors: 0 },
    });
  });
});
