import { afterEach, describe, expect, it, vi } from 'vitest';

const runLoopCli = vi.fn();

vi.mock('../../domains/owner-loop/loop-cli.js', () => ({ runLoopCli }));

describe('Loop command facade', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    runLoopCli.mockReset();
  });

  it('forwards exact argv, stdout, stderr, and exit code', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    runLoopCli.mockResolvedValue({
      exitCode: 73,
      stdout: 'loop output\n',
      stderr: 'loop error',
    });
    const { runLoopFacade } = await import('../../app/commands/loop.js');
    const argv = ['next', 'change-name', '--summary', 'done', '--json', '--artifact', 'a.ts'];

    const result = await runLoopFacade(argv);

    expect(runLoopCli).toHaveBeenCalledWith(argv);
    expect(stdout).toHaveBeenCalledWith('loop output\n');
    expect(stderr).toHaveBeenCalledWith('loop error\n');
    expect(result).toBe(73);
  });

  it('preserves argv order through the single Commander registration', async () => {
    runLoopCli.mockResolvedValue({ exitCode: 73 });
    const originalArgv = process.argv;
    const originalExitCode = process.exitCode;
    process.argv = [
      process.execPath,
      'owner',
      'loop',
      'next',
      'change-name',
      '--summary',
      'done',
      '--artifact',
      'a.ts',
      '--json',
    ];
    process.exitCode = undefined;
    vi.resetModules();
    try {
      await import('../../app/cli/index.js');
      await vi.waitFor(() => {
        expect(runLoopCli).toHaveBeenCalledWith([
          'next',
          'change-name',
          '--summary',
          'done',
          '--artifact',
          'a.ts',
          '--json',
        ]);
        expect(process.exitCode).toBe(73);
      });
    } finally {
      process.argv = originalArgv;
      process.exitCode = originalExitCode;
    }
  });
});
