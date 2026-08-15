import { pipelineProjectTargetExists } from './pipeline-protected-path.js';
import { assertPipelineLayoutReadable } from './pipeline-layout.js';
import path from 'node:path';

export type PipelinePlanReadiness =
  | { status: 'missing'; recordedPath: null }
  | { status: 'broken'; recordedPath: string }
  | { status: 'ready'; recordedPath: string };

export async function inspectPipelinePlanReadiness(
  projectRoot: string,
  plan: string | null,
): Promise<PipelinePlanReadiness> {
  if (!plan || plan === 'null') return { status: 'missing', recordedPath: null };

  const layout = await assertPipelineLayoutReadable(projectRoot);
  const planPath = path.resolve(projectRoot, plan);
  const relativeToPlans = path.relative(layout.superpowersPlansDir, planPath);
  if (
    path.isAbsolute(plan) ||
    !relativeToPlans ||
    relativeToPlans.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToPlans) ||
    relativeToPlans.includes(path.sep) ||
    path.extname(relativeToPlans).toLowerCase() !== '.md'
  ) {
    return { status: 'broken', recordedPath: plan };
  }

  const exists = await pipelineProjectTargetExists(projectRoot, plan, {
    label: `Pipeline build plan ${plan}`,
    expected: 'file',
  });
  return exists
    ? { status: 'ready', recordedPath: plan }
    : { status: 'broken', recordedPath: plan };
}
