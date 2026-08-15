import path from 'path';
import type { SkillPackage, StepAction } from './types.js';

function validatesAction(
  action: StepAction,
  pkg: SkillPackage,
  errors: string[],
  stepId: string,
): void {
  if (
    action.type === 'invoke_skill' &&
    !pkg.definition.skills.some((item) => item.id === action.ref)
  ) {
    errors.push(`step ${stepId} references undeclared skill: ${action.ref ?? '(missing)'}`);
  }
  if (action.type === 'call_tool' && !pkg.definition.tools.some((item) => item.id === action.ref)) {
    errors.push(`step ${stepId} references undeclared tool: ${action.ref ?? '(missing)'}`);
  }
  if (action.type === 'handoff' && !pkg.definition.agents.some((item) => item.id === action.ref)) {
    errors.push(`step ${stepId} references undeclared agent: ${action.ref ?? '(missing)'}`);
  }
  if (action.type === 'ask_user' && !action.question) {
    errors.push(`step ${stepId} ask_user action requires question`);
  }
}

export function validateSkillPackage(pkg: SkillPackage): string[] {
  const errors: string[] = [];
  const { definition, guardrails, evals } = pkg;

  if (definition.apiVersion !== 'owner/v1alpha1') errors.push('unsupported apiVersion');
  if (definition.kind !== 'Skill') errors.push('kind must be Skill');
  if (!definition.metadata.name) errors.push('metadata.name is required');
  if (!definition.goal.statement) errors.push('goal.statement is required');
  if (guardrails.maxIterations < 1) errors.push('maxIterations must be at least 1');
  if (guardrails.maxRetriesPerAction < 0) errors.push('maxRetriesPerAction must not be negative');

  const steps = definition.orchestration.steps ?? [];
  if (definition.orchestration.mode === 'adaptive') {
    if (definition.orchestration.entry || steps.length > 0) {
      errors.push('adaptive orchestration must not define entry or steps');
    }
  } else {
    const ids = new Set<string>();
    for (const step of steps) {
      if (ids.has(step.id)) errors.push(`duplicate step id: ${step.id}`);
      ids.add(step.id);
      validatesAction(step.action, pkg, errors, step.id);
    }
    if (!definition.orchestration.entry || !ids.has(definition.orchestration.entry)) {
      errors.push(
        `orchestration.entry references unknown step: ${definition.orchestration.entry ?? '(missing)'}`,
      );
    }
    for (const step of steps) {
      if (step.next && !ids.has(step.next))
        errors.push(`step ${step.id} has unknown next step: ${step.next}`);
      for (const evalId of step.completionEvals ?? []) {
        if (!evals.some((item) => item.id === evalId)) {
          errors.push(`step ${step.id} references unknown eval: ${evalId}`);
        }
      }
    }
  }

  for (const tool of definition.tools) {
    if (tool.kind !== 'script') continue;
    const normalized = path.posix.normalize(tool.source.replaceAll('\\', '/'));
    if (path.isAbsolute(tool.source) || normalized === '..' || normalized.startsWith('../')) {
      errors.push(`script tool ${tool.id} must reference a relative path inside the Skill package`);
    }
  }

  for (const id of guardrails.allowedSkills) {
    if (!definition.skills.some((item) => item.id === id))
      errors.push(`guardrails allow undeclared skill: ${id}`);
  }
  for (const id of guardrails.allowedAgents) {
    if (!definition.agents.some((item) => item.id === id))
      errors.push(`guardrails allow undeclared agent: ${id}`);
  }
  for (const id of guardrails.allowedTools) {
    if (!definition.tools.some((item) => item.id === id))
      errors.push(`guardrails allow undeclared tool: ${id}`);
  }

  return errors;
}
