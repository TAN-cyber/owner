import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultProjectConfig } from '../../../domains/owner-loop/loop-config.js';
import {
  readWorkflowGlobalConfig,
  writeWorkflowGlobalConfig,
} from '../../../domains/workflow-contract/global-config.js';

describe('global workflow configuration', () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-global-config-'));
  });

  afterEach(async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
  });

  it('stores a complete global template with project-relative artifact paths', async () => {
    const project = defaultProjectConfig('docs', 'zh-CN');

    await writeWorkflowGlobalConfig(homeDir, {
      ...project,
      schema: 'owner.global.v1',
    });

    await expect(readWorkflowGlobalConfig(homeDir)).resolves.toMatchObject({
      schema: 'owner.global.v1',
      default_workflow: 'loop',
      workflows: ['loop'],
      loop: { artifact_root: 'docs', language: 'zh-CN' },
    });
    const source = await fs.readFile(path.join(homeDir, '.owner', 'config.yaml'), 'utf8');
    expect(source).toContain('schema: owner.global.v1');
    expect(source).not.toMatch(/^\s+snapshot:/mu);
  });

  it('rejects absolute global artifact templates', async () => {
    const project = defaultProjectConfig('docs');
    project.loop.artifact_root = path.resolve(homeDir, 'artifacts');

    await expect(
      writeWorkflowGlobalConfig(homeDir, {
        ...project,
        schema: 'owner.global.v1',
      }),
    ).rejects.toThrow('loop.artifact_root must be a project-relative path');
  });

  it('rejects project-only Loop root-move state in a global template', async () => {
    const project = defaultProjectConfig('docs');
    project.loop.pending_root_move = {
      id: 'move-1',
      fromArtifactRoot: 'docs',
      toArtifactRoot: 'artifacts',
      stage: 'ready',
    };

    await expect(
      writeWorkflowGlobalConfig(homeDir, {
        ...project,
        schema: 'owner.global.v1',
      }),
    ).rejects.toThrow('Global Owner config cannot contain loop.pending_root_move');
  });

  it('migrates legacy global Pipeline defaults without changing their values', async () => {
    await fs.mkdir(path.join(homeDir, '.owner'));
    await fs.writeFile(
      path.join(homeDir, '.owner', 'config.yaml'),
      [
        'ambient_resume: false',
        'pipeline:',
        '  language: zh-CN',
        '  artifact_layout: legacy',
        '  review_mode: thorough',
        '',
      ].join('\n'),
      'utf8',
    );

    await expect(readWorkflowGlobalConfig(homeDir)).resolves.toMatchObject({
      schema: 'owner.global.v1',
      default_workflow: 'pipeline',
      workflows: ['pipeline'],
      ambient_resume: false,
      pipeline: {
        language: 'zh-CN',
        artifact_layout: 'legacy',
        review_mode: 'thorough',
      },
    });
  });
});
