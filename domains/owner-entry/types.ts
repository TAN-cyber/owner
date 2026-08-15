import type { RecordedCommandCheck } from '../owner-pipeline/pipeline-command-checks.js';
import type { LoopStatusProjection } from '../owner-loop/loop-types.js';

export type OwnerWorkflow = 'loop' | 'pipeline';

export type InitWorkflowSelection = OwnerWorkflow | 'both';

export type OwnerEntrySkill = 'owner-loop' | 'owner-pipeline';

export type OwnerEntryResolutionSource =
  | 'project-config'
  | 'global-config'
  | 'built-in-default'
  | 'legacy-project'
  | 'legacy-fallback';

export interface OwnerEntryResolution {
  workflow: OwnerWorkflow;
  skill: OwnerEntrySkill;
  source: OwnerEntryResolutionSource;
}

export interface ChangeStatus {
  name: string;
  ownerManaged: boolean;
  archiveReady: boolean;
  recommendedArchiveCommand: string;
  workflow: string | null;
  phase: string | null;
  buildMode: string | null;
  isolation: string | null;
  boundBranch: string | null;
  verifyMode: string | null;
  verifyResult: string | null;
  designDoc: string | null;
  plan: string | null;
  tasksCompleted: number;
  tasksTotal: number;
  nextCommand: string | null;
  currentStep: string | null;
  runtimeMode: string | null;
  runtimeEval: {
    stepId: string;
    passed: boolean;
    requiredEvidence: string[];
    missingEvidence: string[];
  } | null;
  commandChecks: {
    build: RecordedCommandCheck | null;
    verify: RecordedCommandCheck | null;
  } | null;
  error?: string;
}

export interface OwnerProjectStatus {
  schema: 'owner.status.v2';
  defaultEntry: OwnerEntryResolution | { error: string };
  workflows: {
    loop: { changes: LoopStatusProjection[]; error?: string };
    pipeline: { changes: ChangeStatus[]; error?: string };
  };
  unmanagedOpenSpec: ChangeStatus[];
}
