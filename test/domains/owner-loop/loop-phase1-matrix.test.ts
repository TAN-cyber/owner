import { promises as fs } from 'fs';
import { execFileSync } from 'node:child_process';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  archiveLoopChange,
  recoverArchiveTransaction,
} from '../../../domains/owner-loop/loop-archive.js';
import {
  createLoopChange,
  loopChangeDir,
  readLoopChange,
  writeLoopChange,
} from '../../../domains/owner-loop/loop-change.js';
import { runLoopCli } from '../../../domains/owner-loop/loop-cli.js';
import { inspectLoopChangeConflicts } from '../../../domains/owner-loop/loop-conflict-inspection.js';
import { readProjectConfig } from '../../../domains/owner-loop/loop-config.js';
import { doctorLoopProject } from '../../../domains/owner-loop/loop-doctor.js';
import { sha256File } from '../../../domains/owner-loop/loop-hash.js';
import { loopProjectPaths } from '../../../domains/owner-loop/loop-paths.js';
import { moveLoopRoot, recoverLoopRootMove } from '../../../domains/owner-loop/loop-root-move.js';
import type { LoopProjectPaths, LoopSpecChange } from '../../../domains/owner-loop/loop-types.js';
import { loopVerificationFixtureReport } from '../../helpers/loop-verification.js';
import { readyLoopArchivePreflight } from '../../helpers/loop-archive.js';

const BRIEF = `# Outcome
Ship sentence counting.
# Scope
Add one CLI capability.
# Non-goals
No language detection.
# Acceptance examples
- Three terminated sentences return three.
# Constraints and invariants
Keep existing word counting compatible.
# Decisions
Use punctuation terminators.
# Open questions
None.
# Verification expectations
Run focused tests.
`;

interface JsonEnvelope {
  exitCode: number;
  data?: unknown;
  error?: { code: string; message: string };
}

function json(result: Awaited<ReturnType<typeof runLoopCli>>): JsonEnvelope {
  expect(result.stdout).toBeTruthy();
  return JSON.parse(result.stdout!) as JsonEnvelope;
}

async function initialize(projectRoot: string, artifactRoot = '.'): Promise<LoopProjectPaths> {
  const result = await runLoopCli(['init', '--root', artifactRoot, '--project-root', projectRoot]);
  expect(result.exitCode, result.stderr).toBe(0);
  return loopProjectPaths(projectRoot, artifactRoot);
}

async function prepareChange(options: {
  projectRoot: string;
  paths: LoopProjectPaths;
  name: string;
  specChange: LoopSpecChange;
  proposed: string;
  failVerificationFirst?: boolean;
}): Promise<void> {
  const rootArgs = ['--project-root', options.projectRoot] as const;
  await createLoopChange({
    paths: options.paths,
    name: options.name,
    language: 'en',
    verificationProtocol: 'legacy-v1',
  });
  const changeDir = loopChangeDir(options.paths, options.name);
  await fs.writeFile(path.join(changeDir, 'brief.md'), BRIEF);
  if (options.specChange.source) {
    const source = path.join(changeDir, options.specChange.source);
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, options.proposed);
  }
  await writeLoopChange(options.paths, {
    ...(await readLoopChange(options.paths, options.name)),
    spec_changes: [options.specChange],
  });

  expect(
    (
      await runLoopCli([
        'next',
        options.name,
        '--summary',
        'Requirements and complete target spec are ready',
        '--confirmed',
        ...rootArgs,
      ])
    ).exitCode,
  ).toBe(0);
  const implementation = `${options.name}.ts`;
  await fs.writeFile(
    path.join(options.projectRoot, implementation),
    'export const ready = true;\n',
  );
  expect(
    (
      await runLoopCli([
        'next',
        options.name,
        '--summary',
        'Implementation completed',
        '--artifact',
        implementation,
        ...rootArgs,
      ])
    ).exitCode,
  ).toBe(0);

  const report = path.join(changeDir, 'verification.md');
  if (options.failVerificationFirst) {
    await fs.writeFile(
      report,
      await loopVerificationFixtureReport({
        paths: options.paths,
        name: options.name,
        evidenceRefs: [implementation],
        conclusion: 'Fail',
      }),
    );
    const failed = await runLoopCli([
      'next',
      options.name,
      '--summary',
      'A focused test failed',
      '--result',
      'fail',
      '--report',
      'verification.md',
      ...rootArgs,
    ]);
    expect(failed.exitCode, failed.stderr).toBe(0);
    expect((await readLoopChange(options.paths, options.name)).phase).toBe('build');
    expect(
      (
        await runLoopCli([
          'next',
          options.name,
          '--summary',
          'Repaired the failed behavior',
          '--artifact',
          implementation,
          ...rootArgs,
        ])
      ).exitCode,
    ).toBe(0);
  }

  await fs.writeFile(
    report,
    await loopVerificationFixtureReport({
      paths: options.paths,
      name: options.name,
      evidenceRefs: [implementation],
    }),
  );
  const passed = await runLoopCli([
    'next',
    options.name,
    '--summary',
    'All focused verification passed',
    '--result',
    'pass',
    '--report',
    'verification.md',
    ...rootArgs,
  ]);
  expect(passed.exitCode, passed.stderr).toBe(0);
  expect((await readLoopChange(options.paths, options.name)).phase).toBe('archive');
}

describe('Owner Loop Phase 1 behavior matrix', () => {
  const projects: string[] = [];

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      projects.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  async function project(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-matrix-'));
    projects.push(root);
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    return root;
  }

  it('supports both project/owner and docs/owner without creating Pipeline trees', async () => {
    const defaultProject = await project();
    const docsProject = await project();

    expect((await initialize(defaultProject)).loopRoot).toBe(path.join(defaultProject, 'owner'));
    expect((await initialize(docsProject, 'docs')).loopRoot).toBe(
      path.join(docsProject, 'docs', 'owner'),
    );
    for (const root of [defaultProject, docsProject]) {
      await expect(fs.access(path.join(root, '.owner', 'config.yaml'))).resolves.toBeUndefined();
      await expect(fs.access(path.join(root, 'openspec'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
  });

  it.skip('returns Verify failure to Build and blocks concurrent overlapping changes at archive', async () => {
    const projectRoot = await project();
    const paths = await initialize(projectRoot, 'docs');
    const canonical = path.join(paths.specsDir, 'sentence-counting', 'spec.md');
    await fs.mkdir(path.dirname(canonical), { recursive: true });
    await fs.writeFile(canonical, '# Sentence counting\nOriginal behavior.\n');
    const baseHash = await sha256File(canonical);

    await prepareChange({
      projectRoot,
      paths,
      name: 'first-sentence-change',
      specChange: {
        capability: 'sentence-counting',
        operation: 'replace',
        source: 'specs/sentence-counting/spec.md',
        base_hash: baseHash,
      },
      proposed: '# Sentence counting\nFirst target behavior.\n',
      failVerificationFirst: true,
    });
    await prepareChange({
      projectRoot,
      paths,
      name: 'second-sentence-change',
      specChange: {
        capability: 'sentence-counting',
        operation: 'replace',
        source: 'specs/sentence-counting/spec.md',
        base_hash: baseHash,
      },
      proposed: '# Sentence counting\nSecond target behavior.\n',
    });
    await expect(inspectLoopChangeConflicts(paths, 'first-sentence-change')).resolves.toMatchObject(
      {
        definiteConflictCount: 1,
        findingCodes: ['loop-change-conflict'],
      },
    );
    const first = json(
      await runLoopCli([
        'archive',
        'first-sentence-change',
        '--dry-run',
        '--json',
        '--project-root',
        projectRoot,
      ]),
    );
    const second = json(
      await runLoopCli([
        'archive',
        'second-sentence-change',
        '--dry-run',
        '--json',
        '--project-root',
        projectRoot,
      ]),
    );
    expect(first).toMatchObject({
      exitCode: 0,
      data: {
        ready: false,
        findingCodes: expect.arrayContaining(['loop-change-conflict']),
      },
    });
    expect(second).toMatchObject({
      exitCode: 0,
      data: {
        ready: false,
        findingCodes: expect.arrayContaining(['loop-change-conflict']),
      },
    });
    const blockedCommit = json(
      await runLoopCli([
        'archive',
        'first-sentence-change',
        '--expect-preflight',
        (first.data as { preflightHash: string }).preflightHash,
        '--json',
        '--project-root',
        projectRoot,
      ]),
    );
    expect(blockedCommit).toMatchObject({ exitCode: 73, error: { code: 'conflict' } });
    expect(await fs.readFile(canonical, 'utf8')).toContain('Original behavior');
  }, 120_000);

  it.skip('continues and rolls back interrupted archive transactions deterministically', async () => {
    const projectRoot = await project();
    const paths = await initialize(projectRoot);

    await prepareChange({
      projectRoot,
      paths,
      name: 'continue-archive',
      specChange: {
        capability: 'continue-capability',
        operation: 'create',
        source: 'specs/continue-capability/spec.md',
        base_hash: null,
      },
      proposed: '# Continue capability\nTarget behavior.\n',
    });
    let continueTransaction = '';
    const continueNow = new Date();
    const continuePreflightHash = await readyLoopArchivePreflight({
      paths,
      name: 'continue-archive',
      now: continueNow,
    });
    await expect(
      archiveLoopChange({
        paths,
        name: 'continue-archive',
        expectedPreflightHash: continuePreflightHash,
        now: continueNow,
        hooks: {
          afterPrepared(journal) {
            continueTransaction = journal.id;
          },
          afterOperation(_operation, completed) {
            if (completed === 1) throw new Error('interrupt continue archive');
          },
        },
      }),
    ).rejects.toThrow('interrupt continue archive');
    expect(
      (
        await recoverArchiveTransaction({
          paths,
          transactionId: continueTransaction,
          strategy: 'continue',
        })
      ).status,
    ).toBe('committed');

    await prepareChange({
      projectRoot,
      paths,
      name: 'rollback-archive',
      specChange: {
        capability: 'rollback-capability',
        operation: 'create',
        source: 'specs/rollback-capability/spec.md',
        base_hash: null,
      },
      proposed: '# Rollback capability\nTarget behavior.\n',
    });
    let rollbackTransaction = '';
    const rollbackNow = new Date();
    const rollbackPreflightHash = await readyLoopArchivePreflight({
      paths,
      name: 'rollback-archive',
      now: rollbackNow,
    });
    await expect(
      archiveLoopChange({
        paths,
        name: 'rollback-archive',
        expectedPreflightHash: rollbackPreflightHash,
        now: rollbackNow,
        hooks: {
          afterPrepared(journal) {
            rollbackTransaction = journal.id;
          },
          afterOperation(_operation, completed) {
            if (completed === 1) throw new Error('interrupt rollback archive');
          },
        },
      }),
    ).rejects.toThrow('interrupt rollback archive');
    expect(
      (
        await recoverArchiveTransaction({
          paths,
          transactionId: rollbackTransaction,
          strategy: 'rollback',
        })
      ).status,
    ).toBe('rolled-back');
    expect((await readLoopChange(paths, 'rollback-archive')).phase).toBe('archive');
    await expect(
      fs.access(path.join(paths.specsDir, 'rollback-capability', 'spec.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  }, 120_000);

  it('continues and rolls back interrupted artifact-root moves from pending config', async () => {
    const projectRoot = await project();
    const paths = await initialize(projectRoot);
    await fs.mkdir(path.join(paths.specsDir, 'example'), { recursive: true });
    await fs.writeFile(path.join(paths.specsDir, 'example', 'spec.md'), 'example\n');

    await expect(
      moveLoopRoot({
        projectRoot,
        toArtifactRoot: 'docs',
        hooks: {
          afterRootMoveStage(stage) {
            if (stage === 'ready') throw new Error('interrupt root continue');
          },
        },
      }),
    ).rejects.toThrow('interrupt root continue');
    expect((await readProjectConfig(projectRoot))?.loop.pending_root_move?.stage).toBe('ready');
    expect(
      (await recoverLoopRootMove({ projectRoot, strategy: 'continue' })).config.loop.artifact_root,
    ).toBe('docs');

    await expect(
      moveLoopRoot({
        projectRoot,
        toArtifactRoot: 'artifacts',
        hooks: {
          afterRootMoveStage(stage) {
            if (stage === 'ready') throw new Error('interrupt root rollback');
          },
        },
      }),
    ).rejects.toThrow('interrupt root rollback');
    expect(
      (await recoverLoopRootMove({ projectRoot, strategy: 'rollback' })).config.loop.artifact_root,
    ).toBe('docs');
    expect(
      await fs.readFile(
        path.join(projectRoot, 'docs', 'owner', 'specs', 'example', 'spec.md'),
        'utf8',
      ),
    ).toBe('example\n');
  });

  it('fails closed for malformed config/state and never scans an openspec fixture', async () => {
    const projectRoot = await project();
    const paths = await initialize(projectRoot);
    await fs.mkdir(path.join(projectRoot, 'openspec', 'changes', 'should-not-read'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(projectRoot, 'openspec', 'changes', 'should-not-read', 'secret.md'),
      'not Loop state\n',
    );
    await createLoopChange({
      paths,
      name: 'malformed-state',
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });
    await fs.writeFile(
      path.join(loopChangeDir(paths, 'malformed-state'), 'owner-state.yaml'),
      'schema: owner.loop.v1\nphase: [broken\n',
    );

    const observed: string[] = [];
    for (const method of ['readFile', 'readdir', 'access', 'realpath', 'lstat', 'stat'] as const) {
      const original = fs[method].bind(fs) as (...args: unknown[]) => unknown;
      vi.spyOn(fs, method).mockImplementation(((...args: unknown[]) => {
        if (typeof args[0] === 'string') observed.push(path.resolve(args[0]));
        return original(...args);
      }) as never);
    }
    const status = json(
      await runLoopCli(['status', 'malformed-state', '--json', '--project-root', projectRoot]),
    );
    expect(status).toMatchObject({ exitCode: 0, data: { phase: 'invalid' } });
    expect(
      (
        await runLoopCli([
          'next',
          'malformed-state',
          '--summary',
          'must fail closed',
          '--project-root',
          projectRoot,
        ])
      ).exitCode,
    ).toBe(65);
    expect((await doctorLoopProject({ paths })).healthy).toBe(false);
    expect(observed.some((target) => target.includes(`${path.sep}openspec${path.sep}`))).toBe(
      false,
    );
    vi.restoreAllMocks();

    await fs.mkdir(path.join(projectRoot, '.owner'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, '.owner', 'config.yaml'), 'loop: [broken\n');
    const configResult = await runLoopCli(['status', '--json', '--project-root', projectRoot]);
    expect(configResult.exitCode).toBe(65);
    expect(json(configResult).error?.code).toBe('invalid-data');
  });
});
