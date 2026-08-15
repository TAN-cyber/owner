import type { PipelinePhase, PipelineState } from './pipeline-state.js';

export const PIPELINE_TRANSITION_EVENTS = [
  'open-complete',
  'design-complete',
  'build-complete',
  'verify-pass',
  'verify-fail',
  'archive-confirm',
  'archive-reopen',
  'archived',
  'preset-escalate',
] as const;

export type PipelineTransitionEvent = (typeof PIPELINE_TRANSITION_EVENTS)[number];

export interface PipelineTransitionEffect {
  field: keyof PipelineState;
  from: unknown;
  to: unknown;
}

export interface PipelineTransitionDefinition {
  event: PipelineTransitionEvent;
  from: PipelinePhase;
  guardRefs: string[];
}

export interface PipelineTransitionResult {
  pipeline: PipelineState;
  effects: PipelineTransitionEffect[];
  definition: PipelineTransitionDefinition;
}

export const PIPELINE_TRANSITION_TABLE: Record<
  PipelineTransitionEvent,
  PipelineTransitionDefinition
> = {
  'open-complete': {
    event: 'open-complete',
    from: 'open',
    guardRefs: ['open-artifacts-present'],
  },
  'design-complete': {
    event: 'design-complete',
    from: 'design',
    guardRefs: ['design-evidence-present'],
  },
  'build-complete': {
    event: 'build-complete',
    from: 'build',
    guardRefs: ['build-decisions-selected'],
  },
  'verify-pass': {
    event: 'verify-pass',
    from: 'verify',
    guardRefs: ['verification-report-present'],
  },
  'verify-fail': {
    event: 'verify-fail',
    from: 'verify',
    guardRefs: ['verification-failed'],
  },
  'archive-confirm': {
    event: 'archive-confirm',
    from: 'archive',
    guardRefs: ['archive-final-confirmation'],
  },
  'archive-reopen': {
    event: 'archive-reopen',
    from: 'archive',
    guardRefs: ['archive-not-finalized'],
  },
  archived: {
    event: 'archived',
    from: 'archive',
    guardRefs: ['verify-result-pass', 'archive-confirmed'],
  },
  'preset-escalate': {
    event: 'preset-escalate',
    from: 'build',
    guardRefs: ['preset-workflow'],
  },
};

export const PIPELINE_GUARD_TRANSITION_EVENT: Partial<
  Record<PipelinePhase, PipelineTransitionEvent>
> = {
  open: 'open-complete',
  design: 'design-complete',
  build: 'build-complete',
  verify: 'verify-pass',
};

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function setField<K extends keyof PipelineState>(
  pipeline: PipelineState,
  effects: PipelineTransitionEffect[],
  field: K,
  value: PipelineState[K],
): void {
  const from = pipeline[field];
  pipeline[field] = value;
  if (from !== value) effects.push({ field, from, to: value });
}

export function applyPipelineTransition(
  current: PipelineState,
  event: PipelineTransitionEvent,
  options: { now?: Date } = {},
): PipelineTransitionResult {
  const definition = PIPELINE_TRANSITION_TABLE[event];
  if (current.phase !== definition.from) {
    throw new Error(
      `Cannot apply ${event}: phase is '${current.phase}', expected '${definition.from}'`,
    );
  }

  const pipeline: PipelineState = { ...current };
  const effects: PipelineTransitionEffect[] = [];
  const now = options.now ?? new Date();

  if (event === 'open-complete') {
    setField(pipeline, effects, 'phase', pipeline.workflow === 'full' ? 'design' : 'build');
  } else if (event === 'design-complete') {
    setField(pipeline, effects, 'phase', 'build');
  } else if (event === 'build-complete') {
    const preserveEvidence = pipeline.verifyResult === 'fail';
    setField(pipeline, effects, 'phase', 'verify');
    setField(pipeline, effects, 'verifyResult', 'pending');
    setField(pipeline, effects, 'branchStatus', 'pending');
    if (!preserveEvidence) {
      setField(pipeline, effects, 'verificationReport', null);
    }
  } else if (event === 'verify-pass') {
    setField(pipeline, effects, 'verifyResult', 'pass');
    setField(pipeline, effects, 'verifyFailures', 0);
    setField(pipeline, effects, 'phase', 'archive');
    setField(pipeline, effects, 'verifiedAt', dateOnly(now));
    setField(pipeline, effects, 'archiveConfirmation', 'pending');
    setField(pipeline, effects, 'branchStatus', 'pending');
  } else if (event === 'verify-fail') {
    setField(pipeline, effects, 'verifyResult', 'fail');
    setField(pipeline, effects, 'verifyFailures', pipeline.verifyFailures + 1);
    setField(pipeline, effects, 'phase', 'build');
    setField(pipeline, effects, 'branchStatus', 'pending');
  } else if (event === 'preset-escalate') {
    if (pipeline.workflow !== 'hotfix' && pipeline.workflow !== 'tweak') {
      throw new Error(
        `Cannot apply ${event}: workflow must be hotfix or tweak, got '${pipeline.workflow}'`,
      );
    }
    setField(pipeline, effects, 'workflow', 'full');
    setField(pipeline, effects, 'pipelineProfile', 'full');
    setField(pipeline, effects, 'phase', 'design');
    setField(pipeline, effects, 'designDoc', null);
    setField(pipeline, effects, 'buildPause', null);
    setField(pipeline, effects, 'buildMode', null);
    setField(pipeline, effects, 'subagentDispatch', null);
    setField(pipeline, effects, 'tddMode', null);
    setField(pipeline, effects, 'reviewMode', null);
    setField(pipeline, effects, 'isolation', null);
    setField(pipeline, effects, 'boundBranch', null);
    setField(pipeline, effects, 'verifyMode', null);
    setField(pipeline, effects, 'directOverride', null);
  } else if (event === 'archive-confirm') {
    if (pipeline.verifyResult !== 'pass') {
      throw new Error(`Cannot apply ${event}: verifyResult must be pass`);
    }
    if (pipeline.archived) throw new Error(`Cannot apply ${event}: already archived`);
    setField(pipeline, effects, 'archiveConfirmation', 'confirmed');
  } else if (event === 'archive-reopen') {
    if (pipeline.archived) throw new Error(`Cannot apply ${event}: already archived`);
    setField(pipeline, effects, 'verifyResult', 'pending');
    setField(pipeline, effects, 'verifyFailures', 0);
    setField(pipeline, effects, 'phase', 'verify');
    setField(pipeline, effects, 'verifiedAt', null);
    setField(pipeline, effects, 'archiveConfirmation', null);
    setField(pipeline, effects, 'branchStatus', 'pending');
  } else {
    if (pipeline.verifyResult !== 'pass') {
      throw new Error(`Cannot apply ${event}: verifyResult must be pass`);
    }
    if (pipeline.archiveConfirmation !== 'confirmed') {
      throw new Error(`Cannot apply ${event}: archiveConfirmation must be confirmed`);
    }
    setField(pipeline, effects, 'archived', true);
  }

  return { pipeline, effects, definition };
}
