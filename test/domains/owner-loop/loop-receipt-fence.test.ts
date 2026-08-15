import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { prepareLoopBuildEvidence } from '../../../domains/owner-loop/loop-build-evidence.js';
import {
  createLoopChange,
  loopChangeDir,
  writeLoopChange,
} from '../../../domains/owner-loop/loop-change.js';
import { runLoopCli } from '../../../domains/owner-loop/loop-cli.js';
import {
  defaultProjectConfig,
  writeProjectConfig,
} from '../../../domains/owner-loop/loop-config.js';
import { loopProjectPaths } from '../../../domains/owner-loop/loop-paths.js';
import type { LoopChangeState, LoopProjectPaths } from '../../../domains/owner-loop/loop-types.js';
import { loadLoopVerificationReceiptContext } from '../../../domains/owner-loop/loop-verification-receipt-runtime.js';

const brief = `# Outcome
Protect automated verification from stale implementation scopes.
# Scope
Bind verification commands to the Build snapshot.
# Non-goals
No unrelated workflow changes.
# Acceptance examples
- A stale scope stops before executing the command.
# Constraints and invariants
Return an Agent-actionable recovery command.
# Decisions
Keep the full workspace fence.
# Open questions
None.
# Verification expectations
Run the focused receipt test.
`;

interface JsonEnvelope {
  command: string | null;
  exitCode: number;
  data?: unknown;
  error?: { code: string; message: string };
}

function json(result: Awaited<ReturnType<typeof runLoopCli>>): JsonEnvelope {
  expect(result.stdout).toBeTruthy();
  return JSON.parse(result.stdout!) as JsonEnvelope;
}

// Receipt/snapshot fences were removed from the v4 public Loop path. Their
// replacement is covered by loop-portable-runtime and loop-v4-regression-eval.
describe('Loop verification receipt fence recovery (legacy)', () => {
  let projectRoot: string;
  let paths: LoopProjectPaths;
  let state: LoopChangeState;
  let acceptanceId: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-receipt-fence-'));
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'loop@example.test'], { cwd: projectRoot });
    execFileSync('git', ['config', 'user.name', 'Loop Test'], { cwd: projectRoot });
    await writeProjectConfig(projectRoot, defaultProjectConfig('.'));
    paths = await loopProjectPaths(projectRoot, '.');
    await Promise.all([
      fs.writeFile(path.join(projectRoot, '.gitignore'), 'node_modules/\n.cache/\n'),
      fs.writeFile(path.join(projectRoot, 'feature.ts'), 'export const value = 1;\n'),
    ]);
    execFileSync('git', ['add', '.gitignore', 'feature.ts'], { cwd: projectRoot });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: projectRoot, stdio: 'ignore' });

    const created = await createLoopChange({
      paths,
      verificationProtocol: 'legacy-v1',
      name: 'receipt-fence',
      language: 'en',
      now: new Date('2026-08-04T00:00:00.000Z'),
    });
    await fs.writeFile(path.join(loopChangeDir(paths, created.name), 'brief.md'), brief);
    await fs.writeFile(path.join(projectRoot, 'feature.ts'), 'export const value = 2;\n');
    const build = await prepareLoopBuildEvidence({
      paths,
      state: { ...created, phase: 'build', approval: 'implicit' },
      artifactRefs: ['feature.ts'],
      now: new Date('2026-08-04T00:05:00.000Z'),
    });
    state = await writeLoopChange(paths, {
      ...created,
      phase: 'verify',
      approval: 'implicit',
      implementation_scope: build.scopeRef,
    });
    acceptanceId = (await loadLoopVerificationReceiptContext(paths, state)).acceptanceIds[0]!;
    await fs.appendFile(path.join(projectRoot, '.gitignore'), 'coverage/\n');
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it.skip('stops before command execution and returns a bounded self-healing recovery payload', async () => {
    const sentinel = path.join(projectRoot, 'receipt-command-ran.txt');
    const result = json(
      await runLoopCli([
        'receipt',
        'automated',
        state.name,
        '--acceptance',
        acceptanceId,
        '--json',
        '--project-root',
        projectRoot,
        '--',
        process.execPath,
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran')`,
      ]),
    );

    expect(result).toMatchObject({
      command: 'receipt',
      exitCode: 65,
      data: {
        reason: 'implementation-scope-stale',
        commandExecuted: false,
        changedPaths: [{ path: '.gitignore', kind: 'modified' }],
        changedPathCount: 1,
        changedPathsTruncated: false,
        requiredAction: 'return-to-build-and-refresh-implementation-scope',
        nextCommand:
          'owner loop next receipt-fence --summary "Implementation changed after Build; return to Build and refresh scope"',
        requiresUserDecision: false,
      },
      error: {
        code: 'implementation-scope-stale',
        message: expect.stringContaining('stopped before command execution'),
      },
    });
    await expect(fs.access(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skip('routes receipt refresh to Build scope recovery instead of reporting a clean no-op', async () => {
    const result = json(
      await runLoopCli(['receipt', 'refresh', state.name, '--json', '--project-root', projectRoot]),
    );

    expect(result).toMatchObject({
      command: 'receipt',
      exitCode: 65,
      data: {
        reason: 'implementation-scope-stale',
        commandExecuted: false,
        changedPaths: [{ path: '.gitignore', kind: 'modified' }],
        requiredAction: 'return-to-build-and-refresh-implementation-scope',
        requiresUserDecision: false,
      },
      error: { code: 'implementation-scope-stale' },
    });
  });

  it.skip('keeps the post-command fence and reports files changed by the verification command', async () => {
    await fs.writeFile(path.join(projectRoot, '.gitignore'), 'node_modules/\n.cache/\n');
    const feature = path.join(projectRoot, 'feature.ts');
    const result = json(
      await runLoopCli([
        'receipt',
        'automated',
        state.name,
        '--acceptance',
        acceptanceId,
        '--json',
        '--project-root',
        projectRoot,
        '--',
        process.execPath,
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(feature)}, 'export const value = 3;\\n')`,
      ]),
    );

    expect(result).toMatchObject({
      exitCode: 1,
      data: {
        receipt: { status: 'blocked' },
        recovery: {
          reason: 'implementation-changed-during-command',
          commandExecuted: true,
          changedPaths: [{ path: 'feature.ts', kind: 'modified' }],
          requiredAction: 'return-to-build-and-refresh-implementation-scope',
          requiresUserDecision: false,
        },
      },
    });
  });

  it.skip('allows verification commands to write ignored cache files', async () => {
    await fs.writeFile(path.join(projectRoot, '.gitignore'), 'node_modules/\n.cache/\n');
    const cache = path.join(projectRoot, '.cache', 'result.txt');
    const result = json(
      await runLoopCli([
        'receipt',
        'automated',
        state.name,
        '--acceptance',
        acceptanceId,
        '--json',
        '--project-root',
        projectRoot,
        '--',
        process.execPath,
        '-e',
        `require('node:fs').mkdirSync(${JSON.stringify(path.dirname(cache))}, {recursive:true}); require('node:fs').writeFileSync(${JSON.stringify(cache)}, 'cache')`,
      ]),
    );

    expect(result).toMatchObject({
      exitCode: 0,
      data: { receipt: { status: 'passed' } },
    });
    expect((result.data as { recovery?: unknown }).recovery).toBeUndefined();
  });

  it('rejects the retired receipt command at the public boundary', async () => {
    const result = json(
      await runLoopCli(['receipt', state.name, '--json', '--project-root', projectRoot]),
    );
    expect(result).toMatchObject({
      command: 'receipt',
      exitCode: 64,
      error: { code: 'usage' },
    });
  });
});
