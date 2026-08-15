import type {
  WorkflowDefinitionInput,
  WorkflowNodeTemplate,
  WorkflowOutputSchema,
} from './types.js';

export const BUILTIN_OWNER_OUTPUT_SCHEMAS: WorkflowOutputSchema[] = [
  {
    id: 'owner.intake.v1',
    description: 'Owner change intake and initial state.',
    artifacts: [
      {
        id: 'owner-state',
        kind: 'state',
        required: true,
        paths: ['changes/*/.owner.yaml'],
        pathBase: 'classic-openspec-root',
        validations: ['state-transition'],
      },
    ],
    evidence: [{ id: 'intake-summary', required: true }],
  },
  {
    id: 'owner.design.v1',
    description: 'Owner design artifacts and OpenSpec delta context.',
    artifacts: [
      {
        id: 'design-doc',
        kind: 'file',
        required: true,
        paths: ['specs/*.md'],
        pathBase: 'classic-superpowers-root',
        validations: ['artifact-exists', 'artifact-structured'],
      },
      {
        id: 'delta-spec',
        kind: 'file',
        required: true,
        paths: ['changes/*/specs/*/spec.md'],
        pathBase: 'classic-openspec-root',
        validations: ['artifact-exists', 'artifact-structured'],
      },
    ],
    evidence: [
      { id: 'design-summary', required: true },
      { id: 'user-confirmation', required: true },
    ],
  },
  {
    id: 'owner.plan.v1',
    description: 'Owner executable implementation plan.',
    artifacts: [
      {
        id: 'implementation-plan',
        kind: 'file',
        required: true,
        paths: ['plans/*.md'],
        pathBase: 'classic-superpowers-root',
        validations: ['artifact-exists', 'artifact-structured'],
      },
      {
        id: 'openspec-tasks',
        kind: 'file',
        required: false,
        paths: ['changes/*/tasks.md'],
        pathBase: 'classic-openspec-root',
        validations: ['artifact-exists', 'artifact-structured'],
      },
    ],
    evidence: [{ id: 'producer-summary', required: true }],
  },
  {
    id: 'owner.execution-evidence.v1',
    description: 'Owner build execution evidence and task completion.',
    artifacts: [
      {
        id: 'task-state',
        kind: 'file',
        required: true,
        paths: ['changes/*/tasks.md'],
        pathBase: 'classic-openspec-root',
        validations: ['artifact-structured', 'semantic'],
      },
    ],
    evidence: [
      { id: 'implementation-summary', required: true },
      { id: 'test-evidence', required: true },
    ],
  },
  {
    id: 'owner.handoff.v1',
    description: 'Subagent handoff request and returned evidence.',
    artifacts: [],
    evidence: [
      { id: 'handoff-request', required: true },
      { id: 'handoff-result', required: true },
    ],
  },
  {
    id: 'owner.review.v1',
    description: 'Review or whitebox rule report.',
    artifacts: [],
    evidence: [
      { id: 'review-summary', required: true },
      { id: 'review-blockers', required: false },
    ],
  },
  {
    id: 'owner.verify.v1',
    description: 'Owner verification evidence and branch handling.',
    artifacts: [],
    evidence: [
      { id: 'verification-commands', required: true },
      { id: 'verification-result', required: true },
    ],
  },
  {
    id: 'owner.archive.v1',
    description: 'OpenSpec archive and delta sync result.',
    artifacts: [],
    evidence: [
      { id: 'archive-summary', required: true },
      { id: 'archived-state', required: true },
    ],
  },
];

export const OWNER_FIVE_PHASE_NODES: WorkflowNodeTemplate[] = [
  {
    id: 'open',
    label: 'Open',
    kind: 'control',
    responsibility: 'Intake the user request, choose the change shape, and initialize Owner state.',
    implementation: { skill: 'owner-open', operation: 'default', scope: 'main' },
    operations: ['require', 'augment'],
    outputSchemas: ['owner.intake.v1'],
    guardrails: [
      { id: 'owner-state-created', label: '.owner.yaml exists', validation: 'state-transition' },
    ],
  },
  {
    id: 'design',
    label: 'Design',
    kind: 'producer',
    responsibility: 'Turn the confirmed request into design artifacts and OpenSpec delta context.',
    implementation: { skill: 'owner-design', operation: 'default', scope: 'main' },
    operations: ['require', 'augment', 'override'],
    outputSchemas: ['owner.design.v1'],
    guardrails: [
      {
        id: 'design-artifacts',
        label: 'Design artifacts exist',
        validation: 'artifact-structured',
      },
    ],
  },
  {
    id: 'plan',
    label: 'Plan',
    kind: 'producer',
    responsibility: 'Create the executable implementation plan and task contract.',
    implementation: { skill: 'owner-build', operation: 'default', scope: 'main' },
    operations: ['require', 'augment', 'override'],
    outputSchemas: ['owner.plan.v1'],
    guardrails: [
      { id: 'plan-artifacts', label: 'Plan artifacts exist', validation: 'artifact-structured' },
    ],
  },
  {
    id: 'execute',
    label: 'Execute',
    kind: 'control',
    responsibility: 'Apply the implementation plan through direct coordinator execution.',
    implementation: { skill: 'owner-build', operation: 'default', scope: 'main' },
    operations: ['require', 'augment'],
    outputSchemas: ['owner.execution-evidence.v1'],
    guardrails: [
      { id: 'build-complete', label: 'Build evidence recorded', validation: 'semantic' },
    ],
  },
  {
    id: 'subagent-execute',
    label: 'Subagent Execute',
    kind: 'handoff',
    responsibility: 'Delegate implementation work and require auditable returned evidence.',
    implementation: {
      skill: 'subagent-driven-development',
      operation: 'default',
      scope: 'handoff',
    },
    operations: ['require', 'augment'],
    outputSchemas: ['owner.handoff.v1'],
    guardrails: [
      { id: 'handoff-evidence', label: 'Handoff evidence recorded', validation: 'evidence-only' },
    ],
  },
  {
    id: 'review',
    label: 'Review',
    kind: 'guardrail',
    responsibility: 'Inspect the implementation with review Skills before verification.',
    optional: true,
    implementation: { skill: 'requesting-code-review', operation: 'default', scope: 'review' },
    operations: ['require', 'augment', 'disable'],
    outputSchemas: ['owner.review.v1'],
    guardrails: [
      { id: 'review-evidence', label: 'Review evidence recorded', validation: 'evidence-only' },
    ],
  },
  {
    id: 'verify',
    label: 'Verify',
    kind: 'control',
    responsibility:
      'Run verification, reconcile branch state, and decide whether completion is valid.',
    implementation: { skill: 'owner-verify', operation: 'default', scope: 'main' },
    operations: ['require', 'augment'],
    outputSchemas: ['owner.verify.v1'],
    guardrails: [
      { id: 'verify-result', label: 'Verification result recorded', validation: 'evidence-only' },
    ],
  },
  {
    id: 'archive',
    label: 'Archive',
    kind: 'control',
    responsibility: 'Archive the OpenSpec change and sync completed deltas back to the main specs.',
    implementation: { skill: 'owner-archive', operation: 'default', scope: 'main' },
    operations: ['require', 'augment'],
    outputSchemas: ['owner.archive.v1'],
    guardrails: [
      { id: 'archive-state', label: 'Archive state recorded', validation: 'state-transition' },
    ],
  },
];

export const BUILTIN_OWNER_NATIVE_OUTPUT_SCHEMAS: WorkflowOutputSchema[] = [
  {
    id: 'owner.native.brief.v1',
    description: 'Native change outcome, scope, acceptance, decisions, and open questions.',
    artifacts: [
      {
        id: 'native-brief',
        kind: 'file',
        required: true,
        paths: ['changes/*/brief.md'],
        pathBase: 'native-root',
        validations: ['artifact-exists', 'artifact-structured'],
      },
    ],
    evidence: [{ id: 'shape-summary', required: true }],
  },
  {
    id: 'owner.native.spec-change.v1',
    description: 'Complete target capability specs and their canonical base hashes.',
    artifacts: [
      {
        id: 'native-target-specs',
        kind: 'directory',
        required: false,
        paths: ['changes/*/specs'],
        pathBase: 'native-root',
        validations: ['artifact-structured', 'semantic'],
      },
    ],
    evidence: [{ id: 'spec-change-summary', required: false }],
  },
  {
    id: 'owner.native.implementation.v1',
    description: 'Implementation or explicit no-code outcome evidence.',
    artifacts: [],
    evidence: [{ id: 'implementation-summary', required: true }],
  },
  {
    id: 'owner.native.verify.v1',
    description: 'Acceptance, command, risk, and spec-consistency verification evidence.',
    artifacts: [
      {
        id: 'native-verification',
        kind: 'report',
        required: true,
        paths: ['changes/*/verification.md'],
        pathBase: 'native-root',
        validations: ['artifact-exists', 'artifact-structured', 'semantic'],
      },
    ],
    evidence: [{ id: 'verification-result', required: true }],
  },
  {
    id: 'owner.native.archive.v1',
    description: 'Conflict-safe canonical spec update and frozen Native change history.',
    artifacts: [
      {
        id: 'native-archive',
        kind: 'directory',
        required: true,
        paths: ['archive/*'],
        pathBase: 'native-root',
        validations: ['artifact-exists', 'state-transition'],
      },
    ],
    evidence: [{ id: 'archive-summary', required: true }],
  },
];

export const OWNER_NATIVE_NODES: WorkflowNodeTemplate[] = [
  {
    id: 'shape',
    label: 'Shape',
    kind: 'control',
    responsibility: 'Resolve the decision frontier and establish the Native change contract.',
    implementation: { skill: 'owner-native', operation: 'default', scope: 'main' },
    operations: ['require', 'augment'],
    outputSchemas: ['owner.native.brief.v1', 'owner.native.spec-change.v1'],
    guardrails: [
      {
        id: 'native-shape-ready',
        label: 'Native brief and target specs are ready',
        validation: 'artifact-structured',
      },
    ],
  },
  {
    id: 'build',
    label: 'Build',
    kind: 'control',
    responsibility: 'Implement the Native change using the host model’s native capabilities.',
    implementation: { skill: 'owner-native', operation: 'default', scope: 'main' },
    operations: ['require', 'augment'],
    outputSchemas: ['owner.native.implementation.v1'],
    guardrails: [
      {
        id: 'native-build-ready',
        label: 'Implementation evidence is recorded',
        validation: 'semantic',
      },
    ],
  },
  {
    id: 'verify',
    label: 'Verify',
    kind: 'control',
    responsibility: 'Prove acceptance scenarios and target-spec consistency with evidence.',
    implementation: { skill: 'owner-native', operation: 'default', scope: 'main' },
    operations: ['require', 'augment'],
    outputSchemas: ['owner.native.verify.v1'],
    guardrails: [
      {
        id: 'native-verification-ready',
        label: 'Native verification report is complete',
        validation: 'semantic',
      },
    ],
  },
  {
    id: 'archive',
    label: 'Archive',
    kind: 'control',
    responsibility:
      'Apply target specs and freeze the Native change through a recoverable transaction.',
    implementation: { skill: 'owner-native', operation: 'default', scope: 'main' },
    operations: ['require', 'augment'],
    outputSchemas: ['owner.native.archive.v1'],
    guardrails: [
      {
        id: 'native-archive-ready',
        label: 'Native archive transaction completed',
        validation: 'state-transition',
      },
    ],
  },
];

export function builtinOwnerFivePhaseWorkflow(options: {
  name: string;
  goal: string;
}): WorkflowDefinitionInput {
  return {
    kind: 'owner-five-phase-overlay',
    name: options.name,
    goal: options.goal,
  };
}

export function builtinOwnerNativeWorkflow(options: {
  name: string;
  goal: string;
}): WorkflowDefinitionInput {
  return { kind: 'owner-native', name: options.name, goal: options.goal };
}
