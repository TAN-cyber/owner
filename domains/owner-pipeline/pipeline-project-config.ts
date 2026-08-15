import os from 'os';
import path from 'path';
import { readWorkflowGlobalConfig } from '../workflow-contract/global-config.js';
import { readWorkflowProjectConfigDocument } from '../workflow-contract/project-config-reader.js';

type PipelineConfigValue = {
  value: string;
  source: string;
};

type PipelineConfigOptions = {
  cwd?: string;
  homeDir?: string;
};

function configCandidates(options: PipelineConfigOptions = {}): Array<{
  file: string;
  source: string;
  scope: 'project' | 'global';
}> {
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? os.homedir();
  const candidates = [
    {
      file: path.resolve(cwd, '.owner', 'config.yaml'),
      source: '.owner/config.yaml',
      scope: 'project' as const,
    },
    {
      file: path.resolve(homeDir, '.owner', 'config.yaml'),
      source: '~/.owner/config.yaml',
      scope: 'global' as const,
    },
  ];

  return candidates.filter(
    (candidate, index) => candidates.findIndex((entry) => entry.file === candidate.file) === index,
  );
}

async function readPipelineConfigValue(
  field: string,
  options: PipelineConfigOptions = {},
): Promise<PipelineConfigValue | null> {
  for (const candidate of configCandidates(options)) {
    // 合法文档中的缺字段继续回退默认值或下一个候选；语法损坏、重复键和
    // 已出现的托管字段非法则由共享 project-config seam 统一失败关闭。
    const root = path.dirname(path.dirname(candidate.file));
    const pipeline =
      candidate.scope === 'global'
        ? (await readWorkflowGlobalConfig(root))?.pipeline
        : (
            await readWorkflowProjectConfigDocument(root, {
              allowPartialProject: true,
            })
          )?.value.pipeline;
    if (!pipeline || typeof pipeline !== 'object' || Array.isArray(pipeline)) continue;
    const value = (pipeline as Record<string, unknown>)[field];
    if (value === null || value === undefined) continue;
    return { value: String(value), source: candidate.source };
  }
  return null;
}

export { configCandidates, readPipelineConfigValue };
export type { PipelineConfigOptions, PipelineConfigValue };
