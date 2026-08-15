import { promises as fs } from 'fs';
import path from 'path';

import {
  assertPipelineLayoutReadable,
  assertPipelineLayoutWritable,
  pipelineProjectRelative,
} from './pipeline-layout.js';
import {
  ensurePipelineProjectDirectory,
  inspectPipelineProjectTarget,
} from './pipeline-protected-path.js';

export interface PipelineChangeDirectory {
  label: string;
  directory: string;
}

export interface FindPipelineArchiveChangeDirectoryOptions {
  preferredArchiveName?: string;
  skipExactCompatibility?: boolean;
}

export function openSpecChangeNameError(name: string | undefined): string | null {
  if (!name) return 'Change name cannot be empty';
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(name)) {
    return `Invalid change name: '${name}'\nValid format: lowercase kebab-case (a-z, 0-9, single hyphens)`;
  }
  if (name.includes('..')) return "Change name cannot contain '..' (path traversal not allowed)";
  return null;
}

export function assertOpenSpecChangeName(name: string | undefined): asserts name is string {
  const error = openSpecChangeNameError(name);
  if (error) throw new Error(error);
}

function changeDirectory(projectRoot: string, directory: string): PipelineChangeDirectory {
  return {
    label: pipelineProjectRelative(projectRoot, directory),
    directory,
  };
}

async function inspectChangeDirectory(
  projectRoot: string,
  directory: string,
  label: string,
): Promise<{ change: PipelineChangeDirectory; exists: boolean; stateExists: boolean }> {
  const change = changeDirectory(projectRoot, directory);
  const inspection = await inspectPipelineProjectTarget(projectRoot, directory, {
    label,
    expected: 'directory',
  });
  if (!inspection.exists) return { change, exists: false, stateExists: false };
  const state = await inspectPipelineProjectTarget(
    projectRoot,
    path.join(directory, '.owner.yaml'),
    {
      label: `${label} state`,
      expected: 'file',
    },
  );
  return { change, exists: true, stateExists: state.exists };
}

function archiveNameMatchesChange(entryName: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${escaped}$`, 'u').test(entryName);
}

async function findArchiveChangeDirectory(
  projectRoot: string,
  archiveDir: string,
  name: string,
  options: Pick<FindPipelineArchiveChangeDirectoryOptions, 'skipExactCompatibility'> = {},
): Promise<PipelineChangeDirectory | null> {
  if (!options.skipExactCompatibility) {
    const exact = await inspectChangeDirectory(
      projectRoot,
      path.join(archiveDir, name),
      `Pipeline archived change ${name}`,
    );
    if (exact.exists) return exact.change;
  }

  const archive = await inspectPipelineProjectTarget(projectRoot, archiveDir, {
    label: 'Pipeline archive directory',
    expected: 'directory',
  });
  if (!archive.exists) return null;

  const matches: PipelineChangeDirectory[] = [];
  for (const entry of await fs.readdir(archiveDir, { withFileTypes: true })) {
    if (!archiveNameMatchesChange(entry.name, name)) continue;
    const candidate = await inspectChangeDirectory(
      projectRoot,
      path.join(archiveDir, entry.name),
      `Pipeline archived change ${entry.name}`,
    );
    if (candidate.exists && candidate.stateExists) matches.push(candidate.change);
  }
  return matches.sort((left, right) => right.directory.localeCompare(left.directory))[0] ?? null;
}

export async function inspectPipelineActiveChangeDirectory(
  name: string,
  projectRoot = process.cwd(),
): Promise<PipelineChangeDirectory & { exists: boolean; stateExists: boolean }> {
  assertOpenSpecChangeName(name);
  const layout = await assertPipelineLayoutReadable(projectRoot);
  const inspection = await inspectChangeDirectory(
    layout.projectRoot,
    path.join(layout.changesDir, name),
    `Pipeline active change ${name}`,
  );
  return {
    ...inspection.change,
    exists: inspection.exists,
    stateExists: inspection.stateExists,
  };
}

export async function ensurePipelineActiveChangeDirectory(
  name: string,
  projectRoot = process.cwd(),
): Promise<PipelineChangeDirectory> {
  assertOpenSpecChangeName(name);
  const layout = await assertPipelineLayoutWritable(projectRoot);
  const directory = path.join(layout.changesDir, name);
  const inspection = await inspectChangeDirectory(
    layout.projectRoot,
    directory,
    `Pipeline active change ${name}`,
  );
  if (!inspection.exists) {
    await ensurePipelineProjectDirectory(
      layout.projectRoot,
      directory,
      `Pipeline active change ${name}`,
    );
  }
  return inspection.change;
}

export async function findPipelineArchiveChangeDirectory(
  name: string,
  projectRoot = process.cwd(),
  options: FindPipelineArchiveChangeDirectoryOptions = {},
): Promise<PipelineChangeDirectory | null> {
  assertOpenSpecChangeName(name);
  const layout = await assertPipelineLayoutReadable(projectRoot);
  if (options.preferredArchiveName !== undefined) {
    const preferred = options.preferredArchiveName;
    if (preferred !== name && !archiveNameMatchesChange(preferred, name)) {
      throw new Error(
        `Pipeline preferred archive name '${preferred}' does not belong to change '${name}'`,
      );
    }
    const inspection = await inspectChangeDirectory(
      layout.projectRoot,
      path.join(layout.archiveDir, preferred),
      `Pipeline preferred archived change ${preferred}`,
    );
    return inspection.exists && inspection.stateExists ? inspection.change : null;
  }
  return findArchiveChangeDirectory(layout.projectRoot, layout.archiveDir, name, options);
}

export async function resolvePipelineChangeDirectory(
  name: string,
  projectRoot = process.cwd(),
): Promise<PipelineChangeDirectory> {
  assertOpenSpecChangeName(name);
  const layout = await assertPipelineLayoutReadable(projectRoot);
  const active = await inspectChangeDirectory(
    layout.projectRoot,
    path.join(layout.changesDir, name),
    `Pipeline active change ${name}`,
  );
  if (active.exists) return active.change;

  const archived = await findArchiveChangeDirectory(layout.projectRoot, layout.archiveDir, name);
  if (archived) return archived;

  // Fallback: return the active path even if the change doesn't exist in active or archive.
  // This is intentional — matches 0.3.9 behavior where downstream commands report
  // "not found" errors with the expected path, rather than failing silently here.
  return active.change;
}
