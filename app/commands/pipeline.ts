import { runPipelineCli } from '../../domains/owner-pipeline/pipeline-cli.js';

export const PUBLIC_PIPELINE_COMMANDS = ['state', 'guard', 'handoff', 'archive'] as const;

export type PublicPipelineCommand = (typeof PUBLIC_PIPELINE_COMMANDS)[number];

export async function runPipelineFacade(
  command: PublicPipelineCommand,
  args: readonly string[],
): Promise<number> {
  const result = await runPipelineCli([command, ...args]);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.exitCode;
}

export async function runPipelineGroupFacade(args: readonly string[]): Promise<number> {
  if (args.length === 0 || (args.length === 1 && (args[0] === '--help' || args[0] === '-h'))) {
    process.stdout.write(
      [
        'Usage: owner pipeline <command> [args]',
        '',
        'Commands:',
        '  workspace prepare <name> --isolation <mode>  Prepare or reuse the Pipeline workspace',
        '  workspace resolve <name>                    Route to the selected Pipeline workspace',
        '  openspec -- <openspec-args...>       Run OpenSpec from the configured Pipeline root',
        '  root show                            Print the configured Pipeline artifact roots',
        '  root move docs --dry-run              Inspect the legacy-to-docs migration',
        '  root move docs --apply                Apply the migration immediately',
        '',
      ].join('\n'),
    );
    return 0;
  }
  const result = await runPipelineCli(args);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.exitCode;
}
