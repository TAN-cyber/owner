import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import {
  assertPipelineLayoutReadable,
  assertPipelineLayoutWritable,
  pipelineLayoutPaths,
  discoverPipelineProject,
  inspectPipelineLayout,
  readPipelineArtifactLayout,
} from '../../../domains/owner-pipeline/pipeline-layout.js';

const roots: string[] = [];

async function project(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-pipeline-layout-'));
  roots.push(root);
  await fs.mkdir(path.join(root, '.git'));
  return root;
}

async function externalDirectory(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-pipeline-layout-outside-'));
  roots.push(root);
  return root;
}

async function directoryLink(target: string, link: string): Promise<void> {
  await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

async function config(root: string, pipeline: string): Promise<void> {
  await fs.mkdir(path.join(root, '.owner'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.owner', 'config.yaml'),
    `schema: owner.project.v1\ndefault_workflow: pipeline\nloop:\n  artifact_root: docs\npipeline:\n${pipeline}`,
    'utf8',
  );
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('Pipeline artifact layout', () => {
  it('does not guess a Pipeline layout when project config is missing', async () => {
    const root = await project();

    await expect(readPipelineArtifactLayout(root)).rejects.toThrow(
      'Pipeline artifact layout is unavailable',
    );
  });

  it('does not treat a Loop-only project as legacy Pipeline', async () => {
    const root = await project();
    await fs.mkdir(path.join(root, '.owner'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.owner', 'config.yaml'),
      [
        'schema: owner.project.v1',
        'default_workflow: loop',
        'workflows: [loop]',
        'loop:',
        '  artifact_root: docs',
        '',
      ].join('\n'),
      'utf8',
    );

    await expect(readPipelineArtifactLayout(root)).rejects.toThrow(
      'Pipeline artifact layout is unavailable because Pipeline is not enabled',
    );
  });

  it('defaults a missing Pipeline layout to docs', async () => {
    const root = await project();
    await config(root, '  language: zh-CN\n');

    await expect(readPipelineArtifactLayout(root)).resolves.toBe('docs');
    expect(pipelineLayoutPaths(root, 'docs').changesDir).toBe(
      path.join(root, 'docs', 'openspec', 'changes'),
    );
  });

  it('resolves the docs catalogue without changing the Superpowers root', async () => {
    const root = await project();
    await config(root, '  artifact_layout: docs\n');

    const inspection = await inspectPipelineLayout(root);
    expect(inspection.paths.openSpecRoot).toBe(path.join(root, 'docs', 'openspec'));
    expect(inspection.paths.superpowersRoot).toBe(path.join(root, 'docs', 'superpowers'));
  });

  it('rejects invalid layout values', async () => {
    const root = await project();
    await config(root, '  artifact_layout: elsewhere\n');

    await expect(readPipelineArtifactLayout(root)).rejects.toThrow(
      'pipeline.artifact_layout must be legacy or docs',
    );
  });

  it('fails closed when unrelated project-config YAML is malformed', async () => {
    const root = await project();
    await config(root, '  artifact_layout: docs\nextension: [unterminated\n');

    await expect(readPipelineArtifactLayout(root)).rejects.toThrow('Invalid .owner/config.yaml');
  });

  it('keeps the configured Pipeline root writable when a standalone OpenSpec root also exists', async () => {
    const root = await project();
    await config(root, '  artifact_layout: docs\n');
    await fs.mkdir(path.join(root, 'openspec'), { recursive: true });
    await fs.mkdir(path.join(root, 'docs', 'openspec'), { recursive: true });

    await expect(assertPipelineLayoutWritable(root)).resolves.toMatchObject({
      artifactLayout: 'docs',
      openSpecRoot: path.join(root, 'docs', 'openspec'),
    });
  });

  it('allows initialization to use its selected root without mutating an alternate root', async () => {
    const root = await project();
    await config(root, '  artifact_layout: docs\n');
    await fs.mkdir(path.join(root, 'openspec'), { recursive: true });
    await fs.mkdir(path.join(root, 'docs', 'openspec'), { recursive: true });

    await expect(assertPipelineLayoutWritable(root, 'docs')).resolves.toMatchObject({
      artifactLayout: 'docs',
      openSpecRoot: path.join(root, 'docs', 'openspec'),
    });
  });

  it('reads the configured root without scanning the standalone OpenSpec root', async () => {
    const root = await project();
    await config(root, '  artifact_layout: docs\n');
    await fs.mkdir(path.join(root, 'openspec'), { recursive: true });
    await fs.mkdir(path.join(root, 'docs', 'openspec'), { recursive: true });

    await expect(assertPipelineLayoutReadable(root)).resolves.toMatchObject({
      artifactLayout: 'docs',
      openSpecRoot: path.join(root, 'docs', 'openspec'),
    });
  });

  it('keeps the configured root readable when the standalone root is a directory link', async () => {
    const root = await project();
    const outside = await externalDirectory();
    await config(root, '  artifact_layout: docs\n');
    await fs.mkdir(path.join(root, 'docs', 'openspec'), { recursive: true });
    await directoryLink(outside, path.join(root, 'openspec'));

    await expect(assertPipelineLayoutReadable(root)).resolves.toMatchObject({
      artifactLayout: 'docs',
      openSpecRoot: path.join(root, 'docs', 'openspec'),
    });
  });

  it('fails closed for writes when the configured OpenSpec root is missing', async () => {
    const root = await project();
    await config(root, '  artifact_layout: docs\n');

    await expect(assertPipelineLayoutWritable(root)).rejects.toThrow(
      'Configured Pipeline OpenSpec root is missing: docs/openspec',
    );
  });

  it('reports both root states when the configured root is missing', async () => {
    const root = await project();
    await config(root, '  artifact_layout: docs\n');

    await expect(assertPipelineLayoutReadable(root)).rejects.toThrow(
      'Configured Pipeline OpenSpec root is missing: docs/openspec (alternate openspec is missing)',
    );

    await fs.mkdir(path.join(root, 'openspec'), { recursive: true });
    await expect(assertPipelineLayoutReadable(root)).rejects.toThrow(
      'Configured Pipeline OpenSpec root is missing: docs/openspec (alternate openspec is present)',
    );
  });

  it('fails closed for writes when the configured OpenSpec root is not a directory', async () => {
    const root = await project();
    await config(root, '  artifact_layout: docs\n');
    await fs.mkdir(path.join(root, 'docs'), { recursive: true });
    await fs.writeFile(path.join(root, 'docs', 'openspec'), 'not a directory\n');

    await expect(assertPipelineLayoutWritable(root)).rejects.toThrow(/must be a real directory/u);
  });

  it('allows read-only layout inspection while a root move journal is pending', async () => {
    const root = await project();
    await config(root, '  artifact_layout: legacy\n');
    await fs.mkdir(path.join(root, 'openspec'), { recursive: true });
    await fs.writeFile(path.join(root, '.owner', 'pipeline-root-move.json'), '{}\n');

    await expect(assertPipelineLayoutReadable(root)).resolves.toMatchObject({
      artifactLayout: 'legacy',
      openSpecRoot: path.join(root, 'openspec'),
    });
    await expect(assertPipelineLayoutWritable(root)).rejects.toThrow(
      /Pipeline root move transaction is incomplete/u,
    );
  });

  it.each([
    ['legacy OpenSpec root', 'legacy'],
    ['docs ancestor', 'docs'],
  ])('fails closed when the %s escapes through a directory link', async (_label, layout) => {
    const root = await project();
    const outside = await externalDirectory();
    await config(root, `  artifact_layout: ${layout}\n`);
    await fs.mkdir(path.join(outside, 'openspec'), { recursive: true });
    await fs.writeFile(path.join(outside, 'keep.txt'), 'keep\n');

    if (layout === 'legacy') {
      await directoryLink(path.join(outside, 'openspec'), path.join(root, 'openspec'));
    } else {
      await directoryLink(outside, path.join(root, 'docs'));
    }

    await expect(assertPipelineLayoutWritable(root)).rejects.toThrow(/symbolic link or junction/u);
    await expect(fs.readFile(path.join(outside, 'keep.txt'), 'utf8')).resolves.toBe('keep\n');
  });

  it('fails closed before reading config through a linked .owner ancestor', async () => {
    const root = await project();
    const outside = await externalDirectory();
    await fs.writeFile(
      path.join(outside, 'config.yaml'),
      'pipeline:\n  artifact_layout: docs\n',
      'utf8',
    );
    await directoryLink(outside, path.join(root, '.owner'));

    await expect(readPipelineArtifactLayout(root)).rejects.toThrow(/symbolic link or junction/u);
  });

  it('discovers a project from a nested Pipeline artifact directory', async () => {
    const root = await project();
    const nested = path.join(root, 'docs', 'openspec', 'changes', 'demo');
    await fs.mkdir(nested, { recursive: true });

    await expect(discoverPipelineProject(nested)).resolves.toBe(root);
  });
});
