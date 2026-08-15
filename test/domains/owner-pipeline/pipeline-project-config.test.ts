import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { readPipelineConfigValue } from '../../../domains/owner-pipeline/pipeline-project-config.js';

describe('Pipeline project config', () => {
  let projectRoot: string;
  let homeDir: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-pipeline-config-project-'));
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-pipeline-config-home-'));
  });

  afterEach(async () => {
    await Promise.all([
      fs.rm(projectRoot, { recursive: true, force: true }),
      fs.rm(homeDir, { recursive: true, force: true }),
    ]);
  });

  async function writeConfig(root: string, source: string): Promise<void> {
    const configFile = path.join(root, '.owner', 'config.yaml');
    await fs.mkdir(path.dirname(configFile), { recursive: true });
    await fs.writeFile(configFile, source, 'utf8');
  }

  it('reads Pipeline settings only from the nested block', async () => {
    await writeConfig(projectRoot, 'pipeline:\n  language: zh-CN\n  review_mode: thorough\n');

    await expect(
      readPipelineConfigValue('review_mode', { cwd: projectRoot, homeDir }),
    ).resolves.toEqual({ value: 'thorough', source: '.owner/config.yaml' });
  });

  it('ignores legacy top-level settings and falls through to the global nested block', async () => {
    await writeConfig(projectRoot, 'review_mode: off\n');
    await writeConfig(homeDir, 'pipeline:\n  review_mode: thorough\n');

    await expect(
      readPipelineConfigValue('review_mode', { cwd: projectRoot, homeDir }),
    ).resolves.toEqual({ value: 'thorough', source: '~/.owner/config.yaml' });
  });

  it('reads Pipeline settings from the complete global schema', async () => {
    await writeConfig(
      homeDir,
      [
        'schema: owner.global.v1',
        'default_workflow: pipeline',
        'workflows: [pipeline]',
        'ambient_resume: true',
        'pipeline:',
        '  language: zh-CN',
        '  review_mode: thorough',
        '',
      ].join('\n'),
    );

    await expect(
      readPipelineConfigValue('review_mode', { cwd: projectRoot, homeDir }),
    ).resolves.toEqual({ value: 'thorough', source: '~/.owner/config.yaml' });
  });

  it('returns null when only a legacy top-level setting exists', async () => {
    await writeConfig(projectRoot, 'auto_transition: false\n');

    await expect(
      readPipelineConfigValue('auto_transition', { cwd: projectRoot, homeDir }),
    ).resolves.toBeNull();
  });

  it('fails closed when another project-config field is malformed', async () => {
    await writeConfig(
      projectRoot,
      'pipeline:\n  context_compression: beta\nunrelated: [unterminated\n',
    );

    await expect(
      readPipelineConfigValue('context_compression', { cwd: projectRoot, homeDir }),
    ).rejects.toThrow('Invalid .owner/config.yaml');
  });

  it('fails closed for duplicate keys instead of selecting one value', async () => {
    await writeConfig(projectRoot, 'pipeline:\n  review_mode: standard\n  review_mode: thorough\n');

    await expect(
      readPipelineConfigValue('review_mode', { cwd: projectRoot, homeDir }),
    ).rejects.toThrow('Invalid .owner/config.yaml');
  });

  it('rejects a linked project config instead of following it', async () => {
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-pipeline-config-outside-'));
    try {
      await fs.mkdir(path.join(projectRoot, '.owner'), { recursive: true });
      const outsideConfig = path.join(outsideRoot, 'config.yaml');
      await fs.writeFile(outsideConfig, 'pipeline:\n  review_mode: thorough\n', 'utf8');
      try {
        await fs.symlink(outsideConfig, path.join(projectRoot, '.owner', 'config.yaml'), 'file');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
        throw error;
      }

      await expect(
        readPipelineConfigValue('review_mode', { cwd: projectRoot, homeDir }),
      ).rejects.toThrow(/symbolic link or junction/iu);
    } finally {
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });
});
