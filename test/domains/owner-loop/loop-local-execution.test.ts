import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  parseLoopLocalExecution,
  readLoopLocalExecution,
  readOrRebuildLoopLocalExecution,
  rebuildLoopLocalExecution,
  writeLoopLocalExecution,
} from '../../../domains/owner-loop/loop-local-execution.js';
import { createLoopPortableState } from '../../../domains/owner-loop/loop-portable-state.js';
import type { LoopLocalExecutionState } from '../../../domains/owner-loop/loop-portable-types.js';

describe('Loop local execution overlay', () => {
  let root: string;
  let runtimeRoot: string;
  let file: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-local-execution-'));
    runtimeRoot = path.join(root, '.owner', 'runtime', 'loop');
    file = path.join(runtimeRoot, 'changes', 'portable-resume', 'state.json');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('atomically round-trips a strict local-only state', async () => {
    const portableState = createLoopPortableState({
      name: 'portable-resume',
      language: 'en',
      createdAt: '2026-08-09T00:00:00.000Z',
    });
    const state = rebuildLoopLocalExecution({ portableState, projectRoot: root });
    await writeLoopLocalExecution(file, state, { containedRoot: runtimeRoot });

    await expect(readLoopLocalExecution(file)).resolves.toEqual(state);
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toMatchObject({
      schema: 'owner.loop.local-execution.v4',
      change: 'portable-resume',
      basedOnStateVersion: 1,
      execution: null,
      checks: [],
    });
    expect(() => parseLoopLocalExecution({ ...state, portableLoop: {} })).toThrow(
      /unknown field.*portableLoop/iu,
    );
  });

  it.each([
    ['missing', null],
    ['invalid', '{broken json'],
  ] as const)('rebuilds a %s overlay from portable state', async (expectedReason, contents) => {
    const portableState = {
      ...createLoopPortableState({
        name: 'portable-resume',
        language: 'en',
        createdAt: '2026-08-09T00:00:00.000Z',
      }),
      state_version: 7,
      loop: {
        ...createLoopPortableState({
          name: 'portable-resume',
          language: 'en',
          createdAt: '2026-08-09T00:00:00.000Z',
        }).loop,
        iteration: 3,
        no_progress_count: 2,
        next_action: 'Repair A2',
      },
    };
    if (contents !== null) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, contents, 'utf8');
    }

    const result = await readOrRebuildLoopLocalExecution({
      file,
      portableState,
      projectRoot: root,
      containedRoot: runtimeRoot,
    });

    expect(result).toMatchObject({ rebuilt: true, reason: expectedReason });
    expect(result.state).toMatchObject({ basedOnStateVersion: 7, execution: null, checks: [] });
    expect(portableState.loop).toMatchObject({
      iteration: 3,
      no_progress_count: 2,
      next_action: 'Repair A2',
    });
    await expect(readLoopLocalExecution(file)).resolves.toEqual(result.state);
  });

  it('discards a version-mismatched overlay instead of allowing JSON to override YAML', async () => {
    const portableState = {
      ...createLoopPortableState({
        name: 'portable-resume',
        language: 'en',
        createdAt: '2026-08-09T00:00:00.000Z',
      }),
      state_version: 9,
    };
    const stale: LoopLocalExecutionState = {
      ...rebuildLoopLocalExecution({ portableState, projectRoot: root }),
      basedOnStateVersion: 8,
      execution: {
        operationId: 'old-operation',
        stage: 'verifying',
        actor: 'verifier',
        executionId: 'old-execution',
        status: 'running',
        startedAt: '2026-08-09T00:01:00.000Z',
        requestCheckRounds: 2,
      },
    };
    await writeLoopLocalExecution(file, stale, { containedRoot: runtimeRoot });

    const result = await readOrRebuildLoopLocalExecution({
      file,
      portableState,
      projectRoot: root,
      containedRoot: runtimeRoot,
    });

    expect(result).toMatchObject({ rebuilt: true, reason: 'version-mismatch' });
    expect(result.state).toMatchObject({
      basedOnStateVersion: 9,
      execution: null,
      checks: [],
    });
  });

  it('keeps a matching overlay and validates local check execution facts', async () => {
    const portableState = createLoopPortableState({
      name: 'portable-resume',
      language: 'en',
      createdAt: '2026-08-09T00:00:00.000Z',
    });
    const state: LoopLocalExecutionState = {
      ...rebuildLoopLocalExecution({ portableState, projectRoot: root }),
      execution: {
        operationId: 'operation-1',
        stage: 'checking',
        actor: 'runtime',
        executionId: null,
        status: 'running',
        startedAt: '2026-08-09T00:01:00.000Z',
        requestCheckRounds: 0,
      },
      checks: [
        {
          id: 'unit-tests',
          name: 'Unit tests',
          operationId: 'operation-1',
          status: 'running',
          repeatable: true,
          timeoutMs: 10_000,
          executionCount: 1,
          argv: ['pnpm', 'vitest', 'run'],
          cwd: root,
          exitCode: null,
          startedAt: '2026-08-09T00:01:00.000Z',
          completedAt: null,
          log: 'logs/checks/unit-tests.log',
        },
      ],
    };
    await writeLoopLocalExecution(file, state, { containedRoot: runtimeRoot });

    const result = await readOrRebuildLoopLocalExecution({
      file,
      portableState,
      projectRoot: root,
      containedRoot: runtimeRoot,
    });
    expect(result).toEqual({ state, rebuilt: false, reason: null });

    expect(() =>
      parseLoopLocalExecution({
        ...state,
        checks: [{ ...state.checks[0], secretSummary: 'not allowed' }],
      }),
    ).toThrow(/unknown field.*secretSummary/iu);
  });
});
