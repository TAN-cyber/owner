import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';

import { spawnCommand } from '../../platform/process/spawn-command.js';
import { terminateProcessTree } from '../../platform/process/terminate-process-tree.js';
import { redactLoopCredentialText } from './loop-redaction.js';

export interface LoopCheckPlan {
  id: string;
  name: string;
  executable: string;
  argv: string[];
  cwdRef: string;
  timeoutMs: number;
  repeatable: boolean;
}

export interface LoopExecutedCheck {
  id: string;
  name: string;
  argvDisplay: string[];
  cwdRef: string;
  status: 'passed' | 'failed' | 'interrupted';
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  startedAt: string;
  completedAt: string;
  repeatable: boolean;
  logRef: string;
}

function inside(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

function safeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export function resolveLoopCheckCwd(projectRoot: string, cwdRef: string): string {
  if (
    cwdRef.length === 0 ||
    cwdRef.includes('\\') ||
    path.posix.isAbsolute(cwdRef) ||
    /^(?:[A-Za-z]:|~)/u.test(cwdRef) ||
    cwdRef.split('/').includes('..') ||
    path.posix.normalize(cwdRef) !== cwdRef
  ) {
    throw new Error('Loop check cwd must be a normalized project-relative ref');
  }
  const root = path.resolve(projectRoot);
  const target = path.resolve(root, ...cwdRef.split('/'));
  if (!inside(root, target)) throw new Error('Loop check cwd escaped the project root');
  return target;
}

export function loopCheckPlanKey(plan: LoopCheckPlan): string {
  return JSON.stringify([
    plan.executable,
    plan.argv,
    plan.cwdRef.replaceAll('\\', '/'),
    plan.timeoutMs,
    plan.repeatable,
  ]);
}

const SENSITIVE_VALUE_FLAG =
  /^(?:-p|-u|--(?:[a-z0-9]+[-_])*(?:api[-_]?key|access[-_]?token|auth[-_]?token|client[-_]?secret|secret(?:[-_]?access)?[-_]?key|private[-_]?key|token|password|passwd|secret|authorization|cookie|set[-_]?cookie|user))$/iu;

export function loopPortableArgvDisplay(argv: readonly string[]): string[] {
  let redactNext = false;
  return argv.map((argument) => {
    if (redactNext) {
      redactNext = false;
      return '[REDACTED]';
    }
    const redacted = redactLoopCredentialText(argument);
    if (SENSITIVE_VALUE_FLAG.test(argument)) redactNext = true;
    return redacted;
  });
}

export function validateLoopCheckPlan(projectRoot: string, plan: LoopCheckPlan): string {
  safeSegment(plan.id, 'Loop check ID');
  if (plan.name.trim().length === 0 || plan.executable.trim().length === 0) {
    throw new Error('Loop check name and executable must be non-empty');
  }
  if (!Number.isSafeInteger(plan.timeoutMs) || plan.timeoutMs < 1) {
    throw new Error('Loop check timeout must be a positive integer');
  }
  return resolveLoopCheckCwd(projectRoot, plan.cwdRef);
}

export async function executeLoopCheck(options: {
  projectRoot: string;
  runtimeDir: string;
  operationId: string;
  plan: LoopCheckPlan;
  now?: () => Date;
}): Promise<LoopExecutedCheck> {
  const { plan } = options;
  safeSegment(options.operationId, 'Loop check operation ID');
  const cwd = validateLoopCheckPlan(options.projectRoot, plan);
  const logDirectory = path.join(options.runtimeDir, 'logs', 'checks');
  const logFile = path.join(logDirectory, `${options.operationId}-${plan.id}.log`);
  if (!inside(path.resolve(options.runtimeDir), path.resolve(logFile))) {
    throw new Error('Loop check log path escaped the Runtime root');
  }
  await fs.mkdir(logDirectory, { recursive: true });
  const started = (options.now ?? (() => new Date()))();
  const stream = createWriteStream(logFile, { flags: 'wx' });

  return new Promise<LoopExecutedCheck>((resolve, reject) => {
    let child;
    try {
      child = spawnCommand(plan.executable, plan.argv, {
        cwd,
        env: process.env,
      });
    } catch (error) {
      stream.destroy();
      reject(error);
      return;
    }

    let timedOut = false;
    let spawnError: Error | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      void terminateProcessTree(child).catch(() => child.kill('SIGKILL'));
    }, plan.timeoutMs);
    timer.unref?.();

    child.stdout.pipe(stream, { end: false });
    child.stderr.pipe(stream, { end: false });
    child.once('error', (error) => {
      spawnError = error;
      stream.write(`\n[owner] failed to start check: ${redactLoopCredentialText(error.message)}\n`);
    });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      const completed = (options.now ?? (() => new Date()))();
      stream.end(() => {
        const interrupted = timedOut || spawnError !== null || signal !== null;
        resolve({
          id: plan.id,
          name: plan.name,
          argvDisplay: loopPortableArgvDisplay(plan.argv),
          cwdRef: plan.cwdRef,
          status: interrupted ? 'interrupted' : exitCode === 0 ? 'passed' : 'failed',
          exitCode,
          signal,
          timedOut,
          durationMs: Math.max(0, completed.getTime() - started.getTime()),
          startedAt: started.toISOString(),
          completedAt: completed.toISOString(),
          repeatable: plan.repeatable,
          logRef: path.relative(options.runtimeDir, logFile).split(path.sep).join('/'),
        });
      });
    });
    stream.once('error', (error) => {
      clearTimeout(timer);
      void terminateProcessTree(child).catch(() => child.kill('SIGKILL'));
      reject(error);
    });
  });
}
