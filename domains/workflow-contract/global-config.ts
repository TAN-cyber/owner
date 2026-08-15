import path from 'path';
import { parseDocument } from 'yaml';

import { atomicWriteContainedText } from './contained-atomic-write.js';
import {
  defaultWorkflowProjectConfig,
  mergeWorkflowProjectConfigDocument,
  parseWorkflowProjectConfigDocument,
  renderStructuredProjectConfig,
  WORKFLOW_PROJECT_CONFIG_MAX_BYTES,
} from './project-config.js';
import { readProtectedProjectFile } from './protected-project-path.js';
import type {
  ProjectConfigLanguage,
  WorkflowGlobalConfig,
  WorkflowProjectConfig,
} from './types.js';

export const WORKFLOW_GLOBAL_CONFIG_PATH = '.owner/config.yaml';

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function parseRoot(source: string): Record<string, unknown> {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(`Invalid global Owner config: ${document.errors[0].message}`);
  }
  const value = document.toJS() as unknown;
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid global Owner config: root must be a mapping');
  }
  return value as Record<string, unknown>;
}

function toProjectConfig(config: WorkflowGlobalConfig): WorkflowProjectConfig {
  if (config.loop?.pending_root_move) {
    throw new Error('Global Owner config cannot contain loop.pending_root_move');
  }
  const loop = config.loop
    ? (({ pending_root_move: _pendingRootMove, ...value }) => value)(config.loop)
    : undefined;
  return {
    ...config,
    schema: 'owner.project.v1',
    ...(loop ? { loop } : {}),
  };
}

function toGlobalConfig(config: WorkflowProjectConfig): WorkflowGlobalConfig {
  if (config.loop?.pending_root_move) {
    throw new Error('Global Owner config cannot contain loop.pending_root_move');
  }
  const loop = config.loop
    ? (({ pending_root_move: _pendingRootMove, ...value }) => value)(config.loop)
    : undefined;
  return {
    ...config,
    schema: 'owner.global.v1',
    ...(loop ? { loop } : {}),
  };
}

function parseCompleteGlobalConfig(value: Record<string, unknown>): WorkflowGlobalConfig {
  const parsed = parseWorkflowProjectConfigDocument(
    JSON.stringify({ ...value, schema: 'owner.project.v1' }),
  ).config;
  if (!parsed) throw new Error('Invalid global Owner config: workflow template is incomplete');
  return toGlobalConfig(parsed);
}

function parseLegacyGlobalConfig(source: string): WorkflowGlobalConfig | null {
  const document = parseWorkflowProjectConfigDocument(source, {
    allowPartialProject: true,
    allowMissingLoopFields: true,
  });
  if (!document.loop && !document.pipeline) return null;
  const workflow = document.loop ? 'loop' : 'pipeline';
  const language = document.loop?.language ?? document.pipeline?.language ?? 'en';
  const defaults = defaultWorkflowProjectConfig(document.loop?.artifact_root ?? 'docs', language);
  return {
    schema: 'owner.global.v1',
    default_workflow: workflow,
    workflows: [workflow],
    ambient_resume: document.ambient_resume,
    ...(document.loop ? { loop: { ...defaults.loop, ...document.loop } } : {}),
    ...(document.pipeline ? { pipeline: document.pipeline } : {}),
  };
}

export function parseWorkflowGlobalConfig(source: string): WorkflowGlobalConfig | null {
  const value = parseRoot(source);
  if (Object.keys(value).length === 0) return null;
  if (value.schema === undefined) return parseLegacyGlobalConfig(source);
  if (value.schema !== 'owner.global.v1') {
    throw new Error('Unsupported Owner global schema');
  }
  return parseCompleteGlobalConfig(value);
}

export async function readWorkflowGlobalConfig(
  homeDir: string,
): Promise<WorkflowGlobalConfig | null> {
  try {
    const source = await readProtectedProjectFile(
      homeDir,
      WORKFLOW_GLOBAL_CONFIG_PATH,
      WORKFLOW_PROJECT_CONFIG_MAX_BYTES,
      { label: 'global Owner config' },
    );
    return parseWorkflowGlobalConfig(source.bytes.toString('utf8'));
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export async function writeWorkflowGlobalConfig(
  homeDir: string,
  config: WorkflowGlobalConfig,
): Promise<void> {
  const configPath = path.join(homeDir, ...WORKFLOW_GLOBAL_CONFIG_PATH.split('/'));
  let existing: Record<string, unknown> = {};
  try {
    const source = await readProtectedProjectFile(
      homeDir,
      WORKFLOW_GLOBAL_CONFIG_PATH,
      WORKFLOW_PROJECT_CONFIG_MAX_BYTES,
      { label: 'global Owner config' },
    );
    existing = parseRoot(source.bytes.toString('utf8'));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const merged = mergeWorkflowProjectConfigDocument(
    { ...existing, schema: 'owner.project.v1' },
    toProjectConfig(config),
  );
  merged.schema = 'owner.global.v1';
  const language: ProjectConfigLanguage =
    config.loop?.language === 'zh-CN' || config.pipeline?.language === 'zh-CN' ? 'zh-CN' : 'en';
  const output = renderStructuredProjectConfig(merged, language);
  parseWorkflowGlobalConfig(output);
  await atomicWriteContainedText(configPath, output, { containedRoot: homeDir });
}

export { toGlobalConfig as workflowGlobalConfigFromProjectConfig };
export { toProjectConfig as workflowProjectConfigFromGlobalConfig };
