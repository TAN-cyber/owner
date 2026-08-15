import type { EngineAction, RunState } from './types.js';
import type { GuardrailDefinition } from '../skill/types.js';

export type GuardrailResult = { allowed: true } | { allowed: false; reason: string };

export function checkAction(
  action: EngineAction,
  state: RunState,
  guardrails: GuardrailDefinition,
  confirmations: ReadonlySet<string>,
): GuardrailResult {
  if (state.iteration >= guardrails.maxIterations) {
    return { allowed: false, reason: `Iteration budget exhausted: ${guardrails.maxIterations}` };
  }
  if (action.type === 'invoke_skill' && !guardrails.allowedSkills.includes(action.ref ?? '')) {
    return { allowed: false, reason: `Skill is not allowed: ${action.ref ?? '(missing)'}` };
  }
  if (action.type === 'call_tool' && !guardrails.allowedTools.includes(action.ref ?? '')) {
    return { allowed: false, reason: `Tool is not allowed: ${action.ref ?? '(missing)'}` };
  }
  if (action.type === 'handoff' && !guardrails.allowedAgents.includes(action.ref ?? '')) {
    return { allowed: false, reason: `Agent is not allowed: ${action.ref ?? '(missing)'}` };
  }
  if (
    action.ref &&
    guardrails.confirmationRequiredFor.includes(action.ref) &&
    !confirmations.has(action.ref)
  ) {
    return { allowed: false, reason: `User confirmation required for: ${action.ref}` };
  }
  const retries = state.retries[action.id] ?? 0;
  if (retries > guardrails.maxRetriesPerAction) {
    return { allowed: false, reason: `Retry budget exhausted for action: ${action.id}` };
  }
  return { allowed: true };
}
