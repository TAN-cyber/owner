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
        pathBase: 'pipeline-openspec-root',
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
        pathBase: 'pipeline-superpowers-root',
        validations: ['artifact-exists', 'artifact-structured'],
      },
      {
        id: 'delta-spec',
        kind: 'file',
        required: true,
        paths: ['changes/*/specs/*/spec.md'],
        pathBase: 'pipeline-openspec-root',
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
        pathBase: 'pipeline-superpowers-root',
        validations: ['artifact-exists', 'artifact-structured'],
      },
      {
        id: 'openspec-tasks',
        kind: 'file',
        required: false,
        paths: ['changes/*/tasks.md'],
        pathBase: 'pipeline-openspec-root',
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
        pathBase: 'pipeline-openspec-root',
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

export const BUILTIN_OWNER_LOOP_OUTPUT_SCHEMAS: WorkflowOutputSchema[] = [
  {
    id: 'owner.loop.brief.v1',
    description: 'Loop change outcome, scope, acceptance, decisions, and open questions.',
    artifacts: [
      {
        id: 'loop-brief',
        kind: 'file',
        required: true,
        paths: ['changes/*/brief.md'],
        pathBase: 'loop-root',
        validations: ['artifact-exists', 'artifact-structured'],
      },
    ],
    evidence: [{ id: 'shape-summary', required: true }],
  },
  {
    id: 'owner.loop.spec-change.v1',
    description: 'Complete target capability specs and their canonical base hashes.',
    artifacts: [
      {
        id: 'loop-target-specs',
        kind: 'directory',
        required: false,
        paths: ['changes/*/specs'],
        pathBase: 'loop-root',
        validations: ['artifact-structured', 'semantic'],
      },
    ],
    evidence: [{ id: 'spec-change-summary', required: false }],
  },
  {
    id: 'owner.loop.implementation.v1',
    description: 'Implementation or explicit no-code outcome evidence.',
    artifacts: [],
    evidence: [{ id: 'implementation-summary', required: true }],
  },
  {
    id: 'owner.loop.verify.v1',
    description: 'Acceptance, command, risk, and spec-consistency verification evidence.',
    artifacts: [
      {
        id: 'loop-verification',
        kind: 'report',
        required: true,
        paths: ['changes/*/verification.md'],
        pathBase: 'loop-root',
        validations: ['artifact-exists', 'artifact-structured', 'semantic'],
      },
    ],
    evidence: [{ id: 'verification-result', required: true }],
  },
  {
    id: 'owner.loop.archive.v1',
    description: 'Conflict-safe canonical spec update and frozen Loop change history.',
    artifacts: [
      {
        id: 'loop-archive',
        kind: 'directory',
        required: true,
        paths: ['archive/*'],
        pathBase: 'loop-root',
        validations: ['artifact-exists', 'state-transition'],
      },
    ],
    evidence: [{ id: 'archive-summary', required: true }],
  },
];

export const OWNER_LOOP_NODES: WorkflowNodeTemplate[] = [
  {
    id: 'shape',
    label: 'Shape',
    kind: 'control',
    responsibility: 'Resolve the decision frontier and establish the Loop change contract.',
    implementation: { skill: 'owner-loop', operation: 'default', scope: 'main' },
    operations: ['require', 'augment'],
    outputSchemas: ['owner.loop.brief.v1', 'owner.loop.spec-change.v1'],
    guardrails: [
      {
        id: 'loop-shape-ready',
        label: 'Loop brief and target specs are ready',
        validation: 'artifact-structured',
      },
    ],
  },
  {
    id: 'build',
    label: 'Build',
    kind: 'control',
    responsibility: 'Implement the Loop change using the host model’s loop capabilities.',
    implementation: { skill: 'owner-loop', operation: 'default', scope: 'main' },
    operations: ['require', 'augment'],
    outputSchemas: ['owner.loop.implementation.v1'],
    guardrails: [
      {
        id: 'loop-build-ready',
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
    implementation: { skill: 'owner-loop', operation: 'default', scope: 'main' },
    operations: ['require', 'augment'],
    outputSchemas: ['owner.loop.verify.v1'],
    guardrails: [
      {
        id: 'loop-verification-ready',
        label: 'Loop verification report is complete',
        validation: 'semantic',
      },
    ],
  },
  {
    id: 'archive',
    label: 'Archive',
    kind: 'control',
    responsibility:
      'Apply target specs and freeze the Loop change through a recoverable transaction.',
    implementation: { skill: 'owner-loop', operation: 'default', scope: 'main' },
    operations: ['require', 'augment'],
    outputSchemas: ['owner.loop.archive.v1'],
    guardrails: [
      {
        id: 'loop-archive-ready',
        label: 'Loop archive transaction completed',
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

export function builtinOwnerLoopWorkflow(options: {
  name: string;
  goal: string;
}): WorkflowDefinitionInput {
  return { kind: 'owner-loop', name: options.name, goal: options.goal };
}
