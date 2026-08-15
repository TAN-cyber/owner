import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loopArchiveCommand } from '../../../domains/owner-loop/loop-archive-command.js';
import { createLoopChange, writeLoopChange } from '../../../domains/owner-loop/loop-change.js';
import {
  defaultProjectConfig,
  writeProjectConfig,
} from '../../../domains/owner-loop/loop-config.js';
import { loopDoctorCommand } from '../../../domains/owner-loop/loop-doctor-command.js';
import { ensureLoopDirectories, loopProjectPaths } from '../../../domains/owner-loop/loop-paths.js';
import {
  archiveLoopPortableChange,
  inspectLoopPortableArchive,
} from '../../../domains/owner-loop/loop-portable-archive.js';
import {
  confirmLoopPortableShape,
  confirmLoopPortableSkillCoordinatedPass,
  createLoopPortableChange,
  dispatchLoopPortableVerifier,
  executeLoopPortableCheckPlan,
  markLoopPortableSpecRemoval,
  loopPortableChangeDir,
  readLoopPortableChange,
  returnLoopPortableChangeToShape,
  submitLoopPortableBuilderCandidate,
  submitLoopPortableVerifierResult,
} from '../../../domains/owner-loop/loop-portable-runtime.js';
import { createLoopRunnerChannel } from '../../../domains/owner-loop/loop-runner-protocol.js';
import { writeLoopPortableState } from '../../../domains/owner-loop/loop-portable-state.js';
import type { LoopProjectPaths } from '../../../domains/owner-loop/loop-types.js';

describe('Loop portable Archive', () => {
  let root: string;
  let paths: LoopProjectPaths;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-archive-v4-'));
    const config = defaultProjectConfig('docs', 'en');
    await writeProjectConfig(root, config);
    paths = await loopProjectPaths(root, 'docs');
    await ensureLoopDirectories(paths);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function verifyState(state: Awaited<ReturnType<typeof confirmLoopPortableShape>>) {
    const name = state.name;
    const runner = createLoopRunnerChannel();
    await submitLoopPortableBuilderCandidate({
      paths,
      name,
      input: {
        identity: runner.captureExecutionIdentity({
          identityProvider: 'test-host',
          executionRef: `${name}-builder`,
        }),
        candidateId: `${name}-candidate`,
        summary: 'Implemented.',
        addressedAcceptanceIds: state.acceptance.map(({ id }) => id),
      },
    });
    const executed = await executeLoopPortableCheckPlan({
      paths,
      name,
      plans: [
        {
          id: 'test',
          name: 'Tests',
          executable: process.execPath,
          argv: ['-e', 'process.exit(0)'],
          cwdRef: '.',
          timeoutMs: 10_000,
          repeatable: true,
        },
      ],
    });
    state = await dispatchLoopPortableVerifier({ paths, name, checks: executed.checks });
    await submitLoopPortableVerifierResult({
      paths,
      name,
      checks: executed.checks,
      maxVerifyFailures: 5,
      envelope: runner.envelopeVerifierResponse({
        candidateId: `${name}-candidate`,
        identity: runner.captureExecutionIdentity({
          identityProvider: 'test-host',
          executionRef: `${name}-verifier`,
        }),
        payload: {
          kind: 'final-result',
          result: {
            iteration: 1,
            attempt: 1,
            verdict: 'pass',
            acceptance: state.acceptance.map(({ id }) => ({
              id,
              result: 'passed',
              reason: 'Verified.',
            })),
            risks: [],
            summary: 'Passed.',
          },
        },
      }),
    });
    return confirmLoopPortableSkillCoordinatedPass({ paths, name });
  }

  async function archiveReady(
    name = 'archive-change',
    specs: Array<[string, string]> = [
      ['sample', '# Sample\n\nRuntime MUST expose the updated behavior.\n'],
    ],
  ) {
    await createLoopPortableChange({ paths, name, language: 'en' });
    const changeDir = loopPortableChangeDir(paths, name);
    await fs.writeFile(
      path.join(changeDir, 'brief.md'),
      '# Acceptance examples\n- The canonical behavior is updated.\n',
    );
    for (const [capability, source] of specs) {
      await fs.mkdir(path.join(changeDir, 'specs', capability), { recursive: true });
      await fs.writeFile(path.join(changeDir, 'specs', capability, 'spec.md'), source);
    }
    return verifyState(await confirmLoopPortableShape({ paths, name }));
  }

  it('rejects malformed Archive options before dispatching to storage', async () => {
    await expect(
      loopArchiveCommand(['archive-change', '--serial-first', 'BadName'], root),
    ).rejects.toThrow('--serial-first must be one Loop change name');
    await expect(
      loopArchiveCommand(['archive-change', '--finish', 'invalid'], root),
    ).rejects.toThrow('--finish must be merge, push, pull-request, or keep');
    await expect(
      loopArchiveCommand(['archive-change', '--serial-first', 'first-change'], root),
    ).rejects.toThrow('--serial-first is only valid for portable Loop changes');
    await expect(loopArchiveCommand(['archive-change', '--finish', 'keep'], root)).rejects.toThrow(
      '--finish is only valid with --dry-run',
    );
  });

  it('applies full specs, finalizes YAML/report, moves the change, and removes local Runtime', async () => {
    const state = await archiveReady();
    expect(await inspectLoopPortableArchive({ paths, name: state.name })).toMatchObject({
      ready: true,
      stateVersion: state.state_version,
    });
    const result = await archiveLoopPortableChange({ paths, name: state.name });

    expect(await fs.readFile(path.join(paths.specsDir, 'sample', 'spec.md'), 'utf8')).toContain(
      'updated behavior',
    );
    expect(await fs.stat(result.archiveDir)).toMatchObject({ isDirectory: expect.any(Function) });
    expect(await fs.readFile(path.join(result.archiveDir, 'owner-state.yaml'), 'utf8')).toContain(
      'status: done',
    );
    await expect(fs.stat(path.join(paths.changesRuntimeDir, state.name))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('applies complete create, modify, and remove Spec operations', async () => {
    await fs.mkdir(path.join(paths.specsDir, 'sample'), { recursive: true });
    await fs.writeFile(path.join(paths.specsDir, 'sample', 'spec.md'), '# Old behavior\n');
    const modified = await archiveReady('modify-spec');
    await archiveLoopPortableChange({ paths, name: modified.name });
    await expect(
      fs.readFile(path.join(paths.specsDir, 'sample', 'spec.md'), 'utf8'),
    ).resolves.toContain('updated behavior');

    await createLoopPortableChange({ paths, name: 'remove-spec', language: 'en' });
    const removeDir = loopPortableChangeDir(paths, 'remove-spec');
    await fs.writeFile(
      path.join(removeDir, 'brief.md'),
      '# Acceptance examples\n- The obsolete capability is removed.\n',
    );
    await markLoopPortableSpecRemoval({ paths, name: 'remove-spec', capability: 'sample' });
    const removal = await verifyState(
      await confirmLoopPortableShape({ paths, name: 'remove-spec' }),
    );
    await archiveLoopPortableChange({ paths, name: removal.name });
    await expect(fs.stat(path.join(paths.specsDir, 'sample', 'spec.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('refuses to remove a canonical Spec through a linked capability directory', async () => {
    const externalCapability = path.join(root, 'external-capability');
    await fs.mkdir(externalCapability, { recursive: true });
    const externalSpec = path.join(externalCapability, 'spec.md');
    await fs.writeFile(externalSpec, '# Must remain\n');
    await fs.symlink(
      externalCapability,
      path.join(paths.specsDir, 'sample'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await createLoopPortableChange({ paths, name: 'linked-remove', language: 'en' });
    const changeDir = loopPortableChangeDir(paths, 'linked-remove');
    await fs.writeFile(
      path.join(changeDir, 'brief.md'),
      '# Acceptance examples\n- The obsolete capability is removed safely.\n',
    );
    await markLoopPortableSpecRemoval({ paths, name: 'linked-remove', capability: 'sample' });
    const removal = await verifyState(
      await confirmLoopPortableShape({ paths, name: 'linked-remove' }),
    );

    await expect(archiveLoopPortableChange({ paths, name: removal.name })).rejects.toThrow(
      'capability directory is unsafe',
    );
    await expect(fs.readFile(externalSpec, 'utf8')).resolves.toBe('# Must remain\n');
  });

  it('returns an archive-ready change to Shape when formal requirements drift', async () => {
    const state = await archiveReady('archive-formal-drift');
    await fs.writeFile(
      path.join(loopPortableChangeDir(paths, state.name), 'brief.md'),
      '# Acceptance examples\n- The canonical behavior is updated.\n- A new requirement is added.\n',
    );

    await expect(archiveLoopPortableChange({ paths, name: state.name })).rejects.toThrow(
      'returned to Shape',
    );
    await expect(readLoopPortableChange(paths, state.name)).resolves.toMatchObject({
      phase: 'shape',
      verification_result: 'pending',
      builder_handoff: null,
    });
    await expect(fs.stat(path.join(paths.specsDir, 'sample', 'spec.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('resumes after final YAML and after directory move without rerunning verification', async () => {
    for (const hook of ['afterFinalState', 'afterMove'] as const) {
      const name = `resume-${hook === 'afterFinalState' ? 'state' : 'move'}`;
      await archiveReady(name);
      await expect(
        archiveLoopPortableChange({
          paths,
          name,
          hooks: { [hook]: () => Promise.reject(new Error(`crash-${hook}`)) },
        }),
      ).rejects.toThrow(`crash-${hook}`);
      const resumed = await archiveLoopPortableChange({ paths, name });
      expect(resumed.state.status).toBe('done');
      expect(await fs.readFile(path.join(resumed.archiveDir, 'verification.md'), 'utf8')).toContain(
        `generated_from_state_version: ${resumed.state.state_version}`,
      );
    }
  });

  it('routes public Archive through portable recovery before reusing a pass', async () => {
    const state = await archiveReady('missing-local-runtime');
    await fs.rm(path.join(paths.changesRuntimeDir, state.name), {
      recursive: true,
      force: true,
    });

    await expect(loopArchiveCommand([state.name, '--confirmed'], root)).resolves.toMatchObject({
      exitCode: 0,
      data: {
        archived: false,
        state: { phase: 'verify', verification_result: 'pending' },
        recovery: { action: 'reverify' },
      },
    });
    await expect(fs.stat(loopPortableChangeDir(paths, state.name))).resolves.toBeDefined();
  });

  it('resumes a moved portable Archive transaction through the public command', async () => {
    const state = await archiveReady('public-move-recovery');
    await expect(
      archiveLoopPortableChange({
        paths,
        name: state.name,
        hooks: { afterMove: () => Promise.reject(new Error('public-after-move')) },
      }),
    ).rejects.toThrow('public-after-move');

    await expect(loopArchiveCommand([state.name, '--confirmed'], root)).resolves.toMatchObject({
      exitCode: 0,
      data: { state: { status: 'done', archived: true } },
    });
  });

  it('resumes an active portable Archive transaction through the public command', async () => {
    const state = await archiveReady('public-active-recovery');
    await expect(
      archiveLoopPortableChange({
        paths,
        name: state.name,
        hooks: { afterSpecApplied: () => Promise.reject(new Error('public-after-spec')) },
      }),
    ).rejects.toThrow('public-after-spec');

    await expect(loopArchiveCommand([state.name, '--confirmed'], root)).resolves.toMatchObject({
      exitCode: 0,
      data: { state: { status: 'done', archived: true } },
    });
    await expect(
      fs.stat(path.join(paths.transactionsDir, `portable-archive-${state.name}.json`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers deterministically when the local Archive transaction is lost', async () => {
    const activeName = 'lost-after-state';
    await archiveReady(activeName);
    await expect(
      archiveLoopPortableChange({
        paths,
        name: activeName,
        hooks: { afterFinalState: () => Promise.reject(new Error('lost-state-transaction')) },
      }),
    ).rejects.toThrow('lost-state-transaction');
    await fs.rm(path.join(paths.transactionsDir, `portable-archive-${activeName}.json`), {
      force: true,
    });
    const activeRecovered = await archiveLoopPortableChange({ paths, name: activeName });
    expect(activeRecovered.state.status).toBe('done');
    await expect(fs.stat(loopPortableChangeDir(paths, activeName))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const movedName = 'lost-after-move';
    await archiveReady(movedName);
    await expect(
      archiveLoopPortableChange({
        paths,
        name: movedName,
        hooks: { afterMove: () => Promise.reject(new Error('lost-move-transaction')) },
      }),
    ).rejects.toThrow('lost-move-transaction');
    await fs.rm(path.join(paths.transactionsDir, `portable-archive-${movedName}.json`), {
      force: true,
    });
    const movedRecovered = await archiveLoopPortableChange({ paths, name: movedName });
    expect(movedRecovered.transactionId).toMatch(/^recovered-/u);
    expect(movedRecovered.state.status).toBe('done');
    await expect(fs.stat(path.join(paths.changesRuntimeDir, movedName))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('blocks other mutations after an interrupted spec apply and lets Archive resume itself', async () => {
    const state = await archiveReady('blocked-by-archive');
    await expect(
      archiveLoopPortableChange({
        paths,
        name: state.name,
        hooks: { afterSpecApplied: () => Promise.reject(new Error('pause-after-spec')) },
      }),
    ).rejects.toThrow('pause-after-spec');

    await expect(
      returnLoopPortableChangeToShape({
        paths,
        name: state.name,
        reason: 'Requirements changed while Archive was interrupted.',
      }),
    ).rejects.toThrow('transaction recovery is required');
    await expect(
      createLoopPortableChange({ paths, name: 'unrelated-change', language: 'en' }),
    ).rejects.toThrow('transaction recovery is required');

    await expect(archiveLoopPortableChange({ paths, name: state.name })).resolves.toMatchObject({
      state: { status: 'done', archived: true },
    });
  });

  it('resumes from frozen Spec contents after a later active Spec edit', async () => {
    const originalBeta = '# Beta\n\nRuntime MUST preserve the confirmed beta behavior.\n';
    const state = await archiveReady('frozen-specs', [
      ['alpha', '# Alpha\n\nRuntime MUST preserve the confirmed alpha behavior.\n'],
      ['beta', originalBeta],
    ]);
    await expect(
      archiveLoopPortableChange({
        paths,
        name: state.name,
        hooks: {
          afterSpecApplied: (index) => {
            if (index === 0) throw new Error('pause-after-first-spec');
          },
        },
      }),
    ).rejects.toThrow('pause-after-first-spec');

    await fs.writeFile(
      path.join(loopPortableChangeDir(paths, state.name), 'specs', 'beta', 'spec.md'),
      '# Beta\n\nRuntime MUST use an unconfirmed replacement.\n',
    );
    const resumed = await archiveLoopPortableChange({ paths, name: state.name });

    await expect(fs.readFile(path.join(paths.specsDir, 'beta', 'spec.md'), 'utf8')).resolves.toBe(
      originalBeta,
    );
    await expect(
      fs.readFile(path.join(resumed.archiveDir, 'specs', 'beta', 'spec.md'), 'utf8'),
    ).resolves.toBe(originalBeta);
  });

  it('reports interrupted Archive transactions in named and project-wide Doctor and repairs them', async () => {
    const state = await archiveReady('doctor-archive');
    await expect(
      archiveLoopPortableChange({
        paths,
        name: state.name,
        hooks: { afterSpecApplied: () => Promise.reject(new Error('doctor-after-spec')) },
      }),
    ).rejects.toThrow('doctor-after-spec');

    for (const args of [[state.name], []]) {
      await expect(loopDoctorCommand(args, root)).resolves.toMatchObject({
        exitCode: 65,
        data: {
          healthy: false,
          findings: expect.arrayContaining([
            expect.objectContaining({
              code: 'portable-archive-transaction-incomplete',
              repair: 'continue',
            }),
          ]),
        },
      });
    }

    await expect(loopDoctorCommand([state.name, '--repair'], root)).resolves.toMatchObject({
      exitCode: 0,
      data: {
        healthy: true,
        workflow: 'loop-portable',
        change: state.name,
        repaired: true,
        archive: { recovered: true },
        state: { status: 'done', archived: true },
      },
    });
  });

  it('repairs a moved Archive transaction after the active directory is gone', async () => {
    const state = await archiveReady('doctor-moved-archive');
    await expect(
      archiveLoopPortableChange({
        paths,
        name: state.name,
        hooks: { afterMove: () => Promise.reject(new Error('doctor-after-move')) },
      }),
    ).rejects.toThrow('doctor-after-move');
    await expect(fs.stat(loopPortableChangeDir(paths, state.name))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    await expect(loopDoctorCommand([state.name], root)).resolves.toMatchObject({
      exitCode: 65,
      data: {
        findings: [expect.objectContaining({ code: 'portable-archive-transaction-incomplete' })],
      },
    });
    await expect(loopDoctorCommand([state.name, '--repair'], root)).resolves.toMatchObject({
      exitCode: 0,
      data: {
        healthy: true,
        archive: { recovered: true },
        state: { status: 'done', archived: true },
      },
    });
  });

  it('keeps Archive ready while requiring one explicit serial capability choice', async () => {
    const first = await archiveReady('serial-first');
    const secondDir = loopPortableChangeDir(paths, 'serial-second');
    await fs.cp(loopPortableChangeDir(paths, first.name), secondDir, { recursive: true });
    await writeLoopPortableState(
      path.join(secondDir, 'owner-state.yaml'),
      { ...first, name: 'serial-second' },
      { containedRoot: paths.loopRoot },
    );

    await expect(inspectLoopPortableArchive({ paths, name: first.name })).resolves.toMatchObject({
      ready: false,
      capabilityPeers: ['serial-second'],
    });
    await expect(loopArchiveCommand([first.name, '--dry-run'], root)).resolves.toMatchObject({
      exitCode: 0,
      data: {
        capabilityPeers: ['serial-second'],
        continuation: {
          disposition: 'await-user',
          requiredInputs: ['choose-first-archive'],
        },
      },
    });
    await expect(archiveLoopPortableChange({ paths, name: first.name })).rejects.toMatchObject({
      name: 'LoopPortableArchiveOrderRequiredError',
      peers: ['serial-second'],
    });
    await expect(readLoopPortableChange(paths, first.name)).resolves.toMatchObject({
      phase: 'archive',
      status: 'active',
      loop: { stage: 'archive-ready' },
    });
    await expect(loopArchiveCommand([first.name, '--confirmed'], root)).resolves.toMatchObject({
      exitCode: 73,
      data: {
        capabilityPeers: ['serial-second'],
        continuation: {
          disposition: 'await-user',
          commandArgs: expect.arrayContaining(['--serial-first', first.name]),
        },
      },
    });

    await expect(
      loopArchiveCommand([first.name, '--confirmed', '--serial-first', first.name], root),
    ).resolves.toMatchObject({ exitCode: 0, data: { state: { status: 'done' } } });
  });

  it('detects capability owners in another registered Git worktree', async () => {
    const first = await archiveReady('primary-owner');
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'loop-test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Loop Test'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'test: seed portable change'], {
      cwd: root,
      stdio: 'ignore',
    });

    const secondary = path.join(root, '.worktrees', 'secondary');
    execFileSync('git', ['worktree', 'add', '-b', 'secondary-owner', secondary, 'HEAD'], {
      cwd: root,
      stdio: 'ignore',
    });
    const secondaryPaths = await loopProjectPaths(secondary, 'docs');
    await ensureLoopDirectories(secondaryPaths);
    await fs.rm(loopPortableChangeDir(secondaryPaths, first.name), {
      recursive: true,
      force: true,
    });
    await createLoopPortableChange({
      paths: secondaryPaths,
      name: 'secondary-owner',
      language: 'en',
    });
    const secondaryChange = loopPortableChangeDir(secondaryPaths, 'secondary-owner');
    await fs.writeFile(
      path.join(secondaryChange, 'brief.md'),
      '# Acceptance examples\n- The secondary behavior is updated.\n',
    );
    await fs.mkdir(path.join(secondaryChange, 'specs', 'sample'), { recursive: true });
    await fs.writeFile(
      path.join(secondaryChange, 'specs', 'sample', 'spec.md'),
      '# Sample\n\nRuntime MUST expose the secondary behavior.\n',
    );
    await confirmLoopPortableShape({ paths: secondaryPaths, name: 'secondary-owner' });

    await expect(inspectLoopPortableArchive({ paths, name: first.name })).resolves.toMatchObject({
      ready: false,
      capabilityPeers: ['secondary-owner'],
    });
  });

  it('requires serial ordering when a legacy active change owns the capability', async () => {
    const portable = await archiveReady('portable-owner');
    const legacy = await createLoopChange({
      paths,
      verificationProtocol: 'legacy-v1',
      name: 'legacy-owner',
      language: 'en',
    });
    const source = path.join(paths.changesDir, legacy.name, 'specs', 'sample', 'spec.md');
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, '# Sample\n\nLegacy change owns this capability.\n');
    await writeLoopChange(paths, {
      ...legacy,
      spec_changes: [
        {
          capability: 'sample',
          operation: 'create',
          source: 'specs/sample/spec.md',
          base_hash: null,
        },
      ],
    });

    await expect(inspectLoopPortableArchive({ paths, name: portable.name })).resolves.toMatchObject(
      {
        ready: false,
        capabilityPeers: ['legacy-owner'],
      },
    );
  });
});
