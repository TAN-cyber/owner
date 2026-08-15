import { spawnSync } from 'child_process';

import { quoteArgsForShell } from '../../platform/process/shell-quote.js';

import type { PipelineCommandHandler, PipelineCommandResult } from './pipeline-cli.js';
import { assertPipelineLayoutWritable, discoverPipelineProject } from './pipeline-layout.js';
import { assertPipelineOpenSpecRootHealthy } from './pipeline-openspec-root.js';

function normalizedArguments(args: readonly string[]): string[] {
  return args[0] === '--' ? args.slice(1) : [...args];
}

export async function executePipelineOpenSpec(
  args: readonly string[],
  startPath = process.cwd(),
): Promise<PipelineCommandResult> {
  const openSpecArgs = normalizedArguments(args);
  if (openSpecArgs.length === 0) {
    return {
      exitCode: 64,
      stderr: 'Usage: owner pipeline openspec -- <openspec-args...>',
    };
  }

  const projectRoot = await discoverPipelineProject(startPath);
  const layout = await assertPipelineLayoutWritable(projectRoot);
  await assertPipelineOpenSpecRootHealthy(projectRoot, layout);
  const command = process.env.OWNER_OPENSPEC || 'openspec';
  const useShell = process.platform === 'win32';
  const result = spawnSync(command, useShell ? quoteArgsForShell(openSpecArgs) : openSpecArgs, {
    cwd: layout.openSpecBase,
    encoding: 'utf8',
    shell: useShell,
    windowsHide: true,
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return {
      exitCode: code === 'ENOENT' ? 127 : 70,
      stdout: result.stdout || undefined,
      stderr:
        result.stderr ||
        (code === 'ENOENT' ? `OpenSpec CLI not found: ${command}` : result.error.message),
    };
  }
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout || undefined,
    stderr: result.stderr || undefined,
  };
}

export const pipelineOpenSpecCommand: PipelineCommandHandler = async (args) => {
  return executePipelineOpenSpec(args);
};
