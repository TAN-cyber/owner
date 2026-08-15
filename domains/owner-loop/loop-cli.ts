import { loopArchiveCommand } from './loop-archive-command.js';
import { loopDoctorCommand } from './loop-doctor-command.js';
import { loopHookGuardCommand } from './loop-hook-guard-command.js';
import { loopInitCommand } from './loop-init-command.js';
import { loopNewCommand } from './loop-new-command.js';
import { loopNextCommand } from './loop-next-command.js';
import { loopRootCommand } from './loop-root-command.js';
import { loopSelectCommand } from './loop-select-command.js';
import { loopShowCommand } from './loop-show-command.js';
import { loopSpecCommand } from './loop-spec-command.js';
import { loopStatusCommand } from './loop-status-command.js';
import { loopHelp } from './loop-cli-help.js';
import {
  errorResult,
  LoopUsageError,
  projectRootFrom,
  render,
  takeFlag,
  takeOption,
  type DispatchResult,
  type LoopCommandResult,
} from './loop-cli-shared.js';

export type { LoopCommandResult } from './loop-cli-shared.js';

type LoopCommandHandler = (args: string[], projectRoot: string) => Promise<DispatchResult>;

const COMMAND_HANDLERS: Record<string, LoopCommandHandler> = {
  'hook-guard': loopHookGuardCommand,
  init: loopInitCommand,
  root: loopRootCommand,
  new: loopNewCommand,
  spec: loopSpecCommand,
  show: loopShowCommand,
  status: loopStatusCommand,
  select: loopSelectCommand,
  next: loopNextCommand,
  archive: loopArchiveCommand,
  doctor: loopDoctorCommand,
};

async function dispatch(
  rawArgs: string[],
  explicitProjectRoot: string | undefined,
): Promise<DispatchResult> {
  const helpIndex = rawArgs.indexOf('--help');
  if (rawArgs.length === 0 || helpIndex >= 0 || rawArgs[0] === 'help') {
    const topicParts =
      rawArgs[0] === 'help' ? rawArgs.slice(1) : helpIndex >= 0 ? rawArgs.slice(0, helpIndex) : [];
    let help: ReturnType<typeof loopHelp>;
    try {
      help = loopHelp(topicParts);
    } catch (error) {
      throw new LoopUsageError((error as Error).message);
    }
    return {
      command: help.topic ? `${help.topic} --help` : 'help',
      exitCode: 0,
      data: help,
      text: help.usage,
    };
  }
  const command = rawArgs.shift()!;
  const projectRoot = await projectRootFrom(explicitProjectRoot);
  const handler = COMMAND_HANDLERS[command];
  if (!handler) {
    throw new LoopUsageError(`Unknown Loop command: ${command}`);
  }
  return handler(rawArgs, projectRoot);
}

export async function runLoopCli(argv: readonly string[]): Promise<LoopCommandResult> {
  const args = [...argv];
  const separator = args.indexOf('--');
  const globalArgs = separator < 0 ? args : args.slice(0, separator);
  const commandTail = separator < 0 ? [] : args.slice(separator);
  const json = globalArgs.includes('--json');
  let explicitProjectRoot: string | undefined;
  let command: string | null = globalArgs[0] ?? null;
  try {
    takeFlag(globalArgs, '--json');
    explicitProjectRoot = takeOption(globalArgs, '--project-root');
    const dispatchArgs = [...globalArgs, ...commandTail];
    command = dispatchArgs[0] ?? null;
    return render(await dispatch(dispatchArgs, explicitProjectRoot), json);
  } catch (error) {
    return render(errorResult(command, error), json);
  }
}
