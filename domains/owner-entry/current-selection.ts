import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

import { readFileRaceSafe } from '../../platform/fs/race-safe-read.js';

import type { OwnerWorkflow } from './types.js';

export const OWNER_CURRENT_SELECTION_SCHEMA = 'owner.selection.v2' as const;
export const OWNER_CURRENT_SELECTION_MAX_BYTES = 16 * 1024;

export interface OwnerCurrentSelection {
  schema: typeof OWNER_CURRENT_SELECTION_SCHEMA;
  workflow: OwnerWorkflow;
  change: string;
  branch: string | null;
}

export interface LegacyPipelineSelection {
  version: 1;
  change: string;
  branch: string | null;
}

export type OwnerCurrentSelectionRead =
  | { status: 'missing' }
  | { status: 'selected'; selection: OwnerCurrentSelection; legacy: boolean };

export function ownerCurrentSelectionFile(projectRoot: string): string {
  return path.join(projectRoot, '.owner', 'current-change.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validBranch(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function parseSelection(source: string): { selection: OwnerCurrentSelection; legacy: boolean } {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(
      `current change selection contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!isRecord(value)) {
    throw new Error('current change selection must be a JSON object');
  }

  if (value.version === 1) {
    if (typeof value.change !== 'string') {
      throw new Error('legacy current change selection change must be a string');
    }
    if (value.branch !== undefined && !validBranch(value.branch)) {
      throw new Error('legacy current change selection branch must be a string or null');
    }
    return {
      selection: {
        schema: OWNER_CURRENT_SELECTION_SCHEMA,
        workflow: 'pipeline',
        change: value.change,
        branch: (value.branch as string | null | undefined) ?? null,
      },
      legacy: true,
    };
  }

  if (value.schema !== OWNER_CURRENT_SELECTION_SCHEMA) {
    throw new Error(`current change selection schema must be ${OWNER_CURRENT_SELECTION_SCHEMA}`);
  }
  if (value.workflow !== 'loop' && value.workflow !== 'pipeline') {
    throw new Error('current change selection workflow must be loop or pipeline');
  }
  if (typeof value.change !== 'string') {
    throw new Error('current change selection change must be a string');
  }
  if (!validBranch(value.branch)) {
    throw new Error('current change selection branch must be a string or null');
  }
  if (value.workflow === 'loop' && value.branch !== null) {
    throw new Error('Loop current change selection branch must be null');
  }
  return { selection: value as unknown as OwnerCurrentSelection, legacy: false };
}

export async function readOwnerCurrentSelection(
  projectRoot: string,
): Promise<OwnerCurrentSelectionRead> {
  let source: string;
  try {
    const file = ownerCurrentSelectionFile(projectRoot);
    const { bytes } = await readFileRaceSafe(file, OWNER_CURRENT_SELECTION_MAX_BYTES, {
      label: 'current change selection',
    });
    source = bytes.toString('utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
    throw new Error(
      `cannot read current change selection: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const parsed = parseSelection(source);
  return { status: 'selected', ...parsed };
}

export async function writeOwnerCurrentSelection(
  projectRoot: string,
  selection: OwnerCurrentSelection,
): Promise<void> {
  const parsed = parseSelection(JSON.stringify(selection));
  if (parsed.legacy) throw new Error('cannot write a legacy current change selection');

  const file = ownerCurrentSelectionFile(projectRoot);
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(temporary, `${JSON.stringify(parsed.selection, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

export async function migrateLegacyPipelineSelection(projectRoot: string): Promise<boolean> {
  const current = await readOwnerCurrentSelection(projectRoot);
  if (current.status === 'missing' || !current.legacy) return false;
  await writeOwnerCurrentSelection(projectRoot, current.selection);
  return true;
}

export async function clearOwnerCurrentSelection(projectRoot: string): Promise<void> {
  await fs.rm(ownerCurrentSelectionFile(projectRoot), { force: true });
}

export async function clearOwnerCurrentSelectionIf(
  projectRoot: string,
  workflow: OwnerWorkflow,
  change: string,
): Promise<boolean> {
  const current = await readOwnerCurrentSelection(projectRoot);
  if (
    current.status !== 'selected' ||
    current.selection.workflow !== workflow ||
    current.selection.change !== change
  ) {
    return false;
  }
  await clearOwnerCurrentSelection(projectRoot);
  return true;
}
