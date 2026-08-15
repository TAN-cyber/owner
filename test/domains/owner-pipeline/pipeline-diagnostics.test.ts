import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { inspectPipelineChange } from '../../../domains/owner-pipeline/pipeline-diagnostics.js';
import { runPipelineCli } from '../../../domains/owner-pipeline/pipeline-cli.js';
import { preparePipelineLegacyProject } from '../../helpers/pipeline-project.js';

describe('Pipeline diagnostics', () => {
  let projectRoot: string;
  let changeDir: string;
  let previousCwd: string;

  beforeEach(async () => {
    previousCwd = process.cwd();
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-diagnostics-'));
    await preparePipelineLegacyProject(projectRoot);
    changeDir = path.join(projectRoot, 'openspec', 'changes', 'demo');
    await fs.mkdir(changeDir, { recursive: true });
    process.chdir(projectRoot);
    await runPipelineCli(['state', 'init', 'demo', 'full']);
    await fs.writeFile(path.join(changeDir, 'proposal.md'), '# Proposal\n');
    await fs.writeFile(path.join(changeDir, 'design.md'), '# Design\n');
    await fs.writeFile(path.join(changeDir, 'tasks.md'), '- [ ] build\n');
  });

  afterEach(async () => {
    process.chdir(previousCwd);
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('returns resolver step, evidence, and next command from one source', async () => {
    const diagnostic = await inspectPipelineChange(changeDir, 'demo');

    expect(diagnostic.name).toBe('demo');
    expect(diagnostic.valid).toBe(true);
    expect(diagnostic.phase).toBe('open');
    expect(diagnostic.currentStep).toBe('full.open');
    expect(diagnostic.nextCommand).toBe('/owner-open');
    expect(diagnostic.evidence.some((item) => item.code === 'openspec.proposal')).toBe(true);
    expect(diagnostic.runtimeMode).toBe('engine-projection');
    expect(diagnostic.runtimeEval).toMatchObject({
      stepId: 'full.open',
      requiredEvidence: ['openspec.proposal', 'openspec.tasks'],
    });
  });

  it('fails closed with an error instead of throwing to callers', async () => {
    await fs.appendFile(path.join(changeDir, '.owner.yaml'), '\nunknown_field: true\n');

    const diagnostic = await inspectPipelineChange(changeDir, 'demo');

    expect(diagnostic.valid).toBe(false);
    expect(diagnostic.error).toContain('unknown field');
    expect(diagnostic.currentStep).toBeNull();
  });
});
