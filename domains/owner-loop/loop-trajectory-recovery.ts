import { createHash } from 'crypto';
import path from 'path';

import { LOOP_RUN_STORAGE } from '../engine/storage-layout.js';
import { withLoopMutationLock } from './loop-mutation-lock.js';
import { loopChangeRuntimeDir, loopStorageRoot, resolveContainedLoopPath } from './loop-paths.js';
import { readLoopTrajectoryText, replaceLoopTrajectoryText } from './loop-run-store.js';
import type { LoopProjectPaths } from './loop-types.js';

const CHANGE_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

export type LoopTrajectoryTailInspection =
  | { status: 'clean'; file: string }
  | {
      status: 'repairable';
      file: string;
      reason: 'incomplete-json' | 'missing-newline';
      line: number;
      originalHash: string;
      targetHash: string;
      tailHash: string;
      discardedBytes: number;
    }
  | {
      status: 'invalid';
      file: string;
      line: number;
      message: string;
    };

interface RepairableAnalysis {
  inspection: Extract<LoopTrajectoryTailInspection, { status: 'repairable' }>;
  targetContent: string;
}

export class LoopTrajectoryRepairRequiredError extends Error {
  readonly code = 'loop-trajectory-tail-repair-required';

  constructor(readonly inspection: Exclude<LoopTrajectoryTailInspection, { status: 'clean' }>) {
    super(
      inspection.status === 'repairable'
        ? `Loop trajectory has an incomplete final line at ${inspection.file}:${inspection.line}; run doctor --repair`
        : `Loop trajectory is invalid at ${inspection.file}:${inspection.line}: ${inspection.message}`,
    );
    this.name = 'LoopTrajectoryRepairRequiredError';
  }
}

export interface LoopTrajectoryRepairHooks {
  beforeCommit?: () => void | Promise<void>;
}

function sha256Buffer(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function trajectoryFile(paths: LoopProjectPaths, name: string): string {
  if (!CHANGE_NAME_PATTERN.test(name)) throw new Error(`Invalid Loop change name: ${name}`);
  return path.join(loopChangeRuntimeDir(paths, name), 'trajectory.jsonl');
}

function parseCompleteLines(
  content: string,
): { status: 'valid'; count: number } | { status: 'invalid'; line: number; message: string } {
  const lines = content.split(/\n/u);
  let count = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].endsWith('\r') ? lines[index].slice(0, -1) : lines[index];
    if (line.length === 0) continue;
    count = index + 1;
    try {
      JSON.parse(line);
    } catch (error) {
      return { status: 'invalid', line: index + 1, message: (error as Error).message };
    }
  }
  return { status: 'valid', count };
}

function looksTruncated(error: Error, content: string): boolean {
  if (/Unexpected end|Unterminated string/iu.test(error.message)) return true;
  const position = /position (\d+)/iu.exec(error.message)?.[1];
  return position !== undefined && Number(position) >= Math.max(0, content.length - 1);
}

function analyzeTrajectory(
  file: string,
  source: Buffer,
): LoopTrajectoryTailInspection | RepairableAnalysis {
  const lastNewline = source.lastIndexOf(0x0a);
  const prefix = source.subarray(0, lastNewline + 1);
  const complete = parseCompleteLines(prefix.toString('utf8'));
  if (complete.status === 'invalid') {
    return { status: 'invalid', file, line: complete.line, message: complete.message };
  }
  if (lastNewline === source.length - 1) return { status: 'clean', file };

  const tail = source.subarray(lastNewline + 1);
  const tailText = tail.toString('utf8');
  const line = complete.count + 1;
  let reason: 'incomplete-json' | 'missing-newline';
  let target: Buffer;
  try {
    JSON.parse(tailText.endsWith('\r') ? tailText.slice(0, -1) : tailText);
    reason = 'missing-newline';
    target = Buffer.concat([source, Buffer.from('\n')]);
  } catch (error) {
    if (!looksTruncated(error as Error, tailText)) {
      return { status: 'invalid', file, line, message: (error as Error).message };
    }
    reason = 'incomplete-json';
    target = prefix;
  }
  const inspection: Extract<LoopTrajectoryTailInspection, { status: 'repairable' }> = {
    status: 'repairable',
    file,
    reason,
    line,
    originalHash: sha256Buffer(source),
    targetHash: sha256Buffer(target),
    tailHash: sha256Buffer(tail),
    discardedBytes: reason === 'incomplete-json' ? tail.length : 0,
  };
  return { inspection, targetContent: target.toString('utf8') };
}

async function inspectFile(
  paths: LoopProjectPaths,
  name: string,
): Promise<LoopTrajectoryTailInspection | RepairableAnalysis> {
  const file = trajectoryFile(paths, name);
  await resolveContainedLoopPath(loopStorageRoot(paths, file), file);
  const runtimeDir = loopChangeRuntimeDir(paths, name);
  const content = await readLoopTrajectoryText(runtimeDir, LOOP_RUN_STORAGE.trajectoryRef);
  return content === null
    ? { status: 'clean', file }
    : analyzeTrajectory(file, Buffer.from(content));
}

export async function inspectLoopTrajectoryTail(
  paths: LoopProjectPaths,
  name: string,
): Promise<LoopTrajectoryTailInspection> {
  const result = await inspectFile(paths, name);
  return 'inspection' in result ? result.inspection : result;
}

export async function assertLoopTrajectoryHealthy(
  paths: LoopProjectPaths,
  name: string,
): Promise<void> {
  const inspection = await inspectLoopTrajectoryTail(paths, name);
  if (inspection.status !== 'clean') throw new LoopTrajectoryRepairRequiredError(inspection);
}

export async function repairLoopTrajectoryTail(
  paths: LoopProjectPaths,
  name: string,
  hooks?: LoopTrajectoryRepairHooks,
): Promise<Extract<LoopTrajectoryTailInspection, { status: 'repairable' }> | null> {
  return withLoopMutationLock(paths, `repair trajectory tail for ${name}`, async () => {
    const result = await inspectFile(paths, name);
    if (!('inspection' in result)) {
      if (result.status === 'clean') return null;
      throw new LoopTrajectoryRepairRequiredError(result);
    }
    try {
      await replaceLoopTrajectoryText(
        loopChangeRuntimeDir(paths, name),
        LOOP_RUN_STORAGE.trajectoryRef,
        result.targetContent,
        result.inspection.originalHash,
        { beforeCommit: hooks?.beforeCommit },
      );
    } catch (error) {
      if (/changed (?:before|while)/iu.test((error as Error).message)) {
        throw new Error(
          `Loop trajectory changed while preparing tail repair for ${name}; inspect it again before retrying`,
          { cause: error },
        );
      }
      throw error;
    }
    const repaired = await inspectLoopTrajectoryTail(paths, name);
    if (repaired.status !== 'clean') {
      throw new Error(`Loop trajectory tail repair did not produce a clean file for ${name}`);
    }
    return result.inspection;
  });
}
