import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  readPipelineState,
  writePipelineState,
} from '../../../domains/owner-pipeline/pipeline-store.js';
import type { PipelineState } from '../../../domains/owner-pipeline/pipeline-state.js';
import type { RunState } from '../../../domains/engine/types.js';

function pipelineState(): PipelineState {
  return {
    workflow: 'full',
    language: 'zh-CN',
    phase: 'build',
    contextCompression: 'beta',
    buildMode: 'executing-plans',
    buildPause: 'plan-ready',
    subagentDispatch: 'confirmed',
    tddMode: 'tdd',
    reviewMode: null,
    isolation: 'worktree',
    boundBranch: null,
    verifyMode: 'full',
    autoTransition: false,
    baseRef: 'abc123',
    designDoc: 'docs/superpowers/specs/design.md',
    plan: 'docs/superpowers/plans/plan.md',
    verifyResult: 'fail',
    verifyFailures: 2,
    verificationReport: 'docs/verification.md',
    branchStatus: 'handled',
    createdAt: '2026-06-01',
    verifiedAt: '2026-06-02',
    archiveConfirmation: null,
    archived: false,
    directOverride: true,
    handoffContext: '.owner/handoff/context.json',
    handoffHash: 'b'.repeat(64),
    pipelineProfile: 'full',
    pipelineMigration: 1,
  };
}

function runState(): RunState {
  return {
    runId: 'run-pipeline-1',
    skill: 'owner-pipeline',
    skillVersion: '1',
    skillHash: 'a'.repeat(64),
    orchestration: 'deterministic',
    currentStep: 'full.build.execute',
    iteration: 3,
    pending: null,
    pendingRef: '.owner/pending-action.json',
    trajectoryRef: '.owner/trajectory.jsonl',
    contextRef: '.owner/context.md',
    artifactsRef: '.owner/artifacts.json',
    checkpointRef: '.owner/checkpoint.json',
    status: 'running',
    retries: { action: 1 },
  };
}

describe('Pipeline state projection', () => {
  let changeDir: string;
  let stateFile: string;

  beforeEach(async () => {
    changeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-pipeline-state-'));
    stateFile = path.join(changeDir, '.owner.yaml');
  });

  afterEach(async () => {
    await fs.rm(changeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('round-trips every Pipeline field and Run projection', async () => {
    await writePipelineState(changeDir, {
      pipeline: pipelineState(),
      run: runState(),
    });

    expect(await readPipelineState(changeDir)).toEqual({
      pipeline: pipelineState(),
      run: runState(),
      unknownKeys: [],
    });
  });

  it('does not commit Pipeline state through a change directory replaced before commit', async () => {
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-pipeline-state-outside-'));
    const held = `${changeDir}-held`;
    const writeWithHook = writePipelineState as unknown as (
      changeDir: string,
      projection: Parameters<typeof writePipelineState>[1],
      options: { beforeCommit: () => void | Promise<void> },
    ) => Promise<void>;
    const linkProbe = `${changeDir}-link-probe`;
    try {
      try {
        await fs.symlink(outsideRoot, linkProbe, process.platform === 'win32' ? 'junction' : 'dir');
        if (process.platform === 'win32') await fs.rmdir(linkProbe);
        else await fs.unlink(linkProbe);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
        throw error;
      }

      await expect(
        writeWithHook(
          changeDir,
          {
            pipeline: pipelineState(),
            run: null,
          },
          {
            beforeCommit: async () => {
              const temporaryName = (await fs.readdir(changeDir)).find(
                (entry) => entry.includes('.owner.yaml.') && entry.endsWith('.tmp'),
              );
              expect(temporaryName).toBeDefined();
              await fs.rename(changeDir, held);
              await fs.writeFile(path.join(outsideRoot, '.owner.yaml'), 'keep: true\n', 'utf8');
              await fs.writeFile(path.join(outsideRoot, temporaryName!), 'outside-temp\n', 'utf8');
              await fs.symlink(
                outsideRoot,
                changeDir,
                process.platform === 'win32' ? 'junction' : 'dir',
              );
            },
          },
        ),
      ).rejects.toThrow(/changed|junction|outside|managed parent/iu);
      await expect(fs.readFile(path.join(outsideRoot, '.owner.yaml'), 'utf8')).resolves.toBe(
        'keep: true\n',
      );
    } finally {
      try {
        if ((await fs.lstat(changeDir)).isSymbolicLink()) {
          if (process.platform === 'win32') await fs.rmdir(changeDir);
          else await fs.unlink(changeDir);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (
        await fs.stat(held).then(
          () => true,
          () => false,
        )
      ) {
        await fs.rename(held, changeDir);
      }
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it('reads a legacy-only state without inventing a Run', async () => {
    await writePipelineState(changeDir, { pipeline: pipelineState(), run: null });

    const projection = await readPipelineState(changeDir);

    expect(projection.pipeline).toEqual(pipelineState());
    expect(projection.run).toBeNull();
  });

  it('reads a Run-only state without inventing Pipeline fields', async () => {
    await writePipelineState(changeDir, { pipeline: null, run: runState() });

    const projection = await readPipelineState(changeDir);

    expect(projection.pipeline).toBeNull();
    expect(projection.run).toEqual(runState());
  });

  it('preserves comments and unknown top-level fields across atomic writes', async () => {
    await fs.writeFile(
      stateFile,
      [
        '# user heading',
        'workflow: full # selected workflow',
        'phase: build',
        'design_doc: null',
        'plan: null',
        'build_mode: direct',
        'isolation: branch',
        'verify_mode: light',
        'verify_result: pending',
        'verified_at: null',
        'archived: false',
        'custom_user_field: keep-me',
        '',
      ].join('\n'),
    );

    const projection = await readPipelineState(changeDir);
    expect(projection.unknownKeys).toEqual(['custom_user_field']);
    projection.pipeline!.phase = 'verify';
    await writePipelineState(changeDir, projection);

    const raw = await fs.readFile(stateFile, 'utf8');
    expect(raw).toContain('# user heading');
    expect(raw).toContain('workflow: full # selected workflow');
    expect(raw).toContain('custom_user_field: keep-me');
    expect(raw).toContain('phase: verify');
  });

  it.each([
    ['workflow', 'ancient'],
    ['phase', 'planning'],
    ['context_compression', 'on'],
    ['build_mode', 'agent'],
    ['build_pause', 'paused'],
    ['subagent_dispatch', 'yes'],
    ['tdd_mode', 'sometimes'],
    ['isolation', 'folder'],
    ['verify_mode', 'medium'],
    ['verify_result', 'maybe'],
    ['branch_status', 'open'],
    ['archive_confirmation', 'yes'],
    ['pipeline_profile', 'other'],
  ])('rejects invalid %s values', async (field, value) => {
    await writePipelineState(changeDir, { pipeline: pipelineState(), run: runState() });
    const raw = await fs.readFile(stateFile, 'utf8');
    await fs.writeFile(
      stateFile,
      raw.replace(new RegExp(`^${field}:.*$`, 'm'), `${field}: ${value}`),
    );

    await expect(readPipelineState(changeDir)).rejects.toThrow(`Invalid Pipeline state: ${field}`);
  });

  it('rejects malformed YAML without replacing the original file', async () => {
    const malformed = 'workflow: [full\nphase: build\n';
    await fs.writeFile(stateFile, malformed);

    await expect(readPipelineState(changeDir)).rejects.toThrow('Invalid Pipeline state document');
    expect(await fs.readFile(stateFile, 'utf8')).toBe(malformed);
  });

  // The engine-persist refactor reads state leniently: an incomplete legacy
  // projection degrades to a null Pipeline state (so callers can fall back to
  // the legacy summary and migrate) instead of throwing. Strict rejection is
  // enforced by the `validate` command, not the reader.
  it('degrades incomplete legacy projections to a null Pipeline state', async () => {
    await fs.writeFile(stateFile, 'workflow: full\nphase: build\n');

    const projection = await readPipelineState(changeDir);
    expect(projection.pipeline).toBeNull();
    expect(projection.run).toBeNull();
  });

  it('validates a complete projection before replacing the existing file', async () => {
    await writePipelineState(changeDir, { pipeline: pipelineState(), run: runState() });
    const original = await fs.readFile(stateFile, 'utf8');
    const invalid = pipelineState();
    invalid.handoffHash = 'not-a-hash';

    await expect(
      writePipelineState(changeDir, { pipeline: invalid, run: runState() }),
    ).rejects.toThrow('Invalid Pipeline state: handoff_hash');
    expect(await fs.readFile(stateFile, 'utf8')).toBe(original);
  });
});
