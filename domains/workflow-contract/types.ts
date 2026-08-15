export type WorkflowKind = 'owner-five-phase-overlay' | 'owner-loop' | 'workflow-kernel';

export type OwnerProjectWorkflow = 'loop' | 'pipeline';
export type PipelineArtifactLayout = 'legacy' | 'docs';
export type ProjectConfigLanguage = 'en' | 'zh-CN';
export type WorkflowLoopClarificationMode = 'sequential' | 'batch';
export type WorkflowLoopArchiveConfirmation = 'automatic' | 'required';
export type WorkflowLoopRootMoveCleanupKind =
  | 'forward-source'
  | 'restart-staging'
  | 'rollback-destination'
  | 'rollback-staging';

export interface WorkflowLoopRootMoveCleanup {
  kind: WorkflowLoopRootMoveCleanupKind;
  state: 'prepared' | 'quarantined' | 'deleting';
  manifestHash: string;
}

export interface WorkflowLoopPendingRootMove {
  id: string;
  fromArtifactRoot: string;
  toArtifactRoot: string;
  stage: 'copying' | 'ready' | 'switched';
  cleanup?: WorkflowLoopRootMoveCleanup;
}

export interface WorkflowLoopSnapshotConfig {
  include: string[];
  exclude: string[];
  max_files: number;
  max_total_bytes: number;
  max_duration_ms: number;
}

export interface WorkflowHookProjectConfig {
  allow_paths: string[];
}

export interface WorkflowLoopProjectConfig {
  artifact_root: string;
  language: ProjectConfigLanguage;
  clarification_mode: WorkflowLoopClarificationMode;
  archive_confirmation: WorkflowLoopArchiveConfirmation;
  max_verify_failures: number;
  snapshot: WorkflowLoopSnapshotConfig;
  pending_root_move?: WorkflowLoopPendingRootMove;
}

export interface WorkflowPipelineProjectConfig {
  artifact_layout?: PipelineArtifactLayout;
  language?: ProjectConfigLanguage;
  context_compression?: 'off' | 'beta';
  review_mode?: 'off' | 'standard' | 'thorough';
  auto_transition?: boolean;
}

export interface WorkflowProjectConfig {
  schema: 'owner.project.v1';
  default_workflow: OwnerProjectWorkflow;
  workflows?: OwnerProjectWorkflow[];
  ambient_resume: boolean;
  hook?: WorkflowHookProjectConfig;
  loop?: WorkflowLoopProjectConfig;
  pipeline?: WorkflowPipelineProjectConfig;
}

export interface WorkflowGlobalConfig extends Omit<WorkflowProjectConfig, 'schema'> {
  schema: 'owner.global.v1';
}

export interface WorkflowLoopEnabledProjectConfig extends WorkflowProjectConfig {
  loop: WorkflowLoopProjectConfig;
}

/**
 * A strict YAML document plus its normalized managed projection. `value`
 * retains unknown extension fields for lossless read-modify-write updates.
 */
export interface ParsedWorkflowProjectConfigDocument {
  value: Record<string, unknown>;
  config: WorkflowProjectConfig | null;
  ambient_resume: boolean;
  loop?: WorkflowLoopProjectConfig;
  pipeline?: WorkflowPipelineProjectConfig;
}

export type WorkflowNodeKind = 'control' | 'producer' | 'action' | 'handoff' | 'guardrail';

export type WorkflowNodeOperation = 'require' | 'augment' | 'override' | 'disable';

export type WorkflowBindingOperation = 'default' | WorkflowNodeOperation;

export type WorkflowEnforcementLevel = 'guarded' | 'handoff-guarded' | 'evidence-only' | 'advisory';

export type OutputValidationKind =
  | 'evidence-only'
  | 'artifact-exists'
  | 'artifact-structured'
  | 'semantic'
  | 'state-transition';

export interface WorkflowArtifactSchema {
  id: string;
  kind: 'file' | 'directory' | 'state' | 'report';
  required: boolean;
  paths: string[];
  pathBase?: 'project' | 'loop-root' | 'pipeline-openspec-root' | 'pipeline-superpowers-root';
  validations: OutputValidationKind[];
}

export interface WorkflowEvidenceSchema {
  id: string;
  required: boolean;
}

export interface WorkflowOutputSchema {
  id: string;
  description: string;
  artifacts: WorkflowArtifactSchema[];
  evidence: WorkflowEvidenceSchema[];
}

export interface WorkflowSkillBindingInput {
  skill: string;
  operation?: WorkflowBindingOperation;
  reason?: string;
  scope?: 'main' | 'handoff' | 'review';
  enforcement?: WorkflowEnforcementLevel;
}

export interface WorkflowSkillBinding {
  skill: string;
  operation: WorkflowBindingOperation;
  reason?: string;
  scope: 'main' | 'handoff' | 'review';
  enforcement: WorkflowEnforcementLevel;
}

export interface WorkflowGuardrail {
  id: string;
  label: string;
  validation: OutputValidationKind;
}

export interface WorkflowNodeTemplate {
  id: string;
  label: string;
  kind: WorkflowNodeKind;
  responsibility: string;
  optional?: boolean;
  implementation: WorkflowSkillBindingInput & {
    operation: WorkflowBindingOperation;
    scope: 'main' | 'handoff' | 'review';
  };
  requiredSkillCalls?: WorkflowSkillBindingInput[];
  augmentations?: WorkflowSkillBindingInput[];
  satisfies?: string[];
  disabled?: boolean;
  operations: WorkflowNodeOperation[];
  outputSchemas: string[];
  guardrails: WorkflowGuardrail[];
}

export interface WorkflowNodePatch {
  implementation?: WorkflowSkillBindingInput;
  requiredSkillCalls?: WorkflowSkillBindingInput[];
  augmentations?: WorkflowSkillBindingInput[];
  outputSchemas?: string[];
  satisfies?: string[];
  disabled?: boolean;
}

export interface WorkflowDefinitionInput {
  kind: WorkflowKind;
  name: string;
  goal: string;
  nodes?: Record<string, WorkflowNodePatch>;
  customNodes?: WorkflowNodeTemplate[];
  outputSchemas?: WorkflowOutputSchema[];
}

export interface WorkflowNodeProtocol extends WorkflowNodeTemplate {
  implementation: WorkflowSkillBinding;
  requiredSkillCalls: WorkflowSkillBinding[];
  augmentations: WorkflowSkillBinding[];
  satisfies: string[];
  disabled: boolean;
}

export interface WorkflowEdge {
  from: string;
  to: string | null;
  condition: 'success' | 'failure' | 'pause';
}

export interface WorkflowStateSpec {
  kind: 'owner-overlay' | 'loop-change' | 'workflow-run';
  statePath: string;
  pathBase?: 'project' | 'loop-root' | 'pipeline-openspec-root' | 'pipeline-superpowers-root';
  currentNodeField: string;
  completedNodesField: string;
  evidenceField: string;
}

export interface WorkflowEvalSpec {
  id: string;
  expectedNodeOrder: string[];
  requiredOutputSchemas: string[];
}

export interface WorkflowProtocol {
  schemaVersion: 1;
  kind: WorkflowKind;
  name: string;
  goal: string;
  nodes: WorkflowNodeProtocol[];
  edges: WorkflowEdge[];
  outputSchemas: WorkflowOutputSchema[];
  state: WorkflowStateSpec;
  evals: WorkflowEvalSpec[];
}

export interface NormalizedWorkflowDefinition {
  input: WorkflowDefinitionInput;
  protocol: WorkflowProtocol;
  requiredSkills: string[];
  sourceSkills: string[];
}

export interface WorkflowValidationFinding {
  code:
    | 'unknown-node'
    | 'unsupported-operation'
    | 'control-node-override'
    | 'producer-missing-output-schema'
    | 'missing-output-schema'
    | 'orphan-output-schema'
    | 'duplicate-node'
    | 'disabled-required-node';
  message: string;
  nodeId?: string;
  skill?: string;
}

export interface WorkflowValidationResult {
  valid: boolean;
  findings: WorkflowValidationFinding[];
}
