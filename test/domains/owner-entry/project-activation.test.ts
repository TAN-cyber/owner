import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../domains/integrations/openspec.js', () => ({
  installOpenSpec: vi.fn(
    async (
      projectRoot: string,
      _tools: string[],
      _scope: string,
      _cli: boolean,
      layout: string,
    ) => {
      const root =
        layout === 'docs'
          ? path.join(projectRoot, 'docs', 'openspec')
          : path.join(projectRoot, 'openspec');
      await fs.mkdir(path.join(root, 'changes'), { recursive: true });
      await fs.mkdir(path.join(root, 'specs'), { recursive: true });
      await fs.writeFile(path.join(root, 'config.yaml'), 'schema: spec-driven\n', 'utf8');
      return 'installed';
    },
  ),
}));

import { resolveOrActivateOwnerEntry } from '../../../domains/owner-entry/project-activation.js';
import { writeWorkflowGlobalConfig } from '../../../domains/workflow-contract/global-config.js';

describe('Owner project activation', () => {
  let projectRoot: string;
  let homeDir: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-pipeline-activation-'));
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-global-home-'));
    await fs.mkdir(path.join(projectRoot, '.git'));
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
    await fs.rm(homeDir, { recursive: true, force: true });
  });

  it('initializes project-owned Pipeline roots from a global Pipeline default', async () => {
    await writeWorkflowGlobalConfig(homeDir, {
      schema: 'owner.global.v1',
      default_workflow: 'pipeline',
      workflows: ['pipeline'],
      ambient_resume: true,
      pipeline: {
        artifact_layout: 'docs',
        language: 'zh-CN',
        context_compression: 'off',
        review_mode: 'standard',
        auto_transition: true,
      },
    });

    await expect(resolveOrActivateOwnerEntry(projectRoot, { homeDir })).resolves.toEqual({
      workflow: 'pipeline',
      skill: 'owner-pipeline',
      source: 'global-config',
    });
    await expect(
      fs.access(path.join(projectRoot, 'docs', 'openspec', 'config.yaml')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(projectRoot, 'docs', 'superpowers', 'plans')),
    ).resolves.toBeUndefined();
    await expect(
      fs.readFile(path.join(projectRoot, '.owner', 'config.yaml'), 'utf8'),
    ).resolves.toContain('default_workflow: pipeline');
    await expect(fs.readFile(path.join(projectRoot, '.gitignore'), 'utf8')).resolves.toContain(
      '!/.owner/config.yaml',
    );
  });

  it('projects a globally installed Codex Router before publishing project config', async () => {
    await writeWorkflowGlobalConfig(homeDir, {
      schema: 'owner.global.v1',
      default_workflow: 'loop',
      workflows: ['loop'],
      ambient_resume: true,
      loop: {
        artifact_root: 'artifacts',
        language: 'en',
        clarification_mode: 'sequential',
        archive_confirmation: 'automatic',
        max_verify_failures: 3,
        snapshot: {
          include: ['**/*'],
          exclude: [],
          max_files: 1000,
          max_total_bytes: 10485760,
          max_duration_ms: 3000,
        },
      },
    });
    const sourceRouter = path.join(
      homeDir,
      '.agents',
      'skills',
      'owner',
      'scripts',
      'owner-hook-router.mjs',
    );
    await fs.mkdir(path.dirname(sourceRouter), { recursive: true });
    await fs.mkdir(path.join(homeDir, '.codex'), { recursive: true });
    await fs.writeFile(sourceRouter, '// installed global Router\n', 'utf8');

    await resolveOrActivateOwnerEntry(projectRoot, { homeDir });

    await expect(fs.readFile(path.join(projectRoot, '.gitignore'), 'utf8')).resolves.toContain(
      '!/.owner/config.yaml',
    );

    const hooks = await fs.readFile(path.join(projectRoot, '.codex', 'hooks.json'), 'utf8');
    expect(hooks.replaceAll('\\', '/')).toContain(
      `${projectRoot.replaceAll('\\', '/')}/.agents/skills/owner/scripts/owner-hook-router.mjs`,
    );
    await expect(
      fs.access(
        path.join(projectRoot, '.agents', 'skills', 'owner', 'scripts', 'owner-hook-router.mjs'),
      ),
    ).resolves.toBeUndefined();
  });

  it('preserves legacy Pipeline ownership instead of applying a global Loop default', async () => {
    await fs.mkdir(path.join(projectRoot, 'openspec', 'changes', 'legacy-change'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(projectRoot, 'openspec', 'changes', 'legacy-change', '.owner.yaml'),
      'phase: build\n',
      'utf8',
    );
    await writeWorkflowGlobalConfig(homeDir, {
      schema: 'owner.global.v1',
      default_workflow: 'loop',
      workflows: ['loop'],
      ambient_resume: true,
      loop: {
        artifact_root: 'artifacts',
        language: 'en',
        clarification_mode: 'sequential',
        archive_confirmation: 'automatic',
        max_verify_failures: 3,
        snapshot: {
          include: ['**/*'],
          exclude: [],
          max_files: 1000,
          max_total_bytes: 10485760,
          max_duration_ms: 3000,
        },
      },
    });

    await expect(resolveOrActivateOwnerEntry(projectRoot, { homeDir })).resolves.toEqual({
      workflow: 'pipeline',
      skill: 'owner-pipeline',
      source: 'legacy-project',
    });
    await expect(fs.access(path.join(projectRoot, 'artifacts', 'owner'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
