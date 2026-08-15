import { promises as fs } from 'fs';
import { spawnSync } from 'child_process';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { inspectOwnerProjectStatus } from '../../../domains/owner-entry/project-status.js';
import { createLoopChange, loopChangeDir } from '../../../domains/owner-loop/loop-change.js';
import {
  defaultProjectConfig,
  writeProjectConfig,
} from '../../../domains/owner-loop/loop-config.js';
import { loopProjectPaths } from '../../../domains/owner-loop/loop-paths.js';

const VALID_BRIEF = `# Outcome
Ship one outcome.
# Scope
One capability.
# Non-goals
No migration.
# Acceptance examples
- The behavior works.
# Constraints and invariants
Keep workflows separate.
# Decisions
Use Loop state.
# Open questions
None.
# Verification expectations
Run focused checks.
`;

const pipelineStateScript = path.resolve('assets', 'skills', 'owner', 'scripts', 'owner-state.mjs');

function bothProjectConfig(loopRoot: string) {
  const config = defaultProjectConfig(loopRoot);
  config.workflows = ['loop', 'pipeline'];
  config.pipeline = { artifact_layout: 'legacy', language: 'en' };
  return config;
}

async function writePipelineOnlyConfig(projectRoot: string): Promise<void> {
  await fs.mkdir(path.join(projectRoot, '.owner'), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, '.owner', 'config.yaml'),
    [
      'schema: owner.project.v1',
      'default_workflow: pipeline',
      'workflows: [pipeline]',
      'pipeline:',
      '  artifact_layout: legacy',
      '  language: en',
      '',
    ].join('\n'),
    'utf8',
  );
}

async function initializePipelineChange(projectRoot: string, name: string): Promise<void> {
  await fs.mkdir(path.join(projectRoot, 'openspec'), { recursive: true });
  const result = spawnSync(process.execPath, [pipelineStateScript, 'init', name, 'full'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
}

async function snapshotTree(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replaceAll('\\', '/');
      if (entry.isDirectory()) {
        snapshot[`${relative}/`] = 'directory';
        await visit(absolute);
      } else {
        snapshot[relative] = (await fs.readFile(absolute)).toString('base64');
      }
    }
  }
  await visit(root);
  return snapshot;
}

describe('Owner project status', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-project-status-'));
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('partitions configured Loop changes under a versioned status contract', async () => {
    await writeProjectConfig(projectRoot, defaultProjectConfig('.'));
    const paths = await loopProjectPaths(projectRoot, '.');
    const state = await createLoopChange({ paths, name: 'loop-only', language: 'en' });
    await fs.writeFile(path.join(loopChangeDir(paths, state.name), state.brief), VALID_BRIEF);

    const status = await inspectOwnerProjectStatus(projectRoot);
    expect(status).toMatchObject({
      schema: 'owner.status.v2',
      defaultEntry: {
        workflow: 'loop',
        skill: 'owner-loop',
        source: 'project-config',
      },
      workflows: {
        loop: {
          changes: [
            {
              name: 'loop-only',
              phase: 'shape',
              nextCommand: 'owner loop next loop-only --summary "<summary>" --confirmed',
            },
          ],
        },
        pipeline: { changes: [] },
      },
      unmanagedOpenSpec: [],
    });
    expect(status.workflows.pipeline).toEqual({ changes: [] });
    expect(status.workflows.pipeline.error).toBeUndefined();

    await writeProjectConfig(projectRoot, {
      ...defaultProjectConfig('.'),
      loop: {
        ...defaultProjectConfig('.').loop,
        clarification_mode: 'batch',
      },
    });
    await expect(inspectOwnerProjectStatus(projectRoot)).resolves.toMatchObject({
      workflows: {
        loop: {
          changes: [
            {
              name: 'loop-only',
              phase: 'shape',
              nextCommand: 'owner loop next loop-only --summary "<summary>" --confirmed',
            },
          ],
        },
      },
    });
  });

  it('keeps plain OpenSpec changes outside both Owner workflows', async () => {
    await writePipelineOnlyConfig(projectRoot);
    const changeDir = path.join(projectRoot, 'openspec', 'changes', 'plain-change');
    await fs.mkdir(changeDir, { recursive: true });
    await fs.writeFile(path.join(changeDir, 'tasks.md'), '- [x] done\n');

    const status = await inspectOwnerProjectStatus(projectRoot);

    expect(status.defaultEntry).toEqual({
      workflow: 'pipeline',
      skill: 'owner-pipeline',
      source: 'project-config',
    });
    expect(status.workflows.loop.changes).toEqual([]);
    expect(status.workflows.pipeline.changes).toEqual([]);
    expect(status.unmanagedOpenSpec).toEqual([
      expect.objectContaining({
        name: 'plain-change',
        ownerManaged: false,
        archiveReady: true,
        recommendedArchiveCommand: 'owner pipeline openspec -- archive plain-change -y',
        tasksCompleted: 1,
        tasksTotal: 1,
      }),
    ]);
  });

  it('fails closed for a valid Pipeline change name backed by a directory link', async () => {
    await writePipelineOnlyConfig(projectRoot);
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-project-status-outside-'));
    try {
      await fs.writeFile(path.join(outsideRoot, 'tasks.md'), '- [x] outside task\n', 'utf8');
      await fs.mkdir(path.join(projectRoot, 'openspec', 'changes'), { recursive: true });
      await fs.symlink(
        outsideRoot,
        path.join(projectRoot, 'openspec', 'changes', 'unsafe-change'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );

      const status = await inspectOwnerProjectStatus(projectRoot);

      expect(status.unmanagedOpenSpec).toEqual([]);
      expect(status.workflows.pipeline.changes).toEqual([
        expect.objectContaining({
          name: 'unsafe-change',
          phase: 'invalid',
          tasksCompleted: 0,
          tasksTotal: 0,
          error: expect.stringMatching(/symbolic link or junction/iu),
        }),
      ]);
    } finally {
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it('fails closed when a Pipeline runtime directory is a directory link', async () => {
    await writePipelineOnlyConfig(projectRoot);
    await initializePipelineChange(projectRoot, 'unsafe-runtime');
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-project-runtime-outside-'));
    try {
      await fs.symlink(
        outsideRoot,
        path.join(projectRoot, 'openspec', 'changes', 'unsafe-runtime', '.owner'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );

      const status = await inspectOwnerProjectStatus(projectRoot);

      expect(status.workflows.pipeline.changes).toEqual([
        expect.objectContaining({
          name: 'unsafe-runtime',
          phase: 'invalid',
          error: expect.stringMatching(/symbolic link or junction/iu),
        }),
      ]);
    } finally {
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it('reports configured Pipeline as unavailable when its root is missing', async () => {
    await writePipelineOnlyConfig(projectRoot);

    const status = await inspectOwnerProjectStatus(projectRoot);

    expect(status.workflows.pipeline).toEqual({
      changes: [],
      error: expect.stringContaining('Configured Pipeline OpenSpec root is missing'),
    });
    expect(status.unmanagedOpenSpec).toEqual([]);
  });

  it('reports Pipeline-managed changes only in the Pipeline workflow', async () => {
    await writePipelineOnlyConfig(projectRoot);
    await initializePipelineChange(projectRoot, 'pipeline-only');

    const status = await inspectOwnerProjectStatus(projectRoot);

    expect(status.workflows.loop.changes).toEqual([]);
    expect(status.workflows.pipeline.changes).toEqual([
      expect.objectContaining({
        name: 'pipeline-only',
        ownerManaged: true,
        workflow: 'full',
        phase: 'open',
        recommendedArchiveCommand: 'owner archive pipeline-only',
      }),
    ]);
    expect(status.unmanagedOpenSpec).toEqual([]);
  });

  it('reports Pipeline unavailable without guessing a legacy root when project config is malformed', async () => {
    await writePipelineOnlyConfig(projectRoot);
    await initializePipelineChange(projectRoot, 'pipeline-survives');
    const unmanagedDir = path.join(projectRoot, 'openspec', 'changes', 'plain-survives');
    await fs.mkdir(unmanagedDir, { recursive: true });
    await fs.writeFile(path.join(unmanagedDir, 'tasks.md'), '- [ ] todo\n');
    await fs.mkdir(path.join(projectRoot, '.owner'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, '.owner', 'config.yaml'), 'schema: [broken\n');

    const status = await inspectOwnerProjectStatus(projectRoot);

    expect(status.defaultEntry).toEqual({ error: expect.stringContaining('Invalid') });
    expect(status.workflows.loop).toEqual({
      changes: [],
      error: expect.stringContaining('Invalid'),
    });
    expect(status.workflows.pipeline).toEqual({
      changes: [],
      error: expect.stringContaining('Invalid'),
    });
    expect(status.unmanagedOpenSpec).toEqual([]);
  });

  it('reports only the configured Pipeline root when a standalone root coexists', async () => {
    const config = defaultProjectConfig('docs');
    config.default_workflow = 'pipeline';
    config.workflows = ['pipeline'];
    config.pipeline = { artifact_layout: 'docs' };
    await writeProjectConfig(projectRoot, config);
    await fs.mkdir(path.join(projectRoot, 'openspec', 'changes', 'legacy'), { recursive: true });
    await fs.mkdir(path.join(projectRoot, 'docs', 'openspec', 'changes', 'configured'), {
      recursive: true,
    });

    const status = await inspectOwnerProjectStatus(projectRoot);

    expect(status.workflows.pipeline).toEqual({ changes: [] });
    expect(status.unmanagedOpenSpec).toEqual([
      expect.objectContaining({ name: 'configured', ownerManaged: false }),
    ]);
  });

  it.each(['changes-root', 'change-dir'] as const)(
    'does not inspect project-external Pipeline state through a %s junction',
    async (kind) => {
      await writePipelineOnlyConfig(projectRoot);
      const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-status-outside-'));
      try {
        await fs.writeFile(
          path.join(outsideRoot, '.owner.yaml'),
          'workflow: TOP_SECRET\nphase: build\n',
          'utf8',
        );
        await fs.writeFile(path.join(outsideRoot, 'tasks.md'), '- [ ] external secret\n', 'utf8');
        const changesRoot = path.join(projectRoot, 'openspec', 'changes');
        const target =
          kind === 'changes-root' ? changesRoot : path.join(changesRoot, 'external-change');
        await fs.mkdir(path.dirname(target), { recursive: true });
        try {
          await fs.symlink(outsideRoot, target, process.platform === 'win32' ? 'junction' : 'dir');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
          throw error;
        }

        const status = await inspectOwnerProjectStatus(projectRoot);

        if (kind === 'changes-root') {
          expect(status.workflows.pipeline.changes).toEqual([]);
          expect(status.workflows.pipeline.error).toMatch(/symbolic link or junction/iu);
        } else {
          expect(status.workflows.pipeline.error).toBeUndefined();
          expect(status.workflows.pipeline.changes).toEqual([
            expect.objectContaining({
              name: 'external-change',
              phase: 'invalid',
              error: expect.stringMatching(/symbolic link or junction/iu),
            }),
          ]);
        }
        expect(status.unmanagedOpenSpec).toEqual([]);
        expect(JSON.stringify(status)).not.toContain('TOP_SECRET');
        expect(JSON.stringify(status)).not.toContain('external secret');
      } finally {
        await fs.rm(outsideRoot, { recursive: true, force: true });
      }
    },
  );

  it('ignores unrelated invalid names but fails closed for a legal-name non-directory', async () => {
    await writePipelineOnlyConfig(projectRoot);
    const changesRoot = path.join(projectRoot, 'openspec', 'changes');
    await fs.mkdir(changesRoot, { recursive: true });
    await fs.writeFile(path.join(changesRoot, 'README.md'), 'ignore\n', 'utf8');
    await fs.writeFile(path.join(changesRoot, 'legal-name'), 'not a change directory\n', 'utf8');

    const status = await inspectOwnerProjectStatus(projectRoot);

    expect(status.workflows.pipeline.error).toBeUndefined();
    expect(status.workflows.pipeline.changes).toEqual([
      expect.objectContaining({
        name: 'legal-name',
        phase: 'invalid',
        error: expect.stringMatching(/must be a real directory/iu),
      }),
    ]);
    expect(status.unmanagedOpenSpec).toEqual([]);
  });

  it('keeps same-name Loop and Pipeline changes separate under a custom artifact root', async () => {
    await writeProjectConfig(projectRoot, bothProjectConfig('docs'));
    const paths = await loopProjectPaths(projectRoot, 'docs');
    const loop = await createLoopChange({ paths, name: 'shared-name', language: 'en' });
    await fs.writeFile(path.join(loopChangeDir(paths, loop.name), loop.brief), VALID_BRIEF);
    await initializePipelineChange(projectRoot, 'shared-name');
    const unmanagedDir = path.join(projectRoot, 'openspec', 'changes', 'plain-change');
    await fs.mkdir(unmanagedDir, { recursive: true });

    const status = await inspectOwnerProjectStatus(projectRoot);

    expect(status.workflows.loop.changes.map((change) => change.name)).toEqual(['shared-name']);
    expect(status.workflows.pipeline.changes.map((change) => change.name)).toEqual(['shared-name']);
    expect(status.unmanagedOpenSpec.map((change) => change.name)).toEqual(['plain-change']);
  });

  it('reports an incomplete Loop artifact-root move instead of projecting stale changes', async () => {
    await writeProjectConfig(projectRoot, defaultProjectConfig('.'));
    const paths = await loopProjectPaths(projectRoot, '.');
    const loop = await createLoopChange({ paths, name: 'stale-change', language: 'en' });
    await fs.writeFile(path.join(loopChangeDir(paths, loop.name), loop.brief), VALID_BRIEF);
    const config = defaultProjectConfig('.');
    config.loop.pending_root_move = {
      id: 'deadbeef-0001',
      fromArtifactRoot: '.',
      toArtifactRoot: 'docs',
      stage: 'copying',
    };
    await writeProjectConfig(projectRoot, config);

    const status = await inspectOwnerProjectStatus(projectRoot);

    expect(status.defaultEntry).toMatchObject({ workflow: 'loop' });
    expect(status.workflows.loop).toEqual({
      changes: [],
      error: expect.stringContaining('owner loop doctor --repair'),
    });
  });

  it('discovers the configured project from a nested working directory', async () => {
    await writeProjectConfig(projectRoot, bothProjectConfig('docs'));
    const paths = await loopProjectPaths(projectRoot, 'docs');
    const loop = await createLoopChange({ paths, name: 'nested-loop', language: 'en' });
    await fs.writeFile(path.join(loopChangeDir(paths, loop.name), loop.brief), VALID_BRIEF);
    await initializePipelineChange(projectRoot, 'nested-pipeline');
    const nested = path.join(projectRoot, 'src', 'feature');
    await fs.mkdir(nested, { recursive: true });

    const status = await inspectOwnerProjectStatus(nested);

    expect(status.defaultEntry).toMatchObject({ workflow: 'loop' });
    expect(status.workflows.loop.changes.map((change) => change.name)).toEqual(['nested-loop']);
    expect(status.workflows.pipeline.changes.map((change) => change.name)).toEqual([
      'nested-pipeline',
    ]);
  });

  it('does not let corrupt changes on either workflow hide healthy changes', async () => {
    await writeProjectConfig(projectRoot, bothProjectConfig('.'));
    const paths = await loopProjectPaths(projectRoot, '.');
    const healthyLoop = await createLoopChange({
      paths,
      name: 'loop-healthy',
      language: 'en',
    });
    await fs.writeFile(
      path.join(loopChangeDir(paths, healthyLoop.name), healthyLoop.brief),
      VALID_BRIEF,
    );
    const brokenLoopDir = path.join(paths.changesDir, 'loop-broken');
    await fs.mkdir(brokenLoopDir, { recursive: true });
    await fs.writeFile(path.join(brokenLoopDir, 'owner-state.yaml'), 'schema: [broken\n');

    await initializePipelineChange(projectRoot, 'pipeline-healthy');
    await initializePipelineChange(projectRoot, 'pipeline-broken');
    await fs.appendFile(
      path.join(projectRoot, 'openspec', 'changes', 'pipeline-broken', '.owner.yaml'),
      'unknown_field: true\n',
    );

    const status = await inspectOwnerProjectStatus(projectRoot);

    expect(status.workflows.loop.changes).toEqual([
      expect.objectContaining({
        name: 'loop-broken',
        phase: 'invalid',
        error: expect.any(String),
      }),
      expect.objectContaining({ name: 'loop-healthy', phase: 'shape' }),
    ]);
    expect(status.workflows.pipeline.changes).toEqual([
      expect.objectContaining({
        name: 'pipeline-broken',
        phase: 'invalid',
        error: expect.any(String),
      }),
      expect.objectContaining({ name: 'pipeline-healthy', phase: 'open' }),
    ]);
  });

  it('reads mixed Loop, Pipeline, and OpenSpec status without changing project files', async () => {
    await writeProjectConfig(projectRoot, bothProjectConfig('docs'));
    const paths = await loopProjectPaths(projectRoot, 'docs');
    const loop = await createLoopChange({ paths, name: 'loop-readonly', language: 'en' });
    await fs.writeFile(path.join(loopChangeDir(paths, loop.name), loop.brief), VALID_BRIEF);
    await initializePipelineChange(projectRoot, 'pipeline-readonly');
    const pipelineState = path.join(
      projectRoot,
      'openspec',
      'changes',
      'pipeline-readonly',
      '.owner.yaml',
    );
    await fs.appendFile(pipelineState, 'build_command: pnpm build\n');
    await fs.mkdir(path.join(projectRoot, 'openspec', 'changes', 'plain-readonly'));
    const before = await snapshotTree(projectRoot);

    await inspectOwnerProjectStatus(projectRoot);

    expect(await snapshotTree(projectRoot)).toEqual(before);
  });
});
