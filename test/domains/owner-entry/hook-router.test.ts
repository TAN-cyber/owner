import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { writeOwnerCurrentSelection } from '../../../domains/owner-entry/current-selection.js';
import {
  inspectOwnerHook,
  resolveHookWorkflowOwner,
} from '../../../domains/owner-entry/hook-router.js';
import {
  defaultProjectConfig,
  writeProjectConfig,
} from '../../../domains/owner-loop/loop-config.js';

describe('Owner Hook Router', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-hook-router-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function configureBoth(): Promise<void> {
    const config = defaultProjectConfig('.');
    config.workflows = ['loop', 'pipeline'];
    await writeProjectConfig(root, config);
  }

  it('stays neutral for an unknown write target without reading Owner state', async () => {
    const listLoop = vi.fn(async () => {
      throw new Error('Loop state must not be read');
    });
    const listPipeline = vi.fn(async () => {
      throw new Error('Pipeline state must not be read');
    });
    const inspectLoop = vi.fn();
    const inspectPipeline = vi.fn();

    const decision = await inspectOwnerHook(
      root,
      { intent: 'unknown', targets: [], toolName: 'FutureWriteTool' },
      { listLoop, listPipeline, inspectLoop, inspectPipeline },
    );

    expect(decision).toMatchObject({ allowed: true });
    expect(listLoop).not.toHaveBeenCalled();
    expect(listPipeline).not.toHaveBeenCalled();
    expect(inspectLoop).not.toHaveBeenCalled();
    expect(inspectPipeline).not.toHaveBeenCalled();
  });

  it('stays neutral for project-external targets without reading Owner state', async () => {
    const externalTarget = path.join(os.tmpdir(), `owner-memory-${path.basename(root)}.md`);
    const listLoop = vi.fn(async () => {
      throw new Error('Loop state must not be read');
    });
    const listPipeline = vi.fn(async () => {
      throw new Error('Pipeline state must not be read');
    });
    const inspectLoop = vi.fn();
    const inspectPipeline = vi.fn();

    const decision = await inspectOwnerHook(
      root,
      { intent: 'write', targets: [externalTarget], toolName: 'Write' },
      { listLoop, listPipeline, inspectLoop, inspectPipeline },
    );

    expect(decision).toMatchObject({ allowed: true });
    expect(listLoop).not.toHaveBeenCalled();
    expect(listPipeline).not.toHaveBeenCalled();
    expect(inspectLoop).not.toHaveBeenCalled();
    expect(inspectPipeline).not.toHaveBeenCalled();
  });

  it('fails closed when the scope of an explicit write target cannot be determined', async () => {
    const scopeTargets = vi.fn(async () => {
      throw new Error('project root is unreadable');
    });

    const decision = await inspectOwnerHook(
      root,
      { intent: 'write', targets: ['src/app.ts'], toolName: 'Write' },
      {
        listLoop: vi.fn(async () => []),
        listPipeline: vi.fn(async () => []),
        inspectLoop: vi.fn(),
        inspectPipeline: vi.fn(),
        scopeTargets,
      },
    );

    expect(decision).toMatchObject({ allowed: false });
    expect(decision.reason).toContain('scope could not be determined safely');
  });

  it('filters external targets before delegating a mixed write to the owning Guard', async () => {
    await configureBoth();
    await writeOwnerCurrentSelection(root, {
      schema: 'owner.selection.v2',
      workflow: 'loop',
      change: 'loop-change',
      branch: null,
    });
    const externalTarget = path.join(os.tmpdir(), `owner-memory-${path.basename(root)}.md`);
    const inspectLoop = vi.fn(async () => ({ allowed: true, reason: 'loop' }));
    const inspectPipeline = vi.fn(async () => ({ allowed: true, reason: 'pipeline' }));

    const decision = await inspectOwnerHook(
      root,
      {
        intent: 'write',
        targets: [externalTarget, 'src/app.ts'],
        toolName: 'Edit',
      },
      {
        listLoop: async () => [{ workflow: 'loop', name: 'loop-change', phase: 'build' as const }],
        listPipeline: async () => [],
        inspectLoop,
        inspectPipeline,
      },
    );

    expect(decision).toEqual({ allowed: true, reason: 'loop' });
    expect(inspectLoop).toHaveBeenCalledWith(
      root,
      { intent: 'write', targets: ['src/app.ts'], toolName: 'Edit' },
      'loop-change',
    );
    expect(inspectPipeline).not.toHaveBeenCalled();
  });

  it('routes one event to only the selected Loop Guard', async () => {
    await configureBoth();
    await writeOwnerCurrentSelection(root, {
      schema: 'owner.selection.v2',
      workflow: 'loop',
      change: 'loop-change',
      branch: null,
    });
    const inspectLoop = vi.fn(async () => ({ allowed: true, reason: 'loop' }));
    const inspectPipeline = vi.fn(async () => ({ allowed: true, reason: 'pipeline' }));

    const decision = await inspectOwnerHook(
      root,
      { intent: 'write', targets: ['src/app.ts'], toolName: 'Write' },
      {
        listLoop: async () => [{ workflow: 'loop', name: 'loop-change', phase: 'build' as const }],
        listPipeline: async () => [
          { workflow: 'pipeline', name: 'pipeline-change', phase: 'design' as const },
        ],
        inspectLoop,
        inspectPipeline,
      },
    );

    expect(decision).toEqual({ allowed: true, reason: 'loop' });
    expect(inspectLoop).toHaveBeenCalledOnce();
    expect(inspectPipeline).not.toHaveBeenCalled();
  });

  it('does not enumerate Pipeline state when Loop owns the current selection', async () => {
    await configureBoth();
    await writeOwnerCurrentSelection(root, {
      schema: 'owner.selection.v2',
      workflow: 'loop',
      change: 'loop-change',
      branch: null,
    });
    const listPipeline = vi.fn(async () => {
      throw new Error('unrelated Pipeline state is unreadable');
    });

    await expect(
      resolveHookWorkflowOwner(root, {
        listLoop: async () => [{ workflow: 'loop', name: 'loop-change', phase: 'build' as const }],
        listPipeline,
      }),
    ).resolves.toEqual({
      status: 'owned',
      owner: { workflow: 'loop', name: 'loop-change', phase: 'build' },
    });
    expect(listPipeline).not.toHaveBeenCalled();
  });

  it('ignores the standalone root when default owner enumeration checks Pipeline', async () => {
    await configureBoth();
    await fs.mkdir(path.join(root, 'openspec', 'changes', 'legacy'), { recursive: true });
    await fs.mkdir(path.join(root, 'docs', 'openspec', 'changes', 'docs'), { recursive: true });

    const resolution = await resolveHookWorkflowOwner(root);

    expect(resolution).toEqual({ status: 'none' });
  });

  it('routes one event to only the selected Pipeline Guard', async () => {
    await configureBoth();
    const changeDir = path.join(root, 'openspec', 'changes', 'pipeline-change');
    await fs.mkdir(changeDir, { recursive: true });
    await fs.writeFile(
      path.join(changeDir, '.owner.yaml'),
      [
        'workflow: full',
        'phase: build',
        'design_doc: docs/superpowers/specs/design.md',
        'plan: null',
        'build_mode: executing-plans',
        'isolation: branch',
        'verify_mode: null',
        'verify_result: pending',
        'verified_at: null',
        'archived: false',
        '',
      ].join('\n'),
    );
    await writeOwnerCurrentSelection(root, {
      schema: 'owner.selection.v2',
      workflow: 'pipeline',
      change: 'pipeline-change',
      branch: null,
    });
    const inspectLoop = vi.fn(async () => ({ allowed: true, reason: 'loop' }));
    const inspectPipeline = vi.fn(async () => ({ allowed: true, reason: 'pipeline' }));

    const decision = await inspectOwnerHook(
      root,
      { intent: 'write', targets: ['src/app.ts'], toolName: 'Edit' },
      {
        listLoop: async () => [{ workflow: 'loop', name: 'loop-change', phase: 'shape' as const }],
        listPipeline: async () => [
          { workflow: 'pipeline', name: 'pipeline-change', phase: 'build' as const },
        ],
        inspectLoop,
        inspectPipeline,
      },
    );

    expect(decision).toEqual({ allowed: true, reason: 'pipeline' });
    expect(inspectPipeline).toHaveBeenCalledOnce();
    expect(inspectLoop).not.toHaveBeenCalled();
  });

  it('does not enumerate Loop state when Pipeline owns the current selection', async () => {
    await configureBoth();
    const changeDir = path.join(root, 'openspec', 'changes', 'pipeline-change');
    await fs.mkdir(changeDir, { recursive: true });
    await fs.writeFile(
      path.join(changeDir, '.owner.yaml'),
      [
        'workflow: full',
        'phase: build',
        'design_doc: docs/superpowers/specs/design.md',
        'plan: null',
        'build_mode: executing-plans',
        'isolation: branch',
        'verify_mode: null',
        'verify_result: pending',
        'verified_at: null',
        'archived: false',
        '',
      ].join('\n'),
    );
    await writeOwnerCurrentSelection(root, {
      schema: 'owner.selection.v2',
      workflow: 'pipeline',
      change: 'pipeline-change',
      branch: null,
    });
    const listLoop = vi.fn(async () => {
      throw new Error('unrelated Loop state is unreadable');
    });

    await expect(
      resolveHookWorkflowOwner(root, {
        listLoop,
        listPipeline: async () => [
          { workflow: 'pipeline', name: 'pipeline-change', phase: 'build' as const },
        ],
      }),
    ).resolves.toEqual({
      status: 'owned',
      owner: { workflow: 'pipeline', name: 'pipeline-change', phase: 'build' },
    });
    expect(listLoop).not.toHaveBeenCalled();
  });

  it('fails closed when multiple workflows have active changes without a selection', async () => {
    await configureBoth();

    await expect(
      inspectOwnerHook(
        root,
        { intent: 'write', targets: ['src/app.ts'], toolName: 'Write' },
        {
          listLoop: async () => [
            { workflow: 'loop', name: 'loop-change', phase: 'build' as const },
          ],
          listPipeline: async () => [
            { workflow: 'pipeline', name: 'pipeline-change', phase: 'build' as const },
          ],
          inspectLoop: vi.fn(),
          inspectPipeline: vi.fn(),
        },
      ),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining('Multiple active Owner changes'),
    });
  });

  it('fails closed when one workflow has multiple active changes without a selection', async () => {
    await configureBoth();
    const inspectLoop = vi.fn();
    const inspectPipeline = vi.fn();

    const decision = await inspectOwnerHook(
      root,
      { intent: 'write', targets: ['src/app.ts'], toolName: 'Write' },
      {
        listLoop: async () => [
          { workflow: 'loop', name: 'first', phase: 'build' as const },
          { workflow: 'loop', name: 'second', phase: 'build' as const },
        ],
        listPipeline: async () => [],
        inspectLoop,
        inspectPipeline,
      },
    );

    expect(decision).toMatchObject({ allowed: false, reason: expect.stringContaining('first') });
    expect(inspectLoop).not.toHaveBeenCalled();
    expect(inspectPipeline).not.toHaveBeenCalled();
  });

  it('allows ordinary development when a stale selection has no active replacement', async () => {
    await configureBoth();
    await writeOwnerCurrentSelection(root, {
      schema: 'owner.selection.v2',
      workflow: 'loop',
      change: 'missing-change',
      branch: null,
    });
    const inspectLoop = vi.fn();
    const inspectPipeline = vi.fn();

    const decision = await inspectOwnerHook(
      root,
      { intent: 'write', targets: ['src/app.ts'], toolName: 'Write' },
      {
        listLoop: async () => [],
        listPipeline: async () => [],
        inspectLoop,
        inspectPipeline,
      },
    );

    expect(decision).toEqual({ allowed: true, reason: 'No active Owner change' });
    expect(inspectLoop).not.toHaveBeenCalled();
    expect(inspectPipeline).not.toHaveBeenCalled();
  });

  it('classifies a stale selection with zero active changes as none', async () => {
    await configureBoth();
    await writeOwnerCurrentSelection(root, {
      schema: 'owner.selection.v2',
      workflow: 'loop',
      change: 'missing-change',
      branch: null,
    });

    await expect(
      resolveHookWorkflowOwner(root, {
        listLoop: async () => [],
        listPipeline: async () => [],
      }),
    ).resolves.toEqual({
      status: 'none',
      staleSelection: {
        code: 'target-missing',
        reason: "selected loop change 'missing-change' is missing or archived",
      },
    });
  });

  it('infers the sole active change after ignoring a stale selection', async () => {
    await configureBoth();
    await writeOwnerCurrentSelection(root, {
      schema: 'owner.selection.v2',
      workflow: 'loop',
      change: 'missing-change',
      branch: null,
    });

    await expect(
      resolveHookWorkflowOwner(root, {
        listLoop: async () => [{ workflow: 'loop', name: 'only-active', phase: 'build' as const }],
        listPipeline: async () => [],
      }),
    ).resolves.toEqual({
      status: 'inferred',
      owner: { workflow: 'loop', name: 'only-active', phase: 'build' },
      staleSelection: {
        code: 'target-missing',
        reason: "selected loop change 'missing-change' is missing or archived",
      },
    });
  });

  it('requires selection when a stale selection leaves multiple active changes', async () => {
    await configureBoth();
    await writeOwnerCurrentSelection(root, {
      schema: 'owner.selection.v2',
      workflow: 'loop',
      change: 'missing-change',
      branch: null,
    });

    await expect(
      resolveHookWorkflowOwner(root, {
        listLoop: async () => [{ workflow: 'loop', name: 'first', phase: 'build' as const }],
        listPipeline: async () => [
          { workflow: 'pipeline', name: 'second', phase: 'build' as const },
        ],
      }),
    ).resolves.toEqual({
      status: 'ambiguous',
      candidates: [
        { workflow: 'loop', name: 'first', phase: 'build' },
        { workflow: 'pipeline', name: 'second', phase: 'build' },
      ],
      staleSelection: {
        code: 'target-missing',
        reason: "selected loop change 'missing-change' is missing or archived",
      },
    });
  });

  it('classifies unreadable change state without throwing from Doctor callers', async () => {
    await configureBoth();

    await expect(
      resolveHookWorkflowOwner(root, {
        listLoop: async () => {
          throw new Error('invalid owner-state.yaml');
        },
        listPipeline: async () => [],
      }),
    ).resolves.toEqual({
      status: 'stale',
      code: 'change-state-unreadable',
      reason: 'cannot safely enumerate active Owner changes: invalid owner-state.yaml',
    });
  });

  it('allows ordinary development when no Owner change is active', async () => {
    await configureBoth();
    const inspectLoop = vi.fn();
    const inspectPipeline = vi.fn();

    await expect(
      inspectOwnerHook(
        root,
        { intent: 'write', targets: ['src/app.ts'], toolName: 'Write' },
        {
          listLoop: async () => [],
          listPipeline: async () => [],
          inspectLoop,
          inspectPipeline,
        },
      ),
    ).resolves.toEqual({ allowed: true, reason: 'No active Owner change' });
    expect(inspectLoop).not.toHaveBeenCalled();
    expect(inspectPipeline).not.toHaveBeenCalled();
  });

  it('allows ordinary development when configured workflow roots have not been created', async () => {
    await configureBoth();

    await expect(
      inspectOwnerHook(root, {
        intent: 'write',
        targets: ['src/app.ts'],
        toolName: 'Write',
      }),
    ).resolves.toEqual({ allowed: true, reason: 'No active Owner change' });
  });

  it('infers the only active change without writing selection', async () => {
    await configureBoth();
    const resolution = await resolveHookWorkflowOwner(root, {
      listLoop: async () => [{ workflow: 'loop', name: 'only-change', phase: 'verify' as const }],
      listPipeline: async () => [],
    });

    expect(resolution).toEqual({
      status: 'inferred',
      owner: { workflow: 'loop', name: 'only-change', phase: 'verify' },
    });
    await expect(fs.access(path.join(root, '.owner', 'current-change.json'))).rejects.toMatchObject(
      {
        code: 'ENOENT',
      },
    );
  });

  it('treats no-config projects as Pipeline-only legacy projects', async () => {
    const resolution = await resolveHookWorkflowOwner(root, {
      listLoop: vi.fn(async () => [
        { workflow: 'loop', name: 'ignored-loop', phase: 'build' as const },
      ]),
      listPipeline: async () => [
        { workflow: 'pipeline', name: 'legacy-pipeline', phase: 'open' as const },
      ],
    });

    expect(resolution).toEqual({
      status: 'inferred',
      owner: { workflow: 'pipeline', name: 'legacy-pipeline', phase: 'open' },
    });
  });
});
