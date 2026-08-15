import type {
  PipelineCommandHandler,
  PipelineCommandName,
  PipelineCommandResult,
} from './pipeline-cli.js';

function jsonResult(
  command: PipelineCommandName,
  result: PipelineCommandResult,
): PipelineCommandResult {
  return {
    exitCode: result.exitCode,
    stdout:
      JSON.stringify({
        command,
        exitCode: result.exitCode,
        ...(result.stdout === undefined ? {} : { stdout: result.stdout }),
        ...(result.stderr === undefined ? {} : { stderr: result.stderr }),
      }) + '\n',
  };
}

export async function runPipelineScript(
  command: PipelineCommandName,
  handler: PipelineCommandHandler,
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  const json = argv.includes('--json');
  const args = argv.filter((argument) => argument !== '--json');
  let result: PipelineCommandResult;
  try {
    result = await handler(args, { json });
  } catch (error) {
    result = {
      exitCode: 70,
      stderr: error instanceof Error ? error.message : String(error),
    };
  }

  const output = json ? jsonResult(command, result) : result;
  if (output.stdout) process.stdout.write(output.stdout);
  if (output.stderr)
    process.stderr.write(output.stderr + (output.stderr.endsWith('\n') ? '' : '\n'));
  return output.exitCode;
}
