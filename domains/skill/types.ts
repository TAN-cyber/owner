export type OrchestrationMode = 'deterministic' | 'adaptive';
export type ActionType = 'invoke_skill' | 'call_tool' | 'handoff' | 'ask_user' | 'checkpoint';
export type SkillPackageKind = 'skill' | 'runtime';

export interface NamedContract {
  name: string;
  description: string;
  required?: boolean;
}

export interface SkillReference {
  id: string;
  source?: string;
  version?: string;
}

export interface AgentDefinition {
  id: string;
  role: string;
  instructions?: string;
}

export interface ToolDefinition {
  id: string;
  kind: 'function' | 'mcp' | 'script' | 'agent';
  source: string;
  sideEffect: 'none' | 'read' | 'write' | 'external';
  requiresConfirmation?: boolean;
}

export interface StepAction {
  type: ActionType;
  ref?: string;
  prompt?: string;
  question?: string;
  options?: string[];
}

export interface SkillStep {
  id: string;
  action: StepAction;
  next?: string;
  completionEvals?: string[];
}

export interface SkillDefinition {
  apiVersion: 'owner/v1alpha1';
  kind: 'Skill';
  metadata: {
    name: string;
    version: string;
    description: string;
  };
  goal: {
    statement: string;
    inputs: NamedContract[];
    outputs: NamedContract[];
    success: string[];
  };
  orchestration: {
    mode: OrchestrationMode;
    entry?: string;
    steps?: SkillStep[];
  };
  skills: SkillReference[];
  agents: AgentDefinition[];
  tools: ToolDefinition[];
}

export interface GuardrailDefinition {
  allowedSkills: string[];
  allowedAgents: string[];
  allowedTools: string[];
  maxIterations: number;
  maxRetriesPerAction: number;
  confirmationRequiredFor: string[];
}

export interface RuntimeEvalDefinition {
  id: string;
  scope: 'progress' | 'step' | 'completion';
  type: 'artifact_exists' | 'state_equals';
  artifact?: string;
  field?: string;
  equals?: string;
}

export interface SkillPackage {
  root: string;
  packageKind?: SkillPackageKind;
  definition: SkillDefinition;
  guardrails: GuardrailDefinition;
  evals: RuntimeEvalDefinition[];
}
