import { describe, expect, it } from 'vitest';
import {
  resolvePipelineStepId,
  type PipelineResolverContext,
} from '../../../domains/owner-pipeline/pipeline-resolver.js';
import type { PipelineEvidence } from '../../../domains/owner-pipeline/pipeline-evidence.js';
import type { PipelineState } from '../../../domains/owner-pipeline/pipeline-state.js';

function state(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    workflow: 'full',
    phase: 'open',
    contextCompression: 'off',
    buildMode: null,
    buildPause: null,
    subagentDispatch: null,
    tddMode: null,
    isolation: null,
    verifyMode: null,
    autoTransition: true,
    baseRef: null,
    designDoc: null,
    plan: null,
    verifyResult: 'pending',
    verifyFailures: 0,
    verificationReport: null,
    branchStatus: 'pending',
    createdAt: '2026-06-14',
    verifiedAt: null,
    archiveConfirmation: null,
    archived: false,
    directOverride: null,
    handoffContext: null,
    handoffHash: null,
    pipelineProfile: null,
    pipelineMigration: null,
    ...overrides,
  };
}

function evidence(...satisfiedCodes: string[]): PipelineEvidence[] {
  return satisfiedCodes.map((code) => ({ code, satisfied: true }));
}

interface ResolverCase {
  name: string;
  pipeline: PipelineState;
  evidence?: PipelineEvidence[];
  expected: string;
}

const cases: ResolverCase[] = [
  { name: 'full open', pipeline: state(), expected: 'full.open' },
  {
    name: 'full design handoff',
    pipeline: state({ phase: 'design' }),
    expected: 'full.design.handoff',
  },
  {
    name: 'full design document',
    pipeline: state({ phase: 'design', handoffContext: '.owner/context.json' }),
    evidence: evidence('design.handoff'),
    expected: 'full.design.document',
  },
  {
    name: 'full build plan',
    pipeline: state({ phase: 'build' }),
    expected: 'full.build.plan',
  },
  {
    name: 'full build plan-ready pause',
    pipeline: state({ phase: 'build', plan: 'plan.md', buildPause: 'plan-ready' }),
    evidence: evidence('build.plan'),
    expected: 'full.build.plan-ready',
  },
  {
    name: 'full build configuration',
    pipeline: state({ phase: 'build', plan: 'plan.md' }),
    evidence: evidence('build.plan'),
    expected: 'full.build.configure',
  },
  {
    name: 'full build execution',
    pipeline: state({
      phase: 'build',
      plan: 'plan.md',
      buildMode: 'executing-plans',
      tddMode: 'tdd',
      isolation: 'worktree',
      verifyMode: 'full',
    }),
    evidence: evidence('build.plan'),
    expected: 'full.build.execute',
  },
  {
    name: 'full build completion',
    pipeline: state({
      phase: 'build',
      plan: 'plan.md',
      buildMode: 'executing-plans',
      tddMode: 'tdd',
      isolation: 'worktree',
      verifyMode: 'full',
    }),
    evidence: evidence('build.plan', 'build.tasks-complete'),
    expected: 'full.build.complete',
  },
  {
    name: 'full build fix',
    pipeline: state({
      phase: 'build',
      plan: 'plan.md',
      buildMode: 'executing-plans',
      tddMode: 'tdd',
      isolation: 'worktree',
      verifyMode: 'full',
      verifyResult: 'fail',
    }),
    evidence: evidence('build.plan'),
    expected: 'full.build.fix',
  },
  {
    name: 'full verification run',
    pipeline: state({ phase: 'verify' }),
    expected: 'full.verify.run',
  },
  {
    name: 'full verification branch handling',
    pipeline: state({
      phase: 'verify',
      verifyResult: 'pass',
      verificationReport: 'verification.md',
    }),
    evidence: evidence('verification.report'),
    expected: 'full.verify.branch',
  },
  {
    name: 'full archive confirmation',
    pipeline: state({
      phase: 'archive',
      verifyResult: 'pass',
      verificationReport: 'verification.md',
      branchStatus: 'handled',
    }),
    evidence: evidence('verification.report'),
    expected: 'full.archive.confirm',
  },
  {
    name: 'full archive execution',
    pipeline: state({
      phase: 'archive',
      verifyResult: 'pass',
      verificationReport: 'verification.md',
      branchStatus: 'handled',
      archiveConfirmation: 'confirmed',
    }),
    evidence: evidence('verification.report'),
    expected: 'full.archive.execute',
  },
  {
    name: 'completed',
    pipeline: state({
      phase: 'archive',
      verifyResult: 'pass',
      branchStatus: 'handled',
      archived: true,
    }),
    expected: 'completed',
  },
  {
    name: 'hotfix open',
    pipeline: state({ workflow: 'hotfix' }),
    expected: 'hotfix.open',
  },
  {
    name: 'hotfix build execution',
    pipeline: state({
      workflow: 'hotfix',
      phase: 'build',
      buildMode: 'direct',
      tddMode: 'direct',
      isolation: 'branch',
      verifyMode: 'light',
    }),
    expected: 'hotfix.build.execute',
  },
  {
    name: 'hotfix build completion',
    pipeline: state({
      workflow: 'hotfix',
      phase: 'build',
      buildMode: 'direct',
      tddMode: 'direct',
      isolation: 'branch',
      verifyMode: 'light',
    }),
    evidence: evidence('build.tasks-complete'),
    expected: 'hotfix.build.complete',
  },
  {
    name: 'tweak verification',
    pipeline: state({ workflow: 'tweak', phase: 'verify' }),
    expected: 'tweak.verify.run',
  },
  {
    name: 'tweak archive execution',
    pipeline: state({
      workflow: 'tweak',
      phase: 'archive',
      verifyResult: 'pass',
      verificationReport: 'verification.md',
      branchStatus: 'handled',
      archiveConfirmation: 'confirmed',
    }),
    evidence: evidence('verification.report'),
    expected: 'tweak.archive.execute',
  },
];

describe('Pipeline Resolver', () => {
  it.each(cases)('$name -> $expected', ({ pipeline, evidence: facts = [], expected }) => {
    expect(resolvePipelineStepId(pipeline, facts)).toBe(expected);
  });

  it('uses pipeline_profile after a preset upgrade', () => {
    expect(
      resolvePipelineStepId(
        state({
          workflow: 'hotfix',
          pipelineProfile: 'full',
          phase: 'build',
          plan: 'plan.md',
        }),
        evidence('build.plan'),
      ),
    ).toBe('full.build.configure');
  });

  it('resolves a preset-escalate terminal state to the design handoff step', () => {
    // preset-escalate transitions (workflow/pipeline_profile → full, phase →
    // design, design_doc → null). The resolver must accept this state and
    // route to the design handoff step instead of tripping the
    // (phase=design, profile!=full) invariant.
    expect(
      resolvePipelineStepId(
        state({
          workflow: 'full',
          pipelineProfile: 'full',
          phase: 'design',
          designDoc: null,
        }),
        [],
      ),
    ).toBe('full.design.handoff');
  });

  it.each([
    {
      name: 'archived outside archive',
      pipeline: state({ phase: 'build', archived: true }),
      message: 'archived=true requires phase=archive',
    },
    {
      name: 'design phase for hotfix',
      pipeline: state({ workflow: 'hotfix', phase: 'design' }),
      message: 'hotfix workflow cannot enter design',
    },
    {
      name: 'archive before verification passes',
      pipeline: state({ phase: 'archive', verifyResult: 'pending' }),
      message: 'archive requires verify_result=pass',
    },
  ])('fails closed for $name', ({ pipeline, message }) => {
    expect(() => resolvePipelineStepId(pipeline, [])).toThrow(message);
  });

  it('defines the resolver context as Pipeline state plus structured evidence', () => {
    const context: PipelineResolverContext = {
      pipeline: state(),
      evidence: evidence('openspec.proposal'),
    };

    expect(context.pipeline.workflow).toBe('full');
    expect(context.evidence[0].code).toBe('openspec.proposal');
  });
});
