import { afterEach, describe, expect, it, vi } from 'vitest';

import { runLoopScript } from '../../../domains/owner-loop/loop-script-entry.js';
import { LoopUsageError } from '../../../domains/owner-loop/loop-cli-shared.js';

describe('Loop direct script entry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves the shared runtime command field for JSON errors', async () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });

    const exitCode = await runLoopScript(
      'status',
      async () => {
        throw new LoopUsageError('invalid status arguments');
      },
      ['--json'],
    );

    expect(exitCode).toBe(64);
    expect(JSON.parse(output)).toEqual({
      command: 'status',
      exitCode: 64,
      error: { code: 'usage', message: 'invalid status arguments' },
    });
  });
});
