import type { DeterministicResolver } from '../../domains/engine/resolver.js';
import type { PipelineEvidence } from './pipeline-evidence.js';
import { evidenceSatisfied } from './pipeline-evidence.js';
import type { PipelineProfile, PipelineState } from './pipeline-state.js';

export interface PipelineResolverContext {
  pipeline: PipelineState;
  evidence: PipelineEvidence[];
}

function profileFor(pipeline: PipelineState): PipelineProfile {
  return pipeline.pipelineProfile ?? pipeline.workflow;
}

function fullBuildConfigured(pipeline: PipelineState): boolean {
  if (!pipeline.buildMode || !pipeline.tddMode || !pipeline.isolation || !pipeline.verifyMode) {
    return false;
  }
  if (pipeline.buildMode === 'subagent-driven-development') {
    return pipeline.subagentDispatch === 'confirmed';
  }
  if (pipeline.buildMode === 'direct') return pipeline.directOverride === true;
  return true;
}

function presetBuildConfigured(pipeline: PipelineState): boolean {
  return Boolean(
    pipeline.buildMode === 'direct' &&
    pipeline.tddMode === 'direct' &&
    pipeline.isolation !== null &&
    pipeline.verifyMode === 'light',
  );
}

function resolveBuild(
  profile: PipelineProfile,
  pipeline: PipelineState,
  evidence: readonly PipelineEvidence[],
): string {
  if (pipeline.verifyResult === 'fail') {
    return profile === 'full' ? 'full.build.fix' : `${profile}.build.execute`;
  }

  if (profile === 'full') {
    if (!evidenceSatisfied(evidence, 'build.plan')) return 'full.build.plan';
    if (pipeline.buildPause === 'plan-ready') return 'full.build.plan-ready';
    if (!fullBuildConfigured(pipeline)) return 'full.build.configure';
  } else if (!presetBuildConfigured(pipeline)) {
    throw new Error(`${profile} build configuration is incomplete`);
  }

  return evidenceSatisfied(evidence, 'build.tasks-complete')
    ? `${profile}.build.complete`
    : `${profile}.build.execute`;
}

function resolveVerify(
  profile: PipelineProfile,
  pipeline: PipelineState,
  evidence: readonly PipelineEvidence[],
): string {
  if (pipeline.verifyResult !== 'pass' || !evidenceSatisfied(evidence, 'verification.report')) {
    return `${profile}.verify.run`;
  }
  return `${profile}.verify.branch`;
}

function resolveArchive(profile: PipelineProfile, pipeline: PipelineState): string {
  if (pipeline.verifyResult !== 'pass') {
    throw new Error('archive requires verify_result=pass');
  }
  return pipeline.archiveConfirmation === 'confirmed'
    ? `${profile}.archive.execute`
    : `${profile}.archive.confirm`;
}

export function resolvePipelineStepId(
  pipeline: PipelineState,
  evidence: readonly PipelineEvidence[],
): string {
  const profile = profileFor(pipeline);

  if (pipeline.archived && pipeline.phase !== 'archive') {
    throw new Error('archived=true requires phase=archive');
  }
  if (pipeline.archived) return 'completed';
  if (profile !== 'full' && pipeline.phase === 'design') {
    throw new Error(`${profile} workflow cannot enter design`);
  }

  switch (pipeline.phase) {
    case 'open':
      return `${profile}.open`;
    case 'design':
      return evidenceSatisfied(evidence, 'design.handoff')
        ? 'full.design.document'
        : 'full.design.handoff';
    case 'build':
      return resolveBuild(profile, pipeline, evidence);
    case 'verify':
      return resolveVerify(profile, pipeline, evidence);
    case 'archive':
      return resolveArchive(profile, pipeline);
  }
}

export const pipelineDeterministicResolver: DeterministicResolver<PipelineResolverContext> = {
  resolveStep({ pkg, context }) {
    const stepId = resolvePipelineStepId(context.pipeline, context.evidence);
    return pkg.definition.orchestration.steps?.find((step) => step.id === stepId);
  },
  resolveNext({ step }) {
    return step.next ?? null;
  },
};
