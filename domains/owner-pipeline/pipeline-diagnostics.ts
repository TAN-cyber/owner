import type { PipelineEvidence } from './pipeline-evidence.js';
import { collectPipelineEvidence } from './pipeline-evidence.js';
import {
  ensureStrictPipelineRuntimeRun,
  validatePipelineRuntimeRun,
} from './pipeline-runtime-run.js';
import { readPipelineState } from './pipeline-store.js';
import { resolvePipelineStepId } from './pipeline-resolver.js';
import {
  evaluatePipelineRuntimeStep,
  type PipelineRuntimeEvalStatus,
} from './pipeline-runtime-evals.js';

export interface PipelineDiagnostic {
  name: string;
  valid: boolean;
  workflow: string;
  phase: string;
  currentStep: string | null;
  nextCommand: string | null;
  runtimeMode: 'engine-projection' | 'legacy-state' | 'invalid';
  runtimeEval: PipelineRuntimeEvalStatus | null;
  evidence: PipelineEvidence[];
  error?: string;
}

export async function inspectPipelineChangeReadOnly(
  changeDir: string,
  name: string,
): Promise<PipelineDiagnostic> {
  try {
    const projection = await readPipelineState(changeDir, { migrate: false });
    const unknownKeys = Array.from(new Set(projection.unknownKeys)).sort();
    if (unknownKeys.length > 0) {
      throw new Error(`Invalid Pipeline state: unknown field(s): ${unknownKeys.join(', ')}`);
    }
    if (!projection.pipeline)
      throw new Error('Invalid Pipeline state: missing Pipeline projection');

    if (!projection.run) {
      return {
        name,
        valid: true,
        workflow: projection.pipeline.workflow,
        phase: projection.pipeline.phase,
        currentStep: null,
        nextCommand: nextCommandForPhase(projection.pipeline.phase),
        runtimeMode: 'legacy-state',
        runtimeEval: null,
        evidence: [],
      };
    }

    const runtime = await validatePipelineRuntimeRun(changeDir, projection);
    const evidence = runtime.evidence;
    const currentStep = resolvePipelineStepId(runtime.pipeline, evidence);
    return {
      name,
      valid: true,
      workflow: projection.pipeline.workflow,
      phase: projection.pipeline.phase,
      currentStep,
      nextCommand: nextCommandForPhase(projection.pipeline.phase),
      runtimeMode: 'engine-projection',
      runtimeEval: evaluatePipelineRuntimeStep(currentStep, evidence),
      evidence,
    };
  } catch (error) {
    return {
      name,
      valid: false,
      workflow: 'unknown',
      phase: 'invalid',
      currentStep: null,
      nextCommand: null,
      runtimeMode: 'invalid',
      runtimeEval: null,
      evidence: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function nextCommandForPhase(phase: string): string | null {
  switch (phase) {
    case 'open':
      return '/owner-open';
    case 'design':
      return '/owner-design';
    case 'build':
      return '/owner-build';
    case 'verify':
      return '/owner-verify';
    case 'archive':
      return '/owner-archive';
    default:
      return null;
  }
}

export async function inspectPipelineChange(
  changeDir: string,
  name: string,
): Promise<PipelineDiagnostic> {
  try {
    const runtime = await ensureStrictPipelineRuntimeRun(changeDir);
    const evidence = await collectPipelineEvidence(changeDir, {
      pipeline: runtime.pipeline,
      run: runtime.run,
      unknownKeys: [],
    });
    const currentStep = resolvePipelineStepId(runtime.pipeline, evidence);
    return {
      name,
      valid: true,
      workflow: runtime.pipeline.workflow,
      phase: runtime.pipeline.phase,
      currentStep,
      nextCommand: nextCommandForPhase(runtime.pipeline.phase),
      runtimeMode: 'engine-projection',
      runtimeEval: evaluatePipelineRuntimeStep(currentStep, evidence),
      evidence,
    };
  } catch (error) {
    return {
      name,
      valid: false,
      workflow: 'unknown',
      phase: 'invalid',
      currentStep: null,
      nextCommand: null,
      runtimeMode: 'invalid',
      runtimeEval: null,
      evidence: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
