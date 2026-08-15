import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockedExecFileSync = vi.mocked(execFileSync);

describe('Superpowers integration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exposes only Claude Code and Codex agent mappings', async () => {
    const { SKILLS_AGENT_MAP } = await import('../../../domains/integrations/superpowers.js');

    expect(SKILLS_AGENT_MAP).toEqual({ claude: 'claude-code', codex: 'codex' });
  });

  it('builds one deduplicated install command for both supported platforms', async () => {
    const { buildSuperpowersInstallCommand } =
      await import('../../../domains/integrations/superpowers.js');

    expect(
      buildSuperpowersInstallCommand('/tmp/test', 'project', ['claude', 'codex', 'claude']),
    ).toEqual({
      command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
      args: [
        'skills',
        'add',
        'obra/superpowers',
        '-y',
        '--agent',
        'claude-code',
        '--agent',
        'codex',
      ],
    });
  });

  it('adds the global flag for a global installation', async () => {
    const { buildSuperpowersInstallCommand } =
      await import('../../../domains/integrations/superpowers.js');

    expect(buildSuperpowersInstallCommand('/tmp/test', 'global', ['codex']).args).toEqual([
      'skills',
      'add',
      'obra/superpowers',
      '-y',
      '-g',
      '--agent',
      'codex',
    ]);
  });

  it('rejects unsupported platforms before invoking npx', async () => {
    const { installSuperpowersForPlatforms } =
      await import('../../../domains/integrations/superpowers.js');

    await expect(
      installSuperpowersForPlatforms('/tmp/test', 'project', ['claude', 'cursor', 'gemini']),
    ).rejects.toThrow('Unknown platform IDs: cursor, gemini');
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it('skips installation when the caller disables it', async () => {
    const { installSuperpowersForPlatforms } =
      await import('../../../domains/integrations/superpowers.js');

    await expect(
      installSuperpowersForPlatforms('/tmp/test', 'project', ['claude'], false),
    ).resolves.toBe('skipped');
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it('installs Superpowers with a bounded command execution', async () => {
    mockedExecFileSync.mockReturnValueOnce(Buffer.from('installed'));
    const { installSuperpowersForPlatforms } =
      await import('../../../domains/integrations/superpowers.js');

    await expect(
      installSuperpowersForPlatforms('/tmp/test', 'project', ['claude', 'codex']),
    ).resolves.toBe('installed');
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      expect.arrayContaining(['obra/superpowers', 'claude-code', 'codex']),
      expect.objectContaining({ cwd: '/tmp/test', timeout: 300_000 }),
    );
  });

  it('returns failed and prints captured command diagnostics', async () => {
    const error = new Error('install failed') as Error & { stderr?: Buffer };
    error.stderr = Buffer.from('network unavailable');
    mockedExecFileSync.mockImplementationOnce(() => {
      throw error;
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { installSuperpowersForPlatforms } =
      await import('../../../domains/integrations/superpowers.js');

    await expect(installSuperpowersForPlatforms('/tmp/test', 'project', ['codex'])).resolves.toBe(
      'failed',
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('network unavailable'));
  });
});
