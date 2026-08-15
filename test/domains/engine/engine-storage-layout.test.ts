import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { CLASSIC_RUN_STORAGE, NATIVE_RUN_STORAGE } from '../../../domains/engine/storage-layout.js';
import { startRun } from '../../../domains/engine/loop.js';
import {
  parseStoredRunStateValue,
  readRunStateAt,
  removeRunStateAt,
  startRunWithStorage,
  writeRunStateAt,
} from '../../../domains/engine/storage-run.js';
import type { SkillPackage } from '../../../domains/skill/types.js';

function runtimePackage(): SkillPackage {
  return {
    root: '/runtime/owner-native',
    packageKind: 'runtime',
    definition: {
      apiVersion: 'owner/v1alpha1',
      kind: 'Skill',
      metadata: {
        name: 'owner-native-runtime',
        version: '1',
        description: 'Native runtime',
      },
      goal: { statement: 'Advance Native state', inputs: [], outputs: [], success: ['done'] },
      orchestration: {
        mode: 'deterministic',
        entry: 'shape',
        steps: [{ id: 'shape', action: { type: 'checkpoint' } }],
      },
      skills: [],
      agents: [],
      tools: [],
    },
    guardrails: {
      allowedSkills: [],
      allowedAgents: [],
      allowedTools: [],
      maxIterations: 8,
      maxRetriesPerAction: 1,
      confirmationRequiredFor: [],
    },
    evals: [],
  };
}

describe('Engine Run storage layouts', () => {
  let changeDir: string;

  beforeEach(async () => {
    changeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-engine-storage-'));
  });

  afterEach(async () => {
    await fs.rm(changeDir, { recursive: true, force: true });
  });

  it('publishes stable Classic and Native layouts', () => {
    expect(CLASSIC_RUN_STORAGE).toEqual({
      stateRef: '.owner/run-state.json',
      pendingRef: '.owner/pending-action.json',
      trajectoryRef: '.owner/trajectory.jsonl',
      contextRef: '.owner/context.md',
      artifactsRef: '.owner/artifacts.json',
      checkpointRef: '.owner/checkpoint.json',
      snapshotsRef: '.owner/skill-snapshots',
    });
    expect(NATIVE_RUN_STORAGE).toEqual({
      stateRef: 'runtime/run-state.json',
      pendingRef: 'runtime/pending-action.json',
      trajectoryRef: 'runtime/trajectory.jsonl',
      contextRef: 'runtime/context.md',
      artifactsRef: 'runtime/artifacts.json',
      checkpointRef: 'runtime/checkpoints/latest.json',
      snapshotsRef: 'runtime/skill-snapshots',
    });
  });

  it('keeps the existing startRun function on Classic refs', () => {
    const state = startRun(runtimePackage(), 'classic-run', 'a'.repeat(64));
    expect(state.pendingRef).toBe('.owner/pending-action.json');
    expect(state.trajectoryRef).toBe('.owner/trajectory.jsonl');
    expect(state.checkpointRef).toBe('.owner/checkpoint.json');
  });

  it('writes and removes Native state without creating a .owner directory', async () => {
    const state = startRunWithStorage(
      runtimePackage(),
      'native-run',
      'b'.repeat(64),
      NATIVE_RUN_STORAGE,
    );

    await writeRunStateAt(changeDir, state, NATIVE_RUN_STORAGE);

    expect(await readRunStateAt(changeDir, NATIVE_RUN_STORAGE)).toEqual(state);
    expect(await fs.stat(path.join(changeDir, 'runtime', 'run-state.json'))).toBeDefined();
    await expect(fs.access(path.join(changeDir, '.owner'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    await removeRunStateAt(changeDir, NATIVE_RUN_STORAGE);
    expect(await readRunStateAt(changeDir, NATIVE_RUN_STORAGE)).toBeNull();
  });

  it('rejects storage refs that escape the Run root', () => {
    expect(() =>
      startRunWithStorage(runtimePackage(), 'bad-run', 'c'.repeat(64), {
        ...NATIVE_RUN_STORAGE,
        stateRef: '../run-state.json',
      }),
    ).toThrow('Run storage ref must stay inside the Run root');
  });

  it('validates every persisted RunState field before a journal can reuse it', () => {
    const state = startRunWithStorage(
      runtimePackage(),
      'strict-native-run',
      'd'.repeat(64),
      NATIVE_RUN_STORAGE,
    );
    expect(parseStoredRunStateValue(state)).toEqual(state);

    for (const key of Object.keys(state)) {
      const missing = { ...state } as Record<string, unknown>;
      delete missing[key];
      expect(() => parseStoredRunStateValue(missing), `missing ${key}`).toThrow(
        'Invalid Run state',
      );
    }
    expect(() => parseStoredRunStateValue({ ...state, contextRef: '../context.md' })).toThrow(
      'must stay inside the change directory',
    );
    expect(() => parseStoredRunStateValue({ ...state, status: 'paused' })).toThrow(
      'run_status is invalid',
    );
    expect(() => parseStoredRunStateValue({ ...state, retries: { shape: -1 } })).toThrow(
      'retry counts must be non-negative integers',
    );
    expect(() => parseStoredRunStateValue({ ...state, unexpected: true })).toThrow(
      'unknown field unexpected',
    );
  });
});
