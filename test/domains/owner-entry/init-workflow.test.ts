import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveInitWorkflow } from '../../../domains/owner-entry/init-workflow.js';
import {
  defaultProjectConfig,
  writeProjectConfig,
} from '../../../domains/owner-loop/loop-config.js';

describe('Owner init workflow policy', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-init-workflow-'));
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('defaults a project with no Owner history to Loop without writing during resolution', async () => {
    const before = await fs.readdir(projectRoot);

    await expect(resolveInitWorkflow(projectRoot)).resolves.toEqual({
      workflow: 'loop',
      source: 'new-project-default',
      artifactRoot: 'docs',
      pipelineArtifactLayout: 'docs',
      writeProjectConfig: true,
      legacyEvidence: [],
    });

    expect(await fs.readdir(projectRoot)).toEqual(before);
  });

  it.each([
    '.owner/config.yaml',
    'openspec/changes/active-change/.owner.yaml',
    'openspec/changes/archive/old-change/.owner.yaml',
  ])('preserves the Pipeline fallback when legacy evidence exists at %s', async (legacyPath) => {
    const file = path.join(projectRoot, ...legacyPath.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'workflow: full\n', 'utf8');

    await expect(resolveInitWorkflow(projectRoot)).resolves.toMatchObject({
      workflow: 'pipeline',
      source: 'legacy-project',
      writeProjectConfig: false,
      legacyEvidence: [legacyPath],
    });
  });

  it.each(['openspec', 'docs/superpowers'])(
    'does not mistake standalone %s usage for an existing Owner Pipeline project',
    async (standalonePath) => {
      await fs.mkdir(path.join(projectRoot, ...standalonePath.split('/')), { recursive: true });

      await expect(resolveInitWorkflow(projectRoot)).resolves.toMatchObject({
        workflow: 'loop',
        source: 'new-project-default',
        writeProjectConfig: true,
        legacyEvidence: [],
      });
    },
  );

  it('treats a managed Ambient Resume block as legacy Owner evidence', async () => {
    await fs.writeFile(
      path.join(projectRoot, 'AGENTS.md'),
      '<owner-ambient-resume>\nold guidance\n</owner-ambient-resume>\n',
      'utf8',
    );

    await expect(resolveInitWorkflow(projectRoot)).resolves.toMatchObject({
      workflow: 'pipeline',
      source: 'legacy-project',
      legacyEvidence: ['AGENTS.md#owner-ambient-resume'],
    });
  });

  it('does not mistake the workflow-neutral v2 resume block for Pipeline state', async () => {
    await fs.writeFile(
      path.join(projectRoot, 'AGENTS.md'),
      [
        '<owner-ambient-resume>',
        '<!-- Contract: owner.resume_probe.v2 -->',
        '</owner-ambient-resume>',
        '',
      ].join('\n'),
      'utf8',
    );

    await expect(resolveInitWorkflow(projectRoot)).resolves.toMatchObject({
      workflow: 'loop',
      source: 'new-project-default',
      legacyEvidence: [],
    });
  });

  it('does not scan legacy change evidence through a junction', async () => {
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-init-workflow-outside-'));
    try {
      await fs.mkdir(path.join(projectRoot, 'openspec'), { recursive: true });
      await fs.mkdir(path.join(outsideRoot, 'external-change'), { recursive: true });
      await fs.writeFile(
        path.join(outsideRoot, 'external-change', '.owner.yaml'),
        'workflow: full\n',
        'utf8',
      );
      try {
        await fs.symlink(
          outsideRoot,
          path.join(projectRoot, 'openspec', 'changes'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
        throw error;
      }

      await expect(resolveInitWorkflow(projectRoot)).rejects.toThrow(/symbolic link or junction/iu);
    } finally {
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it('does not read Ambient Resume evidence through a linked file', async () => {
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-init-resume-outside-'));
    const outsideFile = path.join(outsideRoot, 'AGENTS.md');
    try {
      await fs.writeFile(
        outsideFile,
        '<owner-ambient-resume>\nold guidance\n</owner-ambient-resume>\n',
        'utf8',
      );
      try {
        await fs.symlink(outsideFile, path.join(projectRoot, 'AGENTS.md'), 'file');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
        throw error;
      }

      await expect(resolveInitWorkflow(projectRoot)).rejects.toThrow(
        /symbolic link or junction|alias must point/iu,
      );
    } finally {
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it('accepts an AGENTS.md alias that points to the in-project CLAUDE.md file', async () => {
    await fs.writeFile(path.join(projectRoot, 'CLAUDE.md'), '# Project instructions\n', 'utf8');
    try {
      await fs.symlink('CLAUDE.md', path.join(projectRoot, 'AGENTS.md'), 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }

    await expect(resolveInitWorkflow(projectRoot)).resolves.toMatchObject({
      workflow: 'loop',
      source: 'new-project-default',
      legacyEvidence: [],
    });
  });

  it('lets an explicit Loop choice override legacy fallback and select a custom root', async () => {
    const state = path.join(projectRoot, 'openspec', 'changes', 'legacy', '.owner.yaml');
    await fs.mkdir(path.dirname(state), { recursive: true });
    await fs.writeFile(state, 'workflow: full\n', 'utf8');

    await expect(
      resolveInitWorkflow(projectRoot, { workflow: 'loop', artifactRoot: 'docs' }),
    ).resolves.toMatchObject({
      workflow: 'loop',
      source: 'explicit-option',
      artifactRoot: 'docs',
      pipelineArtifactLayout: 'legacy',
      writeProjectConfig: true,
      legacyEvidence: ['openspec/changes/legacy/.owner.yaml'],
    });
  });

  it('treats an explicit Loop root as an explicit Loop choice', async () => {
    await fs.mkdir(path.join(projectRoot, '.owner'));
    await fs.writeFile(path.join(projectRoot, '.owner', 'config.yaml'), 'language: en\n', 'utf8');

    await expect(resolveInitWorkflow(projectRoot, { artifactRoot: 'docs' })).resolves.toMatchObject(
      {
        workflow: 'loop',
        source: 'explicit-option',
        artifactRoot: 'docs',
        pipelineArtifactLayout: 'docs',
        writeProjectConfig: true,
      },
    );
  });

  it('persists an explicit Pipeline choice for a new project', async () => {
    await expect(resolveInitWorkflow(projectRoot, { workflow: 'pipeline' })).resolves.toEqual({
      workflow: 'pipeline',
      source: 'explicit-option',
      artifactRoot: 'docs',
      pipelineArtifactLayout: 'docs',
      writeProjectConfig: true,
      legacyEvidence: [],
    });
  });

  it.each(['loop', 'pipeline'] as const)(
    'keeps an existing %s project config authoritative',
    async (workflow) => {
      const config = defaultProjectConfig('docs');
      config.default_workflow = workflow;
      await writeProjectConfig(projectRoot, config);

      await expect(resolveInitWorkflow(projectRoot)).resolves.toEqual({
        workflow,
        source: 'project-config',
        artifactRoot: 'docs',
        pipelineArtifactLayout: 'docs',
        writeProjectConfig: false,
        legacyEvidence: [],
      });
    },
  );

  it('chooses docs when a Loop-only project enables Pipeline for the first time', async () => {
    await writeProjectConfig(projectRoot, defaultProjectConfig('docs'));

    await expect(resolveInitWorkflow(projectRoot, { workflow: 'pipeline' })).resolves.toMatchObject(
      {
        workflow: 'pipeline',
        source: 'explicit-option',
        artifactRoot: 'docs',
        pipelineArtifactLayout: 'docs',
        writeProjectConfig: true,
      },
    );
  });

  it('lets an explicit workflow change only the configured default entry', async () => {
    await writeProjectConfig(projectRoot, defaultProjectConfig('.'));

    await expect(resolveInitWorkflow(projectRoot, { workflow: 'pipeline' })).resolves.toEqual({
      workflow: 'pipeline',
      source: 'explicit-option',
      artifactRoot: '.',
      pipelineArtifactLayout: 'docs',
      writeProjectConfig: true,
      legacyEvidence: [],
    });
  });

  it('preserves an explicit dormant Pipeline layout when a Loop-only project enables Pipeline', async () => {
    const config = defaultProjectConfig('docs');
    config.pipeline = { artifact_layout: 'legacy' };
    await writeProjectConfig(projectRoot, config);

    await expect(resolveInitWorkflow(projectRoot, { workflow: 'pipeline' })).resolves.toMatchObject(
      {
        workflow: 'pipeline',
        pipelineArtifactLayout: 'legacy',
        writeProjectConfig: true,
      },
    );
  });

  it('fails closed when an explicit root conflicts with project config', async () => {
    await writeProjectConfig(projectRoot, defaultProjectConfig('docs'));

    await expect(resolveInitWorkflow(projectRoot, { artifactRoot: 'artifacts' })).rejects.toThrow(
      /configured Loop artifact root is docs/u,
    );
  });

  it('rejects a Loop artifact root for an explicitly Pipeline initialization', async () => {
    await expect(
      resolveInitWorkflow(projectRoot, { workflow: 'pipeline', artifactRoot: 'docs' }),
    ).rejects.toThrow(/--root is only valid with the Loop workflow/u);
  });
});
