import { pathToFileURL } from 'url';
import { pipelineArchiveCommand } from './pipeline-archive.js';
import { pipelineGuardCommand } from './pipeline-guard.js';
import { pipelineHandoffCommand } from './pipeline-handoff.js';
import { pipelineHookGuardCommand } from './pipeline-hook-guard.js';
import { pipelineIntentCommand } from './pipeline-intent-command.js';
import { pipelineOpenSpecCommand } from './pipeline-openspec-command.js';
import { pipelineResumeProbeCommand } from './pipeline-resume-probe-command.js';
import { pipelineRootCommand } from './pipeline-root-command.js';
import { pipelineStateCommand } from './pipeline-state-command.js';
import { pipelineValidateCommand } from './pipeline-validate-command.js';
import { pipelineWorkspaceCommand } from './pipeline-workspace-command.js';

export interface PipelineCommandResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export interface PipelineCommandOptions {
  json: boolean;
  invocationCwd?: string;
  projectRoot?: string;
}

export type PipelineCommandHandler = (
  args: string[],
  options: PipelineCommandOptions,
) => Promise<PipelineCommandResult>;

export type PipelineCommandHandlers = Partial<Record<PipelineCommandName, PipelineCommandHandler>>;

export const PIPELINE_COMMANDS = [
  'state',
  'validate',
  'guard',
  'handoff',
  'archive',
  'hook-guard',
  'intent',
  'resume-probe',
  'openspec',
  'root',
  'workspace',
] as const;

export type PipelineCommandName = (typeof PIPELINE_COMMANDS)[number];

const DEFAULT_HANDLERS: PipelineCommandHandlers = {
  state: pipelineStateCommand,
  validate: pipelineValidateCommand,
  guard: pipelineGuardCommand,
  handoff: pipelineHandoffCommand,
  archive: pipelineArchiveCommand,
  'hook-guard': pipelineHookGuardCommand,
  intent: pipelineIntentCommand,
  'resume-probe': pipelineResumeProbeCommand,
  openspec: pipelineOpenSpecCommand,
  root: pipelineRootCommand,
  workspace: pipelineWorkspaceCommand,
};

function isPipelineCommand(value: string): value is PipelineCommandName {
  return PIPELINE_COMMANDS.includes(value as PipelineCommandName);
}

function commandError(command: string | undefined): PipelineCommandResult {
  if (!command) {
    return {
      exitCode: 64,
      stderr: `Usage: owner-pipeline <${PIPELINE_COMMANDS.join('|')}> [args]`,
    };
  }
  return {
    exitCode: 64,
    stderr: `Unknown Pipeline command: ${command}`,
  };
}

async function dispatch(
  command: string | undefined,
  args: string[],
  options: PipelineCommandOptions,
  handlers: PipelineCommandHandlers,
): Promise<PipelineCommandResult> {
  if (!command || !isPipelineCommand(command)) return commandError(command);
  const handler = handlers[command];
  if (!handler) {
    return {
      exitCode: 70,
      stderr: `Pipeline command is not implemented: ${command}`,
    };
  }

  try {
    return await handler(args, options);
  } catch (error) {
    return {
      exitCode: 70,
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

function jsonResult(
  command: string | undefined,
  result: PipelineCommandResult,
): PipelineCommandResult {
  return {
    exitCode: result.exitCode,
    stdout:
      JSON.stringify({
        command: command ?? null,
        exitCode: result.exitCode,
        ...(result.stdout === undefined ? {} : { stdout: result.stdout }),
        ...(result.stderr === undefined ? {} : { stderr: result.stderr }),
      }) + '\n',
  };
}

export async function runPipelineCli(
  argv: readonly string[],
  handlers: PipelineCommandHandlers = DEFAULT_HANDLERS,
): Promise<PipelineCommandResult> {
  const json = argv[0] !== 'openspec' && argv.includes('--json');
  const args = json ? argv.filter((argument) => argument !== '--json') : [...argv];
  const command = args.shift();
  const result = await dispatch(command, args, { json, invocationCwd: process.cwd() }, handlers);
  return json ? jsonResult(command, result) : result;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const result = await runPipelineCli(argv);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr)
    process.stderr.write(result.stderr + (result.stderr.endsWith('\n') ? '' : '\n'));
  return result.exitCode;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
