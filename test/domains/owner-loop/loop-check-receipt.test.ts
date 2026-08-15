import { constants as fsConstants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prepareLoopBuildEvidence } from '../../../domains/owner-loop/loop-build-evidence.js';
import {
  executeLoopCheckReceipt,
  LOOP_CHECK_LIMITS,
  parseLoopCheckReceipt,
} from '../../../domains/owner-loop/loop-check-receipt.js';
import { buildLoopCheckReceipt } from '../../../domains/owner-loop/loop-check-receipt-model.js';
import {
  readLoopCheckReceipt,
  writeLoopCheckReceipt,
} from '../../../domains/owner-loop/loop-check-receipt-storage.js';
import { createLoopChange, loopChangeDir } from '../../../domains/owner-loop/loop-change.js';
import {
  loopChangeRuntimeDir,
  loopProjectPaths,
  loopRuntimeRefFile,
} from '../../../domains/owner-loop/loop-paths.js';
import type { LoopChangeState, LoopProjectPaths } from '../../../domains/owner-loop/loop-types.js';

const brief = `# Outcome
Capture a bounded verification receipt.
# Scope
Update the declared implementation.
# Non-goals
No unrelated work.
# Acceptance examples
- The receipt binds the scoped check to current facts.
# Constraints and invariants
Do not execute project or external commands.
# Decisions
Use the Loop evidence store.
# Open questions
None.
# Verification expectations
Run the focused check.
`;

describe('Loop scoped check receipts', () => {
  let projectRoot: string;
  let paths: LoopProjectPaths;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-check-receipt-'));
    paths = await loopProjectPaths(projectRoot, '.');
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  async function prepareState(content: string | Buffer): Promise<LoopChangeState> {
    await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'src', 'feature.ts'), 'export const value = 1;\n');
    const created = await createLoopChange({
      paths,
      verificationProtocol: 'legacy-v1',
      name: 'safe-check',
      language: 'en',
      now: new Date('2026-07-17T00:00:00.000Z'),
    });
    await fs.writeFile(path.join(loopChangeDir(paths, created.name), 'brief.md'), brief);
    await fs.writeFile(path.join(projectRoot, 'src', 'feature.ts'), content);
    const build = await prepareLoopBuildEvidence({
      paths,
      state: { ...created, phase: 'build', approval: 'implicit' },
      artifactRefs: ['src/feature.ts'],
      now: new Date('2026-07-17T00:05:00.000Z'),
    });
    return {
      ...created,
      phase: 'verify',
      approval: 'implicit',
      implementation_scope: build.scopeRef,
    };
  }

  async function prepareNoCodeState(): Promise<LoopChangeState> {
    await fs.writeFile(path.join(projectRoot, 'unchanged.ts'), 'export const stable = true;\n');
    const created = await createLoopChange({
      paths,
      verificationProtocol: 'legacy-v1',
      name: 'safe-check',
      language: 'en',
      now: new Date('2026-07-17T00:00:00.000Z'),
    });
    await fs.writeFile(path.join(loopChangeDir(paths, created.name), 'brief.md'), brief);
    const build = await prepareLoopBuildEvidence({
      paths,
      state: { ...created, phase: 'build', approval: 'implicit' },
      artifactRefs: [],
      noCodeReason: 'Only documentation inside the Loop change is required.',
      now: new Date('2026-07-17T00:05:00.000Z'),
    });
    return {
      ...created,
      phase: 'verify',
      approval: 'implicit',
      implementation_scope: build.scopeRef,
    };
  }

  it('scans only scoped text with no command execution and records bounded issues', async () => {
    const state = await prepareState(
      'export const value = 2; \n \t\n<<<<<<< HEAD\n=======\n>>>>>>> branch\n',
    );
    const ticks = [new Date('2026-07-17T01:00:00.000Z'), new Date('2026-07-17T01:00:01.000Z')];

    const result = await executeLoopCheckReceipt({
      paths,
      state,
      clock: () => ticks.shift()!,
    });

    expect(result.ref).toMatch(/^runtime\/evidence\/check-receipts\/[a-f0-9]{64}\.json$/u);
    expect(result.receipt).toMatchObject({
      schema: 'owner.loop.check-receipt.v1',
      status: 'failed',
      stale: false,
      counts: {
        filesSelected: 1,
        filesScanned: 1,
        binaryFilesSkipped: 0,
        bytesScanned: Buffer.byteLength(
          'export const value = 2; \n \t\n<<<<<<< HEAD\n=======\n>>>>>>> branch\n',
        ),
        issueCount: 6,
        recordedIssueCount: 6,
      },
      issuesTruncated: false,
      issues: [
        { path: 'src/feature.ts', line: 1, kind: 'trailing-whitespace' },
        { path: 'src/feature.ts', line: 2, kind: 'trailing-whitespace' },
        { path: 'src/feature.ts', line: 2, kind: 'space-before-tab' },
        { path: 'src/feature.ts', line: 3, kind: 'conflict-marker' },
        { path: 'src/feature.ts', line: 4, kind: 'conflict-marker' },
        { path: 'src/feature.ts', line: 5, kind: 'conflict-marker' },
      ],
    });
    expect(result.receipt.checker).toMatchObject({
      policy: 'scoped-text-safety',
      version: 1,
      limits: LOOP_CHECK_LIMITS,
    });
    expect(result.receipt.checker.hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.receipt.inputHash).toMatch(/^[a-f0-9]{64}$/u);
    const serialized = JSON.stringify(result.receipt);
    for (const forbidden of [
      projectRoot,
      'argv',
      'executable',
      'exitCode',
      'signal',
      'stdout',
      'stderr',
      'HEAD',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    await expect(readLoopCheckReceipt(paths, state.name, result.ref)).resolves.toEqual(
      result.receipt,
    );
  });

  it('blocks binary skips instead of treating an uninspected scoped file as a pass', async () => {
    const state = await prepareState(Buffer.from([0x00, 0x01, 0x02, 0x03]));

    const { receipt } = await executeLoopCheckReceipt({ paths, state });

    expect(receipt).toMatchObject({
      status: 'failed',
      stale: false,
      counts: {
        filesSelected: 1,
        filesScanned: 0,
        binaryFilesSkipped: 1,
        bytesScanned: 4,
        issueCount: 1,
        recordedIssueCount: 1,
      },
      issues: [{ path: 'src/feature.ts', line: 1, kind: 'binary-skipped' }],
    });
  });

  it('ignores unchanged files outside the implementation scope even when they contain markers', async () => {
    await fs.writeFile(path.join(projectRoot, 'unrelated.ts'), '<<<<<<< HEAD\nvalue \n=======\n');
    const state = await prepareState('export const value = 2;\n');

    const { receipt } = await executeLoopCheckReceipt({ paths, state });

    expect(receipt).toMatchObject({
      status: 'passed',
      stale: false,
      counts: { filesSelected: 1, filesScanned: 1, issueCount: 0 },
      issues: [],
    });
  });

  it('passes an explicit no-code scope while recording that zero files were selected', async () => {
    const state = await prepareNoCodeState();

    const { receipt } = await executeLoopCheckReceipt({ paths, state });

    expect(receipt).toMatchObject({
      status: 'passed',
      stale: false,
      counts: {
        filesSelected: 0,
        filesScanned: 0,
        binaryFilesSkipped: 0,
        bytesScanned: 0,
        issueCount: 0,
      },
    });
  });

  it('passes a deleted-only scope because there is no current regular file to read', async () => {
    await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'src', 'removed.ts'), 'export const old = true;\n');
    await fs.writeFile(path.join(projectRoot, 'src', 'kept.ts'), 'export const kept = true;\n');
    const created = await createLoopChange({
      paths,
      verificationProtocol: 'legacy-v1',
      name: 'safe-check',
      language: 'en',
      now: new Date('2026-07-17T00:00:00.000Z'),
    });
    await fs.writeFile(path.join(loopChangeDir(paths, created.name), 'brief.md'), brief);
    await fs.rm(path.join(projectRoot, 'src', 'removed.ts'));
    const build = await prepareLoopBuildEvidence({
      paths,
      state: { ...created, phase: 'build', approval: 'implicit' },
      artifactRefs: ['src'],
    });
    const state: LoopChangeState = {
      ...created,
      phase: 'verify',
      approval: 'implicit',
      implementation_scope: build.scopeRef,
    };

    const { receipt } = await executeLoopCheckReceipt({ paths, state });

    expect(receipt).toMatchObject({
      status: 'passed',
      counts: { filesSelected: 0, filesScanned: 0, bytesScanned: 0, issueCount: 0 },
    });
  });

  it('reports an unowned baseline deletion until its exact partial scope is confirmed', async () => {
    await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'src', 'feature.ts'), 'export const value = 1;\n');
    await fs.writeFile(path.join(projectRoot, 'src', 'unrelated.ts'), 'export const old = true;\n');
    const created = await createLoopChange({
      paths,
      verificationProtocol: 'legacy-v1',
      name: 'safe-check',
      language: 'en',
      now: new Date('2026-07-17T00:00:00.000Z'),
    });
    await fs.writeFile(path.join(loopChangeDir(paths, created.name), 'brief.md'), brief);
    await fs.writeFile(path.join(projectRoot, 'src', 'feature.ts'), 'export const value = 2;\n');
    await fs.rm(path.join(projectRoot, 'src', 'unrelated.ts'));
    const build = await prepareLoopBuildEvidence({
      paths,
      state: { ...created, phase: 'build', approval: 'implicit' },
      artifactRefs: ['src/feature.ts'],
    });
    const state: LoopChangeState = {
      ...created,
      phase: 'verify',
      approval: 'implicit',
      implementation_scope: build.scopeRef,
    };

    const unconfirmed = await executeLoopCheckReceipt({ paths, state });
    expect(unconfirmed.receipt).toMatchObject({
      status: 'failed',
      counts: { filesSelected: 2, filesScanned: 1, issueCount: 1 },
      issues: [{ path: 'src/unrelated.ts', kind: 'scope-mismatch' }],
    });

    const confirmed = await prepareLoopBuildEvidence({
      paths,
      state: { ...created, phase: 'build', approval: 'implicit' },
      artifactRefs: ['src/feature.ts'],
      allowPartialScopeHash: build.bundle.scope.scopeHash,
      partialReason: 'The deleted file belongs to parallel work.',
      confirmedSummary: 'Confirmed the exact deleted path is outside this change.',
      confirmed: true,
    });
    const allowed = await executeLoopCheckReceipt({
      paths,
      state: {
        ...state,
        implementation_scope: confirmed.scopeRef,
        partial_allowance: confirmed.allowanceRef,
      },
    });
    expect(allowed.receipt).toMatchObject({
      status: 'passed',
      counts: { filesSelected: 1, filesScanned: 1, issueCount: 0 },
      issues: [],
    });
  });

  it('fails closed on a scoped parent redirected through a symlink or junction', async () => {
    const state = await prepareState('export const value = 2;\n');
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-check-outside-'));
    try {
      await fs.writeFile(path.join(outside, 'feature.ts'), 'outside secret\n');
      await fs.rename(path.join(projectRoot, 'src'), path.join(projectRoot, 'src-original'));
      await fs.symlink(
        outside,
        path.join(projectRoot, 'src'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );

      const { receipt } = await executeLoopCheckReceipt({ paths, state });

      expect(receipt.status).toBe('failed');
      expect(receipt.issues).toContainEqual({
        path: 'src/feature.ts',
        line: 1,
        kind: 'unsafe-file',
      });
      expect(receipt.stale).toBe(true);
      expect(JSON.stringify(receipt)).not.toContain(outside);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32')(
    'rejects a scoped file replaced by a symlink',
    async () => {
      const state = await prepareState('export const value = 2;\n');
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-check-file-link-'));
      try {
        const outsideFile = path.join(outside, 'feature.ts');
        await fs.writeFile(outsideFile, 'outside secret\n');
        await fs.rm(path.join(projectRoot, 'src', 'feature.ts'));
        await fs.symlink(outsideFile, path.join(projectRoot, 'src', 'feature.ts'), 'file');

        const { receipt } = await executeLoopCheckReceipt({ paths, state });

        expect(receipt).toMatchObject({
          status: 'failed',
          issues: [{ path: 'src/feature.ts', line: 1, kind: 'unsafe-file' }],
        });
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    },
  );

  it('fails closed before reading when the scoped input exceeds checker limits', async () => {
    const state = await prepareState(Buffer.alloc(LOOP_CHECK_LIMITS.maxFileBytes + 1, 0x61));

    const { receipt } = await executeLoopCheckReceipt({ paths, state });

    expect(receipt).toMatchObject({
      status: 'failed',
      counts: { filesSelected: 1, filesScanned: 0, bytesScanned: 0, issueCount: 1 },
      issues: [{ path: 'src/feature.ts', line: 1, kind: 'scan-limit' }],
    });
  });

  it('batches individually bounded scoped files beyond one receipt byte budget', async () => {
    await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
    for (let index = 0; index < 9; index += 1) {
      await fs.writeFile(path.join(projectRoot, 'src', `file-${index}.txt`), '');
    }
    const created = await createLoopChange({
      paths,
      verificationProtocol: 'legacy-v1',
      name: 'safe-check',
      language: 'en',
      now: new Date('2026-07-17T00:00:00.000Z'),
    });
    await fs.writeFile(path.join(loopChangeDir(paths, created.name), 'brief.md'), brief);
    for (let index = 0; index < 9; index += 1) {
      await fs.writeFile(
        path.join(projectRoot, 'src', `file-${index}.txt`),
        Buffer.alloc(LOOP_CHECK_LIMITS.maxFileBytes, 0x61),
      );
    }
    const build = await prepareLoopBuildEvidence({
      paths,
      state: { ...created, phase: 'build', approval: 'implicit' },
      artifactRefs: ['src'],
    });
    const state: LoopChangeState = {
      ...created,
      phase: 'verify',
      approval: 'implicit',
      implementation_scope: build.scopeRef,
    };

    const { receipt } = await executeLoopCheckReceipt({ paths, state });

    expect(receipt).toMatchObject({
      status: 'passed',
      counts: {
        filesSelected: 9,
        filesScanned: 9,
        bytesScanned: 9 * LOOP_CHECK_LIMITS.maxFileBytes,
        issueCount: 0,
        batches: [
          expect.objectContaining({ filesSelected: 4 }),
          expect.objectContaining({ filesSelected: 4 }),
          expect.objectContaining({ filesSelected: 1 }),
        ],
      },
      issues: [],
    });
  });

  it('checks every attributed file when scope detail pages exceed one page', async () => {
    await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
    for (let index = 0; index <= LOOP_CHECK_LIMITS.maxFiles; index += 1) {
      await fs.writeFile(path.join(projectRoot, 'src', `file-${index}.txt`), '');
    }
    const created = await createLoopChange({
      paths,
      verificationProtocol: 'legacy-v1',
      name: 'safe-check',
      language: 'en',
      now: new Date('2026-07-17T00:00:00.000Z'),
    });
    await fs.writeFile(path.join(loopChangeDir(paths, created.name), 'brief.md'), brief);
    for (let index = 0; index <= LOOP_CHECK_LIMITS.maxFiles; index += 1) {
      await fs.writeFile(path.join(projectRoot, 'src', `file-${index}.txt`), 'x');
    }
    const build = await prepareLoopBuildEvidence({
      paths,
      state: { ...created, phase: 'build', approval: 'implicit' },
      artifactRefs: ['src'],
    });
    const state: LoopChangeState = {
      ...created,
      phase: 'verify',
      approval: 'implicit',
      implementation_scope: build.scopeRef,
    };
    expect(build.bundle.scope.complete).toBe(true);
    expect(build.bundle.scope.changes.length).toBeLessThanOrEqual(128);

    const { receipt } = await executeLoopCheckReceipt({ paths, state });

    expect(receipt).toMatchObject({
      status: 'passed',
      counts: {
        filesSelected: LOOP_CHECK_LIMITS.maxFiles + 1,
        filesScanned: LOOP_CHECK_LIMITS.maxFiles + 1,
        bytesScanned: LOOP_CHECK_LIMITS.maxFiles + 1,
        issueCount: 0,
        batches: [
          expect.objectContaining({ filesSelected: LOOP_CHECK_LIMITS.maxFiles }),
          expect.objectContaining({ filesSelected: 1 }),
        ],
      },
      issues: [],
    });
  });

  it('marks changed scoped facts stale and never trusts the file outside its projection', async () => {
    const state = await prepareState('export const value = 2;\n');
    await fs.writeFile(path.join(projectRoot, 'src', 'feature.ts'), 'export const value = 7;\n');

    const { receipt } = await executeLoopCheckReceipt({ paths, state });

    expect(receipt.status).toBe('failed');
    expect(receipt.staleReasons).toEqual([
      'implementation-before-does-not-match-scope',
      'implementation-after-does-not-match-scope',
    ]);
    expect(receipt.issues).toContainEqual({
      path: 'src/feature.ts',
      line: 1,
      kind: 'scope-mismatch',
    });
  });

  it('detects a same-size replacement between lstat and open before reading its content', async () => {
    const state = await prepareState('export const value = 2;\n');
    const target = path.join(projectRoot, 'src', 'feature.ts');
    const replacement = path.join(projectRoot, 'replacement.ts');
    await fs.writeFile(replacement, 'export const value = 7;\n');
    const originalOpen = fs.open.bind(fs);
    let targetOpens = 0;
    let replaced = false;
    const protectedOpenFlags =
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (path.resolve(String(args[0])) === path.resolve(target)) {
        targetOpens += 1;
        const isProtectedRead =
          process.platform === 'win32' ? targetOpens === 2 : args[1] === protectedOpenFlags;
        if (!replaced && isProtectedRead) {
          replaced = true;
          await fs.rename(replacement, target);
        }
      }
      return originalOpen(...args);
    });
    try {
      const { receipt } = await executeLoopCheckReceipt({ paths, state });
      expect(receipt.status).toBe('failed');
      expect(receipt.issues).toContainEqual({
        path: 'src/feature.ts',
        line: 1,
        kind: 'unsafe-file',
      });
    } finally {
      open.mockRestore();
    }
  });

  it('strictly parses content hashes and protects content-addressed storage', async () => {
    const state = await prepareState('export const value = 2;\n');
    const { receipt, ref } = await executeLoopCheckReceipt({ paths, state });
    expect(parseLoopCheckReceipt(receipt)).toEqual(receipt);
    expect(() => parseLoopCheckReceipt({ ...receipt, unexpected: true })).toThrow('unknown field');
    expect(() => parseLoopCheckReceipt({ ...receipt, receiptHash: 'f'.repeat(64) })).toThrow(
      'content hash mismatch',
    );
    expect(() =>
      parseLoopCheckReceipt({
        ...receipt,
        checker: { ...receipt.checker, version: 2 },
      }),
    ).toThrow('checker policy is unsupported');
    expect(() =>
      buildLoopCheckReceipt({
        change: receipt.change,
        sourceRevision: receipt.sourceRevision,
        status: 'passed',
        startedAt: receipt.startedAt,
        endedAt: receipt.endedAt,
        contract: receipt.contract,
        implementation: receipt.implementation,
        counts: {
          ...receipt.counts,
          filesSelected: 1,
          filesScanned: 0,
          bytesScanned: 0,
        },
        issues: [],
        issuesTruncated: false,
        stale: false,
        staleReasons: [],
      }),
    ).toThrow('cover every selected file');

    const file = loopRuntimeRefFile(loopChangeRuntimeDir(paths, state.name), ref);
    await fs.writeFile(file, JSON.stringify({ ...receipt, unexpected: true }));
    await expect(readLoopCheckReceipt(paths, state.name, ref)).rejects.toThrow('unknown field');
    await expect(writeLoopCheckReceipt({ paths, name: state.name, receipt })).rejects.toThrow();
  });

  it('does not persist a usable receipt when a scoped read is interrupted by an I/O error', async () => {
    const state = await prepareState('export const value = 2;\n');
    const target = path.resolve(projectRoot, 'src', 'feature.ts');
    const originalOpen = fs.open.bind(fs);
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (path.resolve(String(args[0])) === target) {
        throw Object.assign(new Error('interrupted read'), { code: 'EIO' });
      }
      return originalOpen(...args);
    });
    try {
      await expect(executeLoopCheckReceipt({ paths, state })).rejects.toThrow('interrupted read');
      await expect(
        fs.access(path.join(loopChangeRuntimeDir(paths, state.name), 'evidence', 'check-receipts')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      open.mockRestore();
    }
  });

  it('rejects traversal refs and a redirected receipt directory', async () => {
    const state = await prepareState('export const value = 2;\n');
    const { ref } = await executeLoopCheckReceipt({ paths, state });
    await expect(readLoopCheckReceipt(paths, state.name, '../../outside.json')).rejects.toThrow(
      'ref is invalid',
    );

    const receiptDirectory = path.join(
      loopChangeRuntimeDir(paths, state.name),
      'evidence',
      'check-receipts',
    );
    const redirected = path.join(paths.loopRoot, 'runtime', 'redirected-check-receipts');
    await fs.mkdir(path.dirname(redirected), { recursive: true });
    await fs.rename(receiptDirectory, redirected);
    await fs.symlink(
      redirected,
      receiptDirectory,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await expect(readLoopCheckReceipt(paths, state.name, ref)).rejects.toThrow(
      /outside (?:its change|the Loop root)|symlink|real directory/iu,
    );
  });

  it.runIf(process.platform !== 'win32')(
    'refuses a receipt replaced by a symlink between lstat and open',
    async () => {
      const state = await prepareState('export const value = 2;\n');
      const { ref } = await executeLoopCheckReceipt({ paths, state });
      const receiptFile = loopRuntimeRefFile(loopChangeRuntimeDir(paths, state.name), ref);
      const outside = path.join(projectRoot, 'outside-receipt.json');
      await fs.writeFile(outside, '{}');
      const originalOpen = fs.open.bind(fs);
      let replaced = false;
      const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        if (!replaced && path.resolve(String(args[0])) === path.resolve(receiptFile)) {
          replaced = true;
          await fs.rename(receiptFile, `${receiptFile}.original`);
          await fs.symlink(outside, receiptFile, 'file');
        }
        return originalOpen(...args);
      });
      try {
        await expect(readLoopCheckReceipt(paths, state.name, ref)).rejects.toThrow(
          'unsafe while opening',
        );
      } finally {
        open.mockRestore();
      }
    },
  );
});
