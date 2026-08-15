import type { DispatchResult, LoopCommandResult } from './loop-cli-shared.js';
import { errorResult, projectRootFrom, render, takeFlag, takeOption } from './loop-cli-shared.js';

type LoopScriptHandler = (args: string[], projectRoot: string) => Promise<DispatchResult>;

function jsonResult(result: DispatchResult): LoopCommandResult {
  return {
    exitCode: result.exitCode,
    stdout:
      JSON.stringify({
        command: result.command,
        exitCode: result.exitCode,
        ...(result.data === undefined ? {} : { data: result.data }),
        ...(result.error === undefined ? {} : { error: result.error }),
      }) + '\n',
  };
}

/**
 * Shared entry point for the per-command Loop launchers. Mirrors
 * `runPipelineScript`: it strips `--json`/`--project-root`, resolves the project
 * root, delegates to a single command handler, and renders the result (JSON or
 * text). This keeps each command's launcher a thin shell that only loads its
 * own dependency graph instead of the full Loop runtime.
 */
export async function runLoopScript(
  command: string,
  handler: LoopScriptHandler,
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  const separator = argv.indexOf('--');
  const globalArgs = separator < 0 ? [...argv] : argv.slice(0, separator);
  const commandTail = separator < 0 ? [] : argv.slice(separator);
  const json = globalArgs.includes('--json');
  let explicitProjectRoot: string | undefined;
  let result: DispatchResult;
  try {
    takeFlag(globalArgs, '--json');
    explicitProjectRoot = takeOption(globalArgs, '--project-root');
    const dispatchArgs = [...globalArgs, ...commandTail];
    const projectRoot = await projectRootFrom(explicitProjectRoot);
    result = await handler(dispatchArgs, projectRoot);
  } catch (error) {
    result = errorResult(command, error);
  }
  const output = json ? jsonResult(result) : render(result, false);
  if (output.stdout) process.stdout.write(output.stdout);
  if (output.stderr)
    process.stderr.write(output.stderr + (output.stderr.endsWith('\n') ? '' : '\n'));
  return output.exitCode;
}
