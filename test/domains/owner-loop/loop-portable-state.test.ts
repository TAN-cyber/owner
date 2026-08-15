import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

import {
  appendLoopPortableHistory,
  compareAndSwapLoopPortableState,
  createLoopPortableState,
  LoopPortableStateVersionConflictError,
  parseLoopPortableState,
  readLoopPortableState,
  writeLoopPortableState,
} from '../../../domains/owner-loop/loop-portable-state.js';
import { toLoopPortableText } from '../../../domains/owner-loop/loop-portable-text.js';
import type {
  LoopPortableHistoryEntry,
  LoopPortableState,
} from '../../../domains/owner-loop/loop-portable-types.js';

describe('Loop portable state', () => {
  let root: string;
  let file: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-portable-state-'));
    file = path.join(root, 'owner-state.yaml');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('round-trips the v4 portable schema and rejects unknown fields at every level', async () => {
    const state = createLoopPortableState({
      name: 'portable-resume',
      language: 'zh-CN',
      createdAt: '2026-08-09T00:00:00.000Z',
      nextAction: '确认验收项',
    });
    await writeLoopPortableState(file, state, { containedRoot: root });

    await expect(readLoopPortableState(file)).resolves.toEqual(state);
    expect(await fs.readFile(file, 'utf8')).toContain('schema: owner.loop.v4');

    expect(() => parseLoopPortableState({ ...state, unexpected: true })).toThrow(
      /unknown field.*unexpected/iu,
    );
    expect(() =>
      parseLoopPortableState({
        ...state,
        loop: { ...state.loop, hidden_hash: 'not-allowed' },
      }),
    ).toThrow(/unknown field.*hidden_hash/iu);

    await fs.writeFile(file, 'schema: owner.loop.v4\nschema: owner.loop.v4\n', 'utf8');
    await expect(readLoopPortableState(file)).rejects.toThrow(
      /invalid YAML|Map keys must be unique/iu,
    );
  });

  it('uses state_version for an atomic compare-and-swap boundary', async () => {
    const state = createLoopPortableState({
      name: 'portable-cas',
      language: 'en',
      createdAt: '2026-08-09T00:00:00.000Z',
    });
    await writeLoopPortableState(file, state, { containedRoot: root });
    const next: LoopPortableState = {
      ...state,
      state_version: 2,
      loop: { ...state.loop, next_action: 'Confirm acceptance' },
    };

    await expect(
      compareAndSwapLoopPortableState({
        file,
        expectedStateVersion: 1,
        next,
        containedRoot: root,
      }),
    ).resolves.toEqual(next);
    await expect(readLoopPortableState(file)).resolves.toEqual(next);

    const stale = { ...next, state_version: 2, loop: { ...next.loop, next_action: 'stale' } };
    await expect(
      compareAndSwapLoopPortableState({
        file,
        expectedStateVersion: 1,
        next: stale,
        containedRoot: root,
      }),
    ).rejects.toBeInstanceOf(LoopPortableStateVersionConflictError);
    await expect(readLoopPortableState(file)).resolves.toEqual(next);
  });

  it('keeps the parent contract hash optional for existing portable changes', async () => {
    const ordinary = createLoopPortableState({
      name: 'ordinary-change',
      language: 'en',
      createdAt: '2026-08-09T00:00:00.000Z',
    });
    await writeLoopPortableState(file, ordinary, { containedRoot: root });
    await expect(readLoopPortableState(file)).resolves.not.toHaveProperty('children_contract_hash');

    const parent = parseLoopPortableState({
      ...ordinary,
      children_contract_hash: 'a'.repeat(64),
    });
    await writeLoopPortableState(file, parent, { containedRoot: root });
    await expect(readLoopPortableState(file)).resolves.toMatchObject({
      children_contract_hash: 'a'.repeat(64),
    });
    expect(() =>
      parseLoopPortableState({ ...ordinary, children_contract_hash: 'not-a-hash' }),
    ).toThrow(/children contract hash/iu);
  });

  it('keeps only 50 history entries and folds older facts into a non-decision overflow', () => {
    let state = createLoopPortableState({
      name: 'bounded-history',
      language: 'en',
      createdAt: '2026-08-09T00:00:00.000Z',
    });
    for (let index = 0; index < 55; index += 1) {
      const entry: LoopPortableHistoryEntry = {
        goal_cycle: 1,
        iteration: index + 1,
        attempt: 1,
        outcome: index % 2 === 0 ? 'fail' : 'execution-error',
        unresolved_ids: [],
        summary: toLoopPortableText(`iteration ${index + 1}`),
        completed_at: new Date(Date.UTC(2026, 7, 9, 0, index)).toISOString(),
      };
      state = appendLoopPortableHistory(state, entry);
    }

    expect(state.history).toHaveLength(50);
    expect(state.history[0].iteration).toBe(6);
    expect(state.history_overflow).toEqual({
      dropped_entries: 5,
      first_dropped_at: '2026-08-09T00:00:00.000Z',
      last_dropped_at: '2026-08-09T00:04:00.000Z',
      outcome_counts: {
        pass: 0,
        fail: 3,
        blocked: 0,
        'execution-error': 2,
        recovery: 0,
      },
    });
    expect(() => parseLoopPortableState(state)).not.toThrow();
  });

  it('truncates only diagnostic PortableText without truncating acceptance decision data', () => {
    const diagnostic = '🙂'.repeat(10);
    expect(toLoopPortableText(diagnostic, 9)).toEqual({ text: '🙂🙂', truncated: true });

    const state = createLoopPortableState({
      name: 'long-acceptance',
      language: 'en',
      createdAt: '2026-08-09T00:00:00.000Z',
    });
    const acceptanceText = 'observable requirement '.repeat(10_000);
    const parsed = parseLoopPortableState({
      ...state,
      acceptance: [
        {
          id: 'A1',
          source: 'brief.md',
          text: acceptanceText,
          result: 'failed',
          reason: toLoopPortableText('diagnostic '.repeat(10_000), 64),
        },
      ],
      loop: { ...state.loop, previous_unresolved_ids: ['A1'] },
    });

    expect(parsed.acceptance[0].id).toBe('A1');
    expect(parsed.acceptance[0].text).toBe(acceptanceText);
    expect(parsed.acceptance[0].reason).toMatchObject({ truncated: true });
    expect(Buffer.byteLength(parsed.acceptance[0].reason!.text, 'utf8')).toBeLessThanOrEqual(64);
  });

  it('parses a complete passing state while enforcing trusted role separation', () => {
    const initial = createLoopPortableState({
      name: 'complete-state',
      language: 'en',
      createdAt: '2026-08-09T00:00:00.000Z',
    });
    const state = parseLoopPortableState({
      ...initial,
      phase: 'archive',
      state_version: 8,
      spec_changes: [
        { capability: 'loop-loop', operation: 'modify', source: 'specs/loop-loop/spec.md' },
      ],
      workspace: {
        isolation: 'worktree',
        change_branch: 'beta17',
        target_branch: 'beta17',
        finish: 'push',
      },
      loop: {
        ...initial.loop,
        stage: 'archive-ready',
        iteration: 1,
        attempt: 1,
        next_action: 'Archive after confirmation',
      },
      acceptance: [
        {
          id: 'A1',
          source: 'brief.md',
          text: 'The independent verifier covers this item.',
          result: 'passed',
          reason: toLoopPortableText('Observed in the implementation.'),
        },
      ],
      builder_handoff: {
        candidate_id: 'candidate-1',
        identity_provider: 'host-a',
        builder_execution_ref: 'builder-1',
        iteration: 1,
        summary: toLoopPortableText('Implemented the change.'),
        addressed_acceptance_ids: ['A1'],
        checks: [],
        checks_truncated: false,
        known_limits: [],
        known_limits_truncated: false,
        submitted_at: '2026-08-09T00:01:00.000Z',
      },
      verification: {
        candidate_id: 'candidate-1',
        identity_provider: 'host-a',
        verifier_execution_ref: 'verifier-1',
        iteration: 1,
        attempt: 1,
        verdict: 'pass',
        checks: [
          {
            id: 'test',
            name: toLoopPortableText('test'),
            argv_display: [toLoopPortableText('pnpm'), toLoopPortableText('test')],
            argv_truncated: false,
            cwd_ref: '.',
            status: 'passed',
            exit_code: 0,
            duration_ms: 123,
          },
        ],
        summary: toLoopPortableText('All acceptance items passed.'),
        risks: [],
        risks_truncated: false,
        completed_at: '2026-08-09T00:02:00.000Z',
      },
      verification_result: 'pass',
      verification_report: 'verification.md',
    });

    expect(state.verification_result).toBe('pass');
    expect(() =>
      parseLoopPortableState({
        ...state,
        verification: { ...state.verification!, verifier_execution_ref: 'builder-1' },
      }),
    ).toThrow(/execution refs must differ/iu);

    expect(stringify(state)).not.toContain('hash');
  });
});
