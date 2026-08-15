import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';

const runPipelineCli = vi.fn();

vi.mock('../../domains/owner-pipeline/pipeline-cli.js', () => ({
  runPipelineCli,
}));

describe('Pipeline command facade', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    runPipelineCli.mockReset();
  });

  it('exposes exactly the four stable public Pipeline commands', async () => {
    const { PUBLIC_PIPELINE_COMMANDS } = await import('../../app/commands/pipeline.js');

    expect(PUBLIC_PIPELINE_COMMANDS).toEqual(['state', 'guard', 'handoff', 'archive']);
  });

  it('registers the Pipeline facade from its single public command source', async () => {
    const source = await fs.readFile(path.resolve('app', 'cli', 'index.ts'), 'utf8');

    // The facade command list is inlined in the CLI entry so that importing
    // the Pipeline CLI graph is deferred to the action (lazy load). The four
    // stable names must still drive the command registration loop.
    expect(source).toContain("= ['state', 'guard', 'handoff', 'archive'] as const");
    expect(source).toContain('for (const command of PUBLIC_PIPELINE_COMMANDS)');
    expect(source).toContain(
      "const { runPipelineFacade } = await import('../commands/pipeline.js');",
    );
  });

  it('dispatches exact argv and forwards stdout, stderr, and a nonzero exit code', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    runPipelineCli.mockResolvedValue({
      exitCode: 9,
      stdout: 'pipeline output\n',
      stderr: 'pipeline error\n',
    });
    const { runPipelineFacade } = await import('../../app/commands/pipeline.js');

    const exitCode = await runPipelineFacade('handoff', [
      'write',
      '--json',
      '--apply',
      '--dry-run',
      '--pipeline-option',
      'value',
    ]);

    expect(runPipelineCli).toHaveBeenCalledWith([
      'handoff',
      'write',
      '--json',
      '--apply',
      '--dry-run',
      '--pipeline-option',
      'value',
    ]);
    expect(stdout).toHaveBeenCalledWith('pipeline output\n');
    expect(stderr).toHaveBeenCalledWith('pipeline error\n');
    expect(exitCode).toBe(9);
  });

  it('preserves flag order through real Commander registration', async () => {
    runPipelineCli.mockResolvedValue({ exitCode: 9 });
    const originalArgv = process.argv;
    const originalExitCode = process.exitCode;
    process.argv = [
      process.execPath,
      'owner',
      'guard',
      'check',
      '--json',
      '--apply',
      '--dry-run',
      '--pipeline-option',
      'value',
    ];
    process.exitCode = undefined;
    vi.resetModules();

    try {
      await import('../../app/cli/index.js');
      await vi.waitFor(() => {
        expect(runPipelineCli).toHaveBeenCalledWith([
          'guard',
          'check',
          '--json',
          '--apply',
          '--dry-run',
          '--pipeline-option',
          'value',
        ]);
        expect(process.exitCode).toBe(9);
      });
    } finally {
      process.argv = originalArgv;
      process.exitCode = originalExitCode;
    }
  });

  it('routes Pipeline group argv before global version parsing', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    runPipelineCli.mockResolvedValue({ exitCode: 0, stdout: 'openspec version\n' });
    const originalArgv = process.argv;
    const originalExitCode = process.exitCode;
    process.argv = [process.execPath, 'owner', 'pipeline', 'openspec', '--', '--version'];
    process.exitCode = undefined;
    vi.resetModules();

    try {
      await import('../../app/cli/index.js');
      await vi.waitFor(() => {
        expect(runPipelineCli).toHaveBeenCalledWith(['openspec', '--', '--version']);
        expect(stdout).toHaveBeenCalledWith('openspec version\n');
        expect(process.exitCode).toBe(0);
      });
    } finally {
      stdout.mockRestore();
      process.argv = originalArgv;
      process.exitCode = originalExitCode;
    }
  });
});
