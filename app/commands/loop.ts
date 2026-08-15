import { runLoopCli } from '../../domains/owner-loop/loop-cli.js';

export async function runLoopFacade(args: readonly string[]): Promise<number> {
  const result = await runLoopCli(args);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr)
    process.stderr.write(result.stderr + (result.stderr.endsWith('\n') ? '' : '\n'));
  return result.exitCode;
}
