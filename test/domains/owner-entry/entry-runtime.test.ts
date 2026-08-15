import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  formatOwnerWorkflowResolution,
  resolveOwnerWorkflowResolution,
} from '../../../domains/owner-entry/workflow-resolution.js';
import { runOwnerEntryRuntime } from '../../../domains/owner-entry/entry-runtime.js';

vi.mock('../../../domains/owner-entry/workflow-resolution.js', () => ({
  formatOwnerWorkflowResolution: vi.fn(),
  resolveOwnerWorkflowResolution: vi.fn(),
}));

function io() {
  return { stdout: vi.fn(), stderr: vi.fn() };
}

describe('Owner entry runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('formats a human-readable workflow resolution by default', async () => {
    const output = io();
    vi.mocked(resolveOwnerWorkflowResolution).mockResolvedValue({} as never);
    vi.mocked(formatOwnerWorkflowResolution).mockReturnValue('pipeline: demo');

    await expect(runOwnerEntryRuntime([], output)).resolves.toBe(0);

    expect(resolveOwnerWorkflowResolution).toHaveBeenCalledWith(process.cwd());
    expect(formatOwnerWorkflowResolution).toHaveBeenCalledWith({});
    expect(output.stdout).toHaveBeenCalledWith('pipeline: demo\n');
    expect(output.stderr).not.toHaveBeenCalled();
  });

  it('prints help without resolving a project', async () => {
    const output = io();

    await expect(runOwnerEntryRuntime(['--help'], output)).resolves.toBe(0);
    await expect(runOwnerEntryRuntime(['-h'], output)).resolves.toBe(0);

    expect(resolveOwnerWorkflowResolution).not.toHaveBeenCalled();
    expect(output.stdout).toHaveBeenNthCalledWith(
      1,
      'Usage: owner-entry-runtime [path] [--json]\n',
    );
    expect(output.stdout).toHaveBeenNthCalledWith(
      2,
      'Usage: owner-entry-runtime [path] [--json]\n',
    );
  });

  it('prints JSON for an explicit target path', async () => {
    const output = io();
    const resolution = { workflow: 'loop', change: 'demo' };
    vi.mocked(resolveOwnerWorkflowResolution).mockResolvedValue(resolution as never);

    await expect(runOwnerEntryRuntime(['--json', 'project'], output)).resolves.toBe(0);

    expect(resolveOwnerWorkflowResolution).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]project$/u),
    );
    expect(output.stdout).toHaveBeenCalledWith(`${JSON.stringify(resolution, null, 2)}\n`);
  });

  it.each([
    [['--unknown'], 'Unknown option: --unknown'],
    [['first', 'second'], 'Unexpected argument: second'],
  ])('returns a usage error for invalid arguments %j', async (args, message) => {
    const output = io();

    await expect(runOwnerEntryRuntime(args, output)).resolves.toBe(64);
    expect(output.stderr).toHaveBeenCalledWith(
      `${message}\nUsage: owner-entry-runtime [path] [--json]\n`,
    );
  });

  it('returns a runtime error when workflow resolution fails', async () => {
    const output = io();
    vi.mocked(resolveOwnerWorkflowResolution).mockRejectedValue(new Error('unreadable project'));

    await expect(runOwnerEntryRuntime(['project'], output)).resolves.toBe(65);
    expect(output.stderr).toHaveBeenCalledWith('unreadable project\n');
  });

  it('formats a non-Error workflow resolution failure', async () => {
    const output = io();
    vi.mocked(resolveOwnerWorkflowResolution).mockRejectedValue('unreadable project');

    await expect(runOwnerEntryRuntime(['project'], output)).resolves.toBe(65);
    expect(output.stderr).toHaveBeenCalledWith('unreadable project\n');
  });
});
