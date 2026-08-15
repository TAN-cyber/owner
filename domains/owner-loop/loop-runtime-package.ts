import type { DeterministicResolver } from '../engine/resolver.js';
import type { RunState } from '../engine/types.js';
import type { SkillPackage } from '../skill/types.js';
import { sha256Text } from './loop-hash.js';

export const LOOP_RUNTIME_PACKAGE: SkillPackage = {
  root: '/owner/loop-runtime',
  packageKind: 'runtime',
  definition: {
    apiVersion: 'owner/v1alpha1',
    kind: 'Skill',
    metadata: {
      name: 'owner-loop-runtime',
      version: '3',
      description: 'Owner-owned state runtime for the Loop workflow.',
    },
    goal: {
      statement: 'Advance a Loop change only after its current guard passes.',
      inputs: [],
      outputs: [],
      success: ['The Loop change and Run state agree on the next phase.'],
    },
    orchestration: {
      mode: 'deterministic',
      entry: 'shape',
      steps: [
        { id: 'shape', action: { type: 'checkpoint' }, next: 'build' },
        { id: 'build', action: { type: 'checkpoint' }, next: 'verify' },
        { id: 'verify', action: { type: 'checkpoint' }, next: 'archive' },
        { id: 'archive', action: { type: 'checkpoint' } },
      ],
    },
    skills: [],
    agents: [],
    tools: [],
  },
  guardrails: {
    allowedSkills: [],
    allowedAgents: [],
    allowedTools: [],
    // Loop uses the evidence-bound repair episode budget below the engine seam. The generic
    // counter remains an action ID source, not a user-visible permanent stop for long-lived changes.
    maxIterations: Number.MAX_SAFE_INTEGER,
    maxRetriesPerAction: 2,
    confirmationRequiredFor: [],
  },
  evals: [],
};

export const LOOP_RUNTIME_HASH = sha256Text('owner-loop-runtime:v3:scope-reopen');
export const LOOP_LEGACY_RUNTIME_IDENTITIES = [
  {
    skillVersion: '3',
    skillHash: sha256Text('owner-loop-runtime:v3:semantic-repair-budget'),
  },
  {
    skillVersion: '2',
    skillHash: sha256Text('owner-loop-runtime:v2:max-iterations-32'),
  },
  {
    skillVersion: '1',
    skillHash: sha256Text('owner-loop-runtime:v1'),
  },
] as const;

/** Older active Loop Runs may continue when only the compatible iteration budget changed. */
export function isCompatibleLoopRuntimeIdentity(
  run: Pick<RunState, 'skillVersion' | 'skillHash'>,
): boolean {
  return (
    (run.skillVersion === LOOP_RUNTIME_PACKAGE.definition.metadata.version &&
      run.skillHash === LOOP_RUNTIME_HASH) ||
    LOOP_LEGACY_RUNTIME_IDENTITIES.some(
      (identity) =>
        identity.skillVersion === run.skillVersion && identity.skillHash === run.skillHash,
    )
  );
}

export const loopPhaseResolver: DeterministicResolver<undefined> = {
  resolveStep({ pkg, state }) {
    return pkg.definition.orchestration.steps?.find((step) => step.id === state.currentStep);
  },
  resolveNext({ step, outcome }) {
    if (step.id === 'verify' && outcome.state?.verification_result === 'fail') return 'build';
    return step.next ?? null;
  },
};
