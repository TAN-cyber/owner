import { AsyncLocalStorage } from 'async_hooks';
import { promises as fs } from 'fs';
import path from 'path';

import { discoverPipelineProject } from './pipeline-layout.js';

export interface PipelineCommandContext {
  invocationCwd: string;
  projectRoot: string;
}

export interface PipelineCommandContextOptions {
  invocationCwd?: string;
  projectRoot?: string;
}

const commandContext = new AsyncLocalStorage<PipelineCommandContext>();

function isInside(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

async function resolveCommandContext(
  options: PipelineCommandContextOptions,
): Promise<PipelineCommandContext> {
  const invocationCwd = path.resolve(options.invocationCwd ?? process.cwd());
  const projectRoot = path.resolve(
    options.projectRoot ?? (await discoverPipelineProject(invocationCwd)),
  );
  const [realInvocationCwd, realProjectRoot] = await Promise.all([
    fs.realpath(invocationCwd),
    fs.realpath(projectRoot),
  ]);
  if (!isInside(realProjectRoot, realInvocationCwd)) {
    throw new Error(
      `Pipeline command invocation cwd is outside the discovered project: ${invocationCwd}`,
    );
  }
  return { invocationCwd, projectRoot };
}

export async function withPipelineCommandContext<T>(
  options: PipelineCommandContextOptions,
  operation: (context: PipelineCommandContext) => Promise<T>,
): Promise<T> {
  const active = commandContext.getStore();
  if (active) return operation(active);
  const resolved = await resolveCommandContext(options);
  return commandContext.run(resolved, () => operation(resolved));
}

export function pipelineCommandProjectRoot(): string {
  const active = commandContext.getStore();
  if (!active) throw new Error('Pipeline command project context is unavailable');
  return active.projectRoot;
}

export function pipelineCommandInvocationCwd(): string {
  const active = commandContext.getStore();
  if (!active) throw new Error('Pipeline command invocation context is unavailable');
  return active.invocationCwd;
}
