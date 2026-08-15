import { promises as fs } from 'fs';
import path from 'path';
import { parse } from 'yaml';
import type {
  GuardrailDefinition,
  RuntimeEvalDefinition,
  SkillDefinition,
  SkillPackageKind,
  SkillPackage,
} from './types.js';

type YamlObject = Record<string, unknown>;

const ACTION_TYPES = ['invoke_skill', 'call_tool', 'handoff', 'ask_user', 'checkpoint'] as const;
const ORCHESTRATION_MODES = ['deterministic', 'adaptive'] as const;
const TOOL_KINDS = ['function', 'mcp', 'script', 'agent'] as const;
const TOOL_SIDE_EFFECTS = ['none', 'read', 'write', 'external'] as const;
const EVAL_SCOPES = ['progress', 'step', 'completion'] as const;
const EVAL_TYPES = ['artifact_exists', 'state_equals'] as const;

function invalidDocument(filePath: string, fieldPath: string, message: string): Error {
  return new Error(`${filePath}: ${fieldPath} ${message}`);
}

function assertObject(
  value: unknown,
  filePath: string,
  fieldPath = 'document',
): asserts value is YamlObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidDocument(filePath, fieldPath, 'must be an object');
  }
}

function assertArray(
  value: unknown,
  filePath: string,
  fieldPath: string,
): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw invalidDocument(filePath, fieldPath, 'must be an array');
  }
}

function assertString(
  value: unknown,
  filePath: string,
  fieldPath: string,
): asserts value is string {
  if (typeof value !== 'string') {
    throw invalidDocument(filePath, fieldPath, 'must be a string');
  }
}

function assertOptionalString(
  document: YamlObject,
  field: string,
  filePath: string,
  objectPath: string,
): void {
  if (field in document) {
    assertString(document[field], filePath, `${objectPath}.${field}`);
  }
}

function assertOptionalBoolean(
  document: YamlObject,
  field: string,
  filePath: string,
  objectPath: string,
): void {
  if (field in document && typeof document[field] !== 'boolean') {
    throw invalidDocument(filePath, `${objectPath}.${field}`, 'must be a boolean');
  }
}

function assertEnum(
  value: unknown,
  values: readonly string[],
  filePath: string,
  fieldPath: string,
): void {
  if (typeof value !== 'string' || !values.includes(value)) {
    throw invalidDocument(filePath, fieldPath, `must be one of ${values.join(', ')}`);
  }
}

function assertStringArray(value: unknown, filePath: string, fieldPath: string): void {
  assertArray(value, filePath, fieldPath);
  value.forEach((entry, index) => {
    assertString(entry, filePath, `${fieldPath}[${index}]`);
  });
}

function validateNamedContract(value: unknown, filePath: string, fieldPath: string): void {
  assertObject(value, filePath, fieldPath);
  assertString(value.name, filePath, `${fieldPath}.name`);
  assertString(value.description, filePath, `${fieldPath}.description`);
  assertOptionalBoolean(value, 'required', filePath, fieldPath);
}

function validateSkillReference(value: unknown, filePath: string, fieldPath: string): void {
  assertObject(value, filePath, fieldPath);
  assertString(value.id, filePath, `${fieldPath}.id`);
  assertOptionalString(value, 'source', filePath, fieldPath);
  assertOptionalString(value, 'version', filePath, fieldPath);
}

function validateAgent(value: unknown, filePath: string, fieldPath: string): void {
  assertObject(value, filePath, fieldPath);
  assertString(value.id, filePath, `${fieldPath}.id`);
  assertString(value.role, filePath, `${fieldPath}.role`);
  assertOptionalString(value, 'instructions', filePath, fieldPath);
}

function validateTool(value: unknown, filePath: string, fieldPath: string): void {
  assertObject(value, filePath, fieldPath);
  assertString(value.id, filePath, `${fieldPath}.id`);
  assertEnum(value.kind, TOOL_KINDS, filePath, `${fieldPath}.kind`);
  assertString(value.source, filePath, `${fieldPath}.source`);
  assertEnum(value.sideEffect, TOOL_SIDE_EFFECTS, filePath, `${fieldPath}.sideEffect`);
  assertOptionalBoolean(value, 'requiresConfirmation', filePath, fieldPath);
}

function validateAction(value: unknown, filePath: string, fieldPath: string): void {
  assertObject(value, filePath, fieldPath);
  assertEnum(value.type, ACTION_TYPES, filePath, `${fieldPath}.type`);
  assertOptionalString(value, 'ref', filePath, fieldPath);
  assertOptionalString(value, 'prompt', filePath, fieldPath);
  assertOptionalString(value, 'question', filePath, fieldPath);
  if ('options' in value) {
    assertStringArray(value.options, filePath, `${fieldPath}.options`);
  }
}

function validateStep(value: unknown, filePath: string, fieldPath: string): void {
  assertObject(value, filePath, fieldPath);
  assertString(value.id, filePath, `${fieldPath}.id`);
  validateAction(value.action, filePath, `${fieldPath}.action`);
  assertOptionalString(value, 'next', filePath, fieldPath);
  if ('completionEvals' in value) {
    assertStringArray(value.completionEvals, filePath, `${fieldPath}.completionEvals`);
  }
}

function validateGoal(value: unknown, filePath: string): void {
  const fieldPath = 'goal';
  assertObject(value, filePath, fieldPath);
  assertString(value.statement, filePath, `${fieldPath}.statement`);
  assertArray(value.inputs, filePath, `${fieldPath}.inputs`);
  value.inputs.forEach((entry, index) => {
    validateNamedContract(entry, filePath, `${fieldPath}.inputs[${index}]`);
  });
  assertArray(value.outputs, filePath, `${fieldPath}.outputs`);
  value.outputs.forEach((entry, index) => {
    validateNamedContract(entry, filePath, `${fieldPath}.outputs[${index}]`);
  });
  assertStringArray(value.success, filePath, `${fieldPath}.success`);
}

function validateOrchestration(value: unknown, filePath: string): void {
  const fieldPath = 'orchestration';
  assertObject(value, filePath, fieldPath);
  assertEnum(value.mode, ORCHESTRATION_MODES, filePath, `${fieldPath}.mode`);
  assertOptionalString(value, 'entry', filePath, fieldPath);
  if ('steps' in value) {
    assertArray(value.steps, filePath, `${fieldPath}.steps`);
    value.steps.forEach((entry, index) => {
      validateStep(entry, filePath, `${fieldPath}.steps[${index}]`);
    });
  }
}

function narrowSkillDefinition(document: unknown, filePath: string): SkillDefinition {
  assertObject(document, filePath);
  assertEnum(document.apiVersion, ['owner/v1alpha1'], filePath, 'apiVersion');
  assertEnum(document.kind, ['Skill'], filePath, 'kind');

  assertObject(document.metadata, filePath, 'metadata');
  assertString(document.metadata.name, filePath, 'metadata.name');
  assertString(document.metadata.version, filePath, 'metadata.version');
  assertString(document.metadata.description, filePath, 'metadata.description');
  validateGoal(document.goal, filePath);
  validateOrchestration(document.orchestration, filePath);

  assertArray(document.skills, filePath, 'skills');
  document.skills.forEach((entry, index) => {
    validateSkillReference(entry, filePath, `skills[${index}]`);
  });
  assertArray(document.agents, filePath, 'agents');
  document.agents.forEach((entry, index) => {
    validateAgent(entry, filePath, `agents[${index}]`);
  });
  assertArray(document.tools, filePath, 'tools');
  document.tools.forEach((entry, index) => {
    validateTool(entry, filePath, `tools[${index}]`);
  });

  return document as unknown as SkillDefinition;
}

function narrowGuardrails(document: unknown, filePath: string): Partial<GuardrailDefinition> {
  assertObject(document, filePath);

  for (const field of [
    'allowedSkills',
    'allowedAgents',
    'allowedTools',
    'confirmationRequiredFor',
  ]) {
    if (field in document) {
      assertStringArray(document[field], filePath, field);
    }
  }
  for (const field of ['maxIterations', 'maxRetriesPerAction']) {
    if (
      field in document &&
      (typeof document[field] !== 'number' || !Number.isFinite(document[field]))
    ) {
      throw invalidDocument(filePath, field, 'must be a finite number');
    }
  }

  return document as Partial<GuardrailDefinition>;
}

function narrowEvalDocument(
  document: unknown,
  filePath: string,
): { runtime?: RuntimeEvalDefinition[] } {
  assertObject(document, filePath);
  if ('runtime' in document) {
    narrowRuntimeEvals(document.runtime, filePath, 'runtime');
  }
  return document as { runtime?: RuntimeEvalDefinition[] };
}

function narrowRuntimeEvals(
  value: unknown,
  filePath: string,
  fieldPath: string,
): RuntimeEvalDefinition[] {
  assertArray(value, filePath, fieldPath);
  value.forEach((entry, index) => {
    const itemPath = `${fieldPath}[${index}]`;
    assertObject(entry, filePath, itemPath);
    assertString(entry.id, filePath, `${itemPath}.id`);
    assertEnum(entry.scope, EVAL_SCOPES, filePath, `${itemPath}.scope`);
    assertEnum(entry.type, EVAL_TYPES, filePath, `${itemPath}.type`);
    assertOptionalString(entry, 'artifact', filePath, itemPath);
    assertOptionalString(entry, 'field', filePath, itemPath);
    assertOptionalString(entry, 'equals', filePath, itemPath);
  });
  return value as RuntimeEvalDefinition[];
}

async function readYaml(filePath: string): Promise<unknown> {
  const source = await fs.readFile(filePath, 'utf8');
  try {
    return parse(source) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw invalidDocument(filePath, 'document', message);
  }
}

async function readOptionalYaml(filePath: string): Promise<unknown | null> {
  try {
    return await readYaml(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function yamlFileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function readRuntimeChecks(ownerRoot: string): Promise<{
  document: { runtime?: RuntimeEvalDefinition[] } | null;
}> {
  const checksPath = path.join(ownerRoot, 'checks.yaml');
  const evalsPath = path.join(ownerRoot, 'evals.yaml');
  const [hasChecks, hasEvals] = await Promise.all([
    yamlFileExists(checksPath),
    yamlFileExists(evalsPath),
  ]);

  if (hasEvals) {
    throw new Error(`${evalsPath}: evals.yaml is no longer supported; use checks.yaml`);
  }
  if (hasChecks) {
    return {
      document: narrowEvalDocument(await readYaml(checksPath), checksPath),
    };
  }
  return { document: null };
}

async function loadPackageFromLayout(options: {
  root: string;
  controlRoot: string;
  packageKind: SkillPackageKind;
  requireSkillMarkdown: boolean;
}): Promise<SkillPackage> {
  const packageRoot = path.resolve(options.root);
  const controlRoot = path.resolve(options.controlRoot);

  if (options.requireSkillMarkdown) {
    await fs.access(path.join(packageRoot, 'SKILL.md'));
  }

  const skillPath = path.join(controlRoot, 'skill.yaml');
  const guardrailsPath = path.join(controlRoot, 'guardrails.yaml');
  const definition = narrowSkillDefinition(await readYaml(skillPath), skillPath);
  const rawGuardrails = await readOptionalYaml(guardrailsPath);
  const guardrailDocument =
    rawGuardrails === null ? null : narrowGuardrails(rawGuardrails, guardrailsPath);
  const runtimeChecks = await readRuntimeChecks(controlRoot);

  const defaultGuardrails: GuardrailDefinition = {
    allowedSkills: definition.skills.map((skill) => skill.id),
    allowedAgents: definition.agents.map((agent) => agent.id),
    allowedTools: definition.tools.map((tool) => tool.id),
    maxIterations: 50,
    maxRetriesPerAction: 3,
    confirmationRequiredFor: definition.tools
      .filter((tool) => tool.requiresConfirmation)
      .map((tool) => tool.id),
  };

  return {
    root: packageRoot,
    packageKind: options.packageKind === 'runtime' ? 'runtime' : undefined,
    definition,
    guardrails: {
      ...defaultGuardrails,
      ...guardrailDocument,
    },
    evals: runtimeChecks.document?.runtime ?? [],
  };
}

export async function loadSkillPackage(root: string): Promise<SkillPackage> {
  const packageRoot = path.resolve(root);
  return loadPackageFromLayout({
    root: packageRoot,
    controlRoot: path.join(packageRoot, 'owner'),
    packageKind: 'skill',
    requireSkillMarkdown: true,
  });
}

export async function loadRuntimePackage(root: string): Promise<SkillPackage> {
  const packageRoot = path.resolve(root);
  return loadPackageFromLayout({
    root: packageRoot,
    controlRoot: packageRoot,
    packageKind: 'runtime',
    requireSkillMarkdown: false,
  });
}

export function loadSkillPackageDocument(
  document: unknown,
  root: string,
  filePath = path.join(root, 'package.json'),
): SkillPackage {
  assertObject(document, filePath);
  const packageKind = document.packageKind === 'runtime' ? 'runtime' : undefined;
  const definition = narrowSkillDefinition(document.definition, filePath);
  const guardrailDocument = narrowGuardrails(document.guardrails, filePath);
  const evals = narrowRuntimeEvals(document.evals, filePath, 'evals');
  const defaultGuardrails: GuardrailDefinition = {
    allowedSkills: definition.skills.map((skill) => skill.id),
    allowedAgents: definition.agents.map((agent) => agent.id),
    allowedTools: definition.tools.map((tool) => tool.id),
    maxIterations: 50,
    maxRetriesPerAction: 3,
    confirmationRequiredFor: definition.tools
      .filter((tool) => tool.requiresConfirmation)
      .map((tool) => tool.id),
  };

  return {
    root: path.resolve(root),
    packageKind,
    definition,
    guardrails: {
      ...defaultGuardrails,
      ...guardrailDocument,
    },
    evals,
  };
}
