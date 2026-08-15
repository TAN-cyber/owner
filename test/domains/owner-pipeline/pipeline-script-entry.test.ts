import { afterEach, describe, expect, it, vi } from 'vitest';

import { runPipelineScript } from '../../../domains/owner-pipeline/pipeline-script-entry.js';

describe('Pipeline direct script entry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves the shared runtime command field in JSON mode', async () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });

    const exitCode = await runPipelineScript(
      'state',
      async () => ({ exitCode: 64, stderr: 'invalid state arguments' }),
      ['--json'],
    );

    expect(exitCode).toBe(64);
    expect(JSON.parse(output)).toEqual({
      command: 'state',
      exitCode: 64,
      stderr: 'invalid state arguments',
    });
  });
});
