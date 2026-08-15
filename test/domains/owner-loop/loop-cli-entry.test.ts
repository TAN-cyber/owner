import { describe, expect, it, vi } from 'vitest';

const runLoopCli = vi.hoisted(() => vi.fn());

vi.mock('../../../domains/owner-loop/loop-cli.js', () => ({ runLoopCli }));

describe('Loop CLI entry', () => {
  it('writes both output channels and returns the CLI exit code', async () => {
    runLoopCli.mockResolvedValueOnce({
      stdout: 'out',
      stderr: 'err',
      exitCode: 7,
    });
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const { main } = await import('../../../domains/owner-loop/loop-cli-entry.js');
    await expect(main(['status'])).resolves.toBe(7);
    expect(runLoopCli).toHaveBeenCalledWith(['status']);
    expect(stdout).toHaveBeenCalledWith('out');
    expect(stderr).toHaveBeenCalledWith('err\n');
  });

  it('does not add a second newline to an existing stderr line', async () => {
    runLoopCli.mockResolvedValueOnce({ stdout: '', stderr: 'already\n', exitCode: 0 });
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const { main } = await import('../../../domains/owner-loop/loop-cli-entry.js');
    await expect(main()).resolves.toBe(0);
    expect(stderr).toHaveBeenCalledWith('already\n');
  });
});
