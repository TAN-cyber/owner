import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { createLoopChange, writeLoopChange } from '../../../domains/owner-loop/loop-change.js';
import {
  inspectLoopHookGuard,
  parseLoopHookRequest,
  type LoopHookRequest,
} from '../../../domains/owner-loop/loop-hook-guard.js';
import { runLoopCli } from '../../../domains/owner-loop/loop-cli.js';
import {
  defaultProjectConfig,
  writeProjectConfig,
} from '../../../domains/owner-loop/loop-config.js';
import { ensureLoopDirectories, loopProjectPaths } from '../../../domains/owner-loop/loop-paths.js';
import { selectLoopChange } from '../../../domains/owner-loop/loop-selection.js';
import {
  confirmLoopPortableShape,
  createLoopPortableChange,
  loopPortableChangeDir,
  readLoopPortableChange,
  submitLoopPortableBuilderCandidate,
} from '../../../domains/owner-loop/loop-portable-runtime.js';
import { createLoopRunnerChannel } from '../../../domains/owner-loop/loop-runner-protocol.js';

describe('Loop phase Hook guard', () => {
  let projectRoot: string;

  const writeRequest = (...targets: string[]): LoopHookRequest => ({
    intent: targets.length > 0 ? 'write' : 'unknown',
    targets,
  });

  const nonWriteRequest = (): LoopHookRequest => ({ intent: 'non-write', targets: [] });

  async function addHookAllowPath(relativePath: string): Promise<void> {
    await fs.appendFile(
      path.join(projectRoot, '.owner', 'config.yaml'),
      `hook:\n  allow_paths:\n    - ${relativePath}\n`,
    );
  }

  async function activeChange(phase: 'shape' | 'build' | 'verify' | 'archive', name: string) {
    const paths = await loopProjectPaths(projectRoot, '.');
    await ensureLoopDirectories(paths);
    const state = await createLoopChange({
      paths,
      name,
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });
    state.phase = phase;
    await writeLoopChange(paths, state);
    return { paths, state };
  }

  async function portableBuild(name: string) {
    const paths = await loopProjectPaths(projectRoot, '.');
    await ensureLoopDirectories(paths);
    await createLoopPortableChange({ paths, name, language: 'en' });
    await fs.writeFile(
      path.join(loopPortableChangeDir(paths, name), 'brief.md'),
      '# Acceptance examples\n- The implementation exposes the requested behavior.\n',
    );
    const state = await confirmLoopPortableShape({ paths, name });
    return { paths, state };
  }

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-hook-'));
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'ignore' });
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('normalizes Claude-compatible and loop Hook payloads with every write target', () => {
    expect(
      parseLoopHookRequest(
        JSON.stringify({
          tool_name: 'Edit',
          tool_input: { file_path: 'src/index.ts', paths: ['src/a.ts', 'src/b.ts'] },
        }),
      ),
    ).toEqual({ intent: 'write', targets: ['src/index.ts', 'src/a.ts', 'src/b.ts'] });

    expect(
      parseLoopHookRequest(
        JSON.stringify({
          toolName: 'edit',
          toolArgs: JSON.stringify({ filePath: 'src/copilot.ts' }),
        }),
      ),
    ).toEqual({ intent: 'write', targets: ['src/copilot.ts'] });
  });

  it('extracts every target from apply_patch headers', () => {
    expect(
      parseLoopHookRequest(
        JSON.stringify({
          toolName: 'apply_patch',
          toolArgs: {
            patch: [
              '*** Begin Patch',
              '*** Update File: src/existing.ts',
              '*** Add File: src/new.ts',
              '*** Delete File: src/old.ts',
              '*** End Patch',
            ].join('\n'),
          },
        }),
      ),
    ).toEqual({
      intent: 'write',
      targets: ['src/existing.ts', 'src/new.ts', 'src/old.ts'],
    });
  });

  it('distinguishes explicit non-write tools from unknown write payloads', () => {
    expect(parseLoopHookRequest(JSON.stringify({ toolName: 'view', toolArgs: {} }))).toEqual({
      intent: 'non-write',
      targets: [],
    });
    expect(parseLoopHookRequest(JSON.stringify({ tool_name: 'Write', tool_input: {} }))).toEqual({
      intent: 'unknown',
      targets: [],
    });
    expect(parseLoopHookRequest('{broken')).toEqual({ intent: 'unknown', targets: [] });
    expect(parseLoopHookRequest('')).toEqual({ intent: 'unknown', targets: [] });
  });

  it.each([
    ['shape', false],
    ['build', true],
    ['verify', false],
    ['archive', false],
  ] as const)('%s applies the ordinary project write boundary', async (phase, allowed) => {
    await writeProjectConfig(projectRoot, defaultProjectConfig('.'));
    await activeChange(phase, `guard-${phase}`);

    await expect(
      inspectLoopHookGuard(projectRoot, writeRequest('src/index.ts')),
    ).resolves.toMatchObject({
      allowed,
      phase,
      change: `guard-${phase}`,
    });
  });

  it('allows a configured project-local path during Loop Shape', async () => {
    await writeProjectConfig(projectRoot, defaultProjectConfig('.'));
    await addHookAllowPath('docs/team-notes');
    await activeChange('shape', 'shape-allow-path');

    await expect(
      inspectLoopHookGuard(projectRoot, writeRequest('docs/team-notes/note.md')),
    ).resolves.toMatchObject({
      allowed: true,
      phase: 'shape',
      reason: expect.stringContaining('configured Hook allow path'),
    });
  });

  it('does not let the allowlist bypass Loop Runtime-owned files', async () => {
    await writeProjectConfig(projectRoot, defaultProjectConfig('.'));
    await addHookAllowPath('.owner');
    await activeChange('shape', 'runtime-reserved-allow-path');

    await expect(
      inspectLoopHookGuard(projectRoot, writeRequest('.owner/runtime/extra.json')),
    ).resolves.toMatchObject({ allowed: false, phase: 'shape' });
  });

  it.each(['shape', 'verify', 'archive'] as const)(
    '%s stays neutral when a write target cannot be attributed',
    async (phase) => {
      await writeProjectConfig(projectRoot, defaultProjectConfig('.'));
      await activeChange(phase, `unknown-${phase}`);

      await expect(inspectLoopHookGuard(projectRoot, writeRequest())).resolves.toMatchObject({
        allowed: true,
        phase,
        reason: expect.stringContaining('not attributed'),
      });
    },
  );

  it('allows explicit non-write tools during a guarded phase', async () => {
    await writeProjectConfig(projectRoot, defaultProjectConfig('.'));
    await activeChange('shape', 'read-during-shape');

    await expect(inspectLoopHookGuard(projectRoot, nonWriteRequest())).resolves.toMatchObject({
      allowed: true,
      reason: 'Hook event is not a write',
    });
  });

  it('allows portable Build implementation writes while protecting Runtime-owned state', async () => {
    await writeProjectConfig(projectRoot, defaultProjectConfig('.'));
    const { paths, state } = await portableBuild('portable-build');
    const briefRef = path
      .relative(projectRoot, path.join(loopPortableChangeDir(paths, state.name), 'brief.md'))
      .replaceAll('\\', '/');
    await expect(
      inspectLoopHookGuard(projectRoot, writeRequest(briefRef, 'src/index.ts')),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining('separate actions'),
    });
    await expect(readLoopPortableChange(paths, state.name)).resolves.toMatchObject({
      phase: 'build',
    });
    await expect(
      inspectLoopHookGuard(projectRoot, writeRequest('src/index.ts')),
    ).resolves.toMatchObject({ allowed: true, phase: 'build', change: state.name });
    const stateRef = path
      .relative(
        projectRoot,
        path.join(loopPortableChangeDir(paths, state.name), 'owner-state.yaml'),
      )
      .replaceAll('\\', '/');
    await expect(inspectLoopHookGuard(projectRoot, writeRequest(stateRef))).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining('Runtime-owned'),
    });
  });

  it('keeps parent Build implementation writes assigned to child changes', async () => {
    await writeProjectConfig(projectRoot, defaultProjectConfig('.'));
    const paths = await loopProjectPaths(projectRoot, '.');
    await ensureLoopDirectories(paths);
    const branch = execFileSync('git', ['branch', '--show-current'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }).trim();
    await createLoopPortableChange({
      paths,
      name: 'portable-parent',
      language: 'en',
      workspaceBinding: {
        isolation: 'current',
        changeBranch: branch,
        targetBranch: branch,
      },
    });
    const changeDir = loopPortableChangeDir(paths, 'portable-parent');
    await fs.writeFile(
      path.join(changeDir, 'brief.md'),
      '# Acceptance examples\n- The child implements the requested behavior.\n',
    );
    await fs.writeFile(
      path.join(changeDir, 'children.yaml'),
      'schema: owner.loop.children.v1\nchildren:\n  - name: implementation-child\n    depends_on: []\n    covers: [A1]\n',
    );
    await confirmLoopPortableShape({ paths, name: 'portable-parent' });

    await expect(
      inspectLoopHookGuard(projectRoot, writeRequest('src/index.ts')),
    ).resolves.toMatchObject({
      allowed: false,
      phase: 'build',
      reason: expect.stringContaining('parent Build advances child changes'),
    });
    await expect(readLoopPortableChange(paths, 'portable-parent')).resolves.toMatchObject({
      phase: 'build',
      children_contract_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it('invalidates a portable Verify candidate before allowing an implementation write', async () => {
    await writeProjectConfig(projectRoot, defaultProjectConfig('.'));
    const { paths, state } = await portableBuild('portable-verify-write');
    const runner = createLoopRunnerChannel();
    await submitLoopPortableBuilderCandidate({
      paths,
      name: state.name,
      input: {
        identity: runner.captureExecutionIdentity({
          identityProvider: 'test-host',
          executionRef: 'builder',
        }),
        candidateId: 'candidate',
        summary: 'Built.',
        addressedAcceptanceIds: state.acceptance.map(({ id }) => id),
      },
    });

    const stateRef = path
      .relative(
        projectRoot,
        path.join(loopPortableChangeDir(paths, state.name), 'owner-state.yaml'),
      )
      .replaceAll('\\', '/');
    await expect(
      inspectLoopHookGuard(projectRoot, writeRequest('src/index.ts', stateRef)),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining('Runtime-owned'),
    });
    await expect(readLoopPortableChange(paths, state.name)).resolves.toMatchObject({
      phase: 'verify',
    });

    await expect(
      inspectLoopHookGuard(projectRoot, writeRequest('src/index.ts')),
    ).resolves.toMatchObject({
      allowed: true,
      phase: 'build',
      reason: expect.stringContaining('candidate was invalidated'),
    });
    await expect(readLoopPortableChange(paths, state.name)).resolves.toMatchObject({
      phase: 'build',
      builder_handoff: null,
      verification: null,
    });
  });

  it('allows concurrent implementation writes after invalidating one Verify candidate once', async () => {
    await writeProjectConfig(projectRoot, defaultProjectConfig('.'));
    const { paths, state } = await portableBuild('portable-concurrent-write');
    const runner = createLoopRunnerChannel();
    await submitLoopPortableBuilderCandidate({
      paths,
      name: state.name,
      input: {
        identity: runner.captureExecutionIdentity({
          identityProvider: 'test-host',
          executionRef: 'builder',
        }),
        candidateId: 'candidate',
        summary: 'Built.',
        addressedAcceptanceIds: state.acceptance.map(({ id }) => id),
      },
    });

    const results = await Promise.all([
      inspectLoopHookGuard(projectRoot, writeRequest('src/a.ts')),
      inspectLoopHookGuard(projectRoot, writeRequest('src/b.ts')),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ allowed: true, phase: 'build' }),
      expect.objectContaining({ allowed: true, phase: 'build' }),
    ]);
    await expect(readLoopPortableChange(paths, state.name)).resolves.toMatchObject({
      phase: 'build',
      loop: { iteration: 2 },
      builder_handoff: null,
    });
  });

  it('returns a portable Build change to Shape before allowing formal requirement edits', async () => {
    await writeProjectConfig(projectRoot, defaultProjectConfig('.'));
    const { paths, state } = await portableBuild('portable-shape-write');
    const childrenRef = path
      .relative(projectRoot, path.join(loopPortableChangeDir(paths, state.name), 'children.yaml'))
      .replaceAll('\\', '/');
    await expect(
      inspectLoopHookGuard(projectRoot, writeRequest(childrenRef)),
    ).resolves.toMatchObject({
      allowed: true,
      phase: 'shape',
      reason: expect.stringContaining('requirements changed'),
    });
    await expect(readLoopPortableChange(paths, state.name)).resolves.toMatchObject({
      phase: 'shape',
      acceptance: [],
    });
  });

  it('returns a structured Copilot denial without relying on exit code 2', async () => {
    await writeProjectConfig(projectRoot, defaultProjectConfig('.'));
    await activeChange('shape', 'copilot-shape');
    const previousFilePath = process.env.FILE_PATH;
    process.env.FILE_PATH = 'src/index.ts';
    try {
      const result = await runLoopCli([
        'hook-guard',
        '--hook-output',
        'copilot',
        '--project-root',
        projectRoot,
      ]);

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout ?? '')).toEqual({
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('--return-to-build'),
      });
    } finally {
      if (previousFilePath === undefined) delete process.env.FILE_PATH;
      else process.env.FILE_PATH = previousFilePath;
    }
  });

  it('allows Loop artifacts and projects without an active change', async () => {
    await writeProjectConfig(projectRoot, defaultProjectConfig('docs'));

    await expect(
      inspectLoopHookGuard(projectRoot, writeRequest('docs/owner/changes/example/brief.md')),
    ).resolves.toMatchObject({ allowed: true, reason: 'Loop control artifact write' });
    await expect(
      inspectLoopHookGuard(projectRoot, writeRequest('src/index.ts')),
    ).resolves.toMatchObject({ allowed: true, reason: 'No Loop changes exist' });
  });

  it('allows control-only writes but blocks mixed control and implementation targets', async () => {
    await writeProjectConfig(projectRoot, defaultProjectConfig('docs'));
    const paths = await loopProjectPaths(projectRoot, 'docs');
    await ensureLoopDirectories(paths);
    await createLoopChange({
      paths,
      name: 'guard-control',
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });

    await expect(
      inspectLoopHookGuard(
        projectRoot,
        writeRequest('.owner/config.yaml', 'docs/owner/changes/guard-control/brief.md'),
      ),
    ).resolves.toMatchObject({ allowed: true, reason: 'Loop control artifact write' });
    await expect(
      inspectLoopHookGuard(
        projectRoot,
        writeRequest('docs/owner/changes/guard-control/brief.md', 'src/index.ts'),
      ),
    ).resolves.toMatchObject({ allowed: false, phase: 'shape' });
  });

  it.each(['.github/workflows/ci.yml', '.husky/pre-commit', '.env', '.gitignore'])(
    'guards dot-prefixed project write %s',
    async (target) => {
      await writeProjectConfig(projectRoot, defaultProjectConfig('.'));
      await activeChange('shape', 'guard-dotfiles');

      await expect(inspectLoopHookGuard(projectRoot, writeRequest(target))).resolves.toMatchObject({
        allowed: false,
        phase: 'shape',
      });
    },
  );

  it('does not guard a Pipeline-only project', async () => {
    const config = defaultProjectConfig('.');
    config.default_workflow = 'pipeline';
    config.workflows = ['pipeline'];
    await writeProjectConfig(projectRoot, config);

    await expect(
      inspectLoopHookGuard(projectRoot, writeRequest('src/index.ts')),
    ).resolves.toMatchObject({ allowed: true, reason: 'Loop workflow is not enabled' });
  });

  it('blocks writes when multiple active changes have no valid selection', async () => {
    await writeProjectConfig(projectRoot, defaultProjectConfig('.'));
    await activeChange('build', 'build-change');
    await activeChange('shape', 'shape-change');

    await expect(
      inspectLoopHookGuard(projectRoot, writeRequest('src/index.ts')),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining('select the change'),
    });
  });

  it('uses the selected change when multiple Loop changes are active', async () => {
    await writeProjectConfig(projectRoot, defaultProjectConfig('.'));
    const paths = await loopProjectPaths(projectRoot, '.');
    await ensureLoopDirectories(paths);
    await createLoopChange({
      paths,
      name: 'shape-change',
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });
    const buildChange = await createLoopChange({
      paths,
      verificationProtocol: 'legacy-v1',
      name: 'build-change',
      language: 'en',
    });
    buildChange.phase = 'build';
    await writeLoopChange(paths, buildChange);
    await selectLoopChange(paths, 'build-change');

    await expect(
      inspectLoopHookGuard(projectRoot, writeRequest('src/index.ts')),
    ).resolves.toMatchObject({ allowed: true, phase: 'build', change: 'build-change' });
  });
});
