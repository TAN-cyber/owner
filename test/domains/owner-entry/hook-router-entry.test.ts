import path from 'node:path';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { inspectOwnerHook } from '../../../domains/owner-entry/hook-router.js';
import {
  main,
  isDirectEntry,
  projectRootFrom,
  runOwnerHookRouter,
} from '../../../domains/owner-entry/hook-router-entry.js';
import { resolveOwnerHookProjectRoot } from '../../../domains/owner-entry/hook-project-root.js';

vi.mock('../../../domains/owner-entry/hook-router.js', () => ({
  inspectOwnerHook: vi.fn(),
}));

vi.mock('../../../domains/owner-entry/hook-project-root.js', () => ({
  resolveOwnerHookProjectRoot: vi.fn((root: string) => root),
}));

describe('Owner Hook Router entry', () => {
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FILE_PATH = 'src/entry.ts';
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    delete process.env.FILE_PATH;
    stderr.mockRestore();
  });

  it('returns usage errors before reading a Hook request', async () => {
    await expect(runOwnerHookRouter([])).resolves.toBe(64);
    await expect(runOwnerHookRouter(['--unknown'])).resolves.toBe(64);
    await expect(runOwnerHookRouter(['--platform', 'unsupported'])).resolves.toBe(64);

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('--platform is required'));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Unknown argument: --unknown'));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('unsupported Hook platform'));
    expect(inspectOwnerHook).not.toHaveBeenCalled();
  });

  it('routes an explicit project request and renders an allow decision', async () => {
    vi.mocked(inspectOwnerHook).mockResolvedValue({ allowed: true, reason: 'allowed' });

    await expect(
      runOwnerHookRouter(['--platform', 'codex', '--project-root', 'project']),
    ).resolves.toBe(0);

    const projectRoot = path.resolve('project');
    expect(resolveOwnerHookProjectRoot).toHaveBeenCalledWith(
      projectRoot,
      expect.objectContaining({ intent: 'write', targets: ['src/entry.ts'] }),
    );
    expect(inspectOwnerHook).toHaveBeenCalledWith(
      projectRoot,
      expect.objectContaining({ targets: ['src/entry.ts'] }),
    );
    expect(stderr).not.toHaveBeenCalled();
  });

  it('renders a denied decision and exposes the main entry wrapper', async () => {
    vi.mocked(inspectOwnerHook).mockResolvedValue({ allowed: false, reason: 'blocked' });

    await expect(main(['--platform', 'codex', '--project-root', 'project'])).resolves.toBe(2);
    expect(stderr).toHaveBeenCalledWith('blocked\n');
  });

  it('fails closed when Hook inspection throws', async () => {
    vi.mocked(inspectOwnerHook).mockRejectedValue(new Error('inspection failed'));

    await expect(
      runOwnerHookRouter(['--platform', 'codex', '--project-root', 'project']),
    ).resolves.toBe(2);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('Owner Hook Router failed closed during project discovery'),
    );
  });

  it('resolves explicit roots and keeps a legacy invocation neutral without a request cwd', async () => {
    const parsed = { platformId: 'codex' } as Parameters<typeof projectRootFrom>[0];
    await expect(projectRootFrom(parsed)).resolves.toBeNull();
    await expect(projectRootFrom(parsed, undefined)).resolves.toBeNull();
    await expect(
      projectRootFrom({ platformId: 'codex', projectRoot: path.resolve('project') }),
    ).resolves.toBe(path.resolve('project'));
  });

  it.skipIf(process.platform === 'win32')(
    'recognizes a direct invocation through a POSIX symlink',
    async () => {
      const tempDir = await mkdtemp(path.join(tmpdir(), 'owner-hook-router-entry-'));
      const target = path.join(tempDir, 'router.mjs');
      const link = path.join(tempDir, 'linked-router.mjs');
      try {
        await writeFile(target, 'export {};\n');
        await symlink(target, link);

        expect(isDirectEntry(link, pathToFileURL(target).href)).toBe(true);
        expect(isDirectEntry(undefined, pathToFileURL(target).href)).toBe(false);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
  );
});
