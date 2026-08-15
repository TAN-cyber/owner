import type { WorkflowDefinitionInput } from '../../domains/workflow-contract/index.js';

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

export function workflowFor(name: string, skills: string[]): WorkflowDefinitionInput {
  const nodes = skills.map((skill, index) => {
    const id = slug(skill) || `node-${index + 1}`;
    return {
      id,
      label: skill,
      kind: 'action' as const,
      responsibility: `Run ${skill} and record its workflow evidence.`,
      implementation: { skill, operation: 'default' as const, scope: 'main' as const },
      operations: ['require', 'augment', 'override'] as const,
      outputSchemas: [`${id}.result.v1`],
      guardrails: [
        {
          id: `${id}-evidence`,
          label: `${skill} evidence recorded`,
          validation: 'evidence-only' as const,
        },
      ],
    };
  });
  return {
    kind: 'workflow-kernel',
    name,
    goal: `Run ${skills.join(', ')} as a generated workflow.`,
    customNodes: nodes,
    outputSchemas: nodes.map((node) => ({
      id: node.outputSchemas[0]!,
      description: `${node.label} output.`,
      artifacts: [],
      evidence: [{ id: 'summary', required: true }],
    })),
  };
}

export function ownerWorkflow(name: string, goal: string): WorkflowDefinitionInput {
  return {
    kind: 'owner-five-phase-overlay',
    name,
    goal,
  };
}
