import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveOwnerEntry } from '../../../domains/owner-entry/resolve-entry.js';
import { resolveOrActivateOwnerEntry } from '../../../domains/owner-entry/project-activation.js';
import { writeWorkflowGlobalConfig } from '../../../domains/workflow-contract/global-config.js';
import {
  defaultProjectConfig,
  writeProjectConfig,
} from '../../../domains/owner-loop/loop-config.js';

describe('Owner entry resolution', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-entry-'));
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('does not guess a Pipeline workflow when project config is absent', async () => {
    const before = await fs.readdir(projectRoot);

    await expect(resolveOwnerEntry(projectRoot)).rejects.toThrow(
      'Owner workflow entry is unavailable',
    );

    expect(await fs.readdir(projectRoot)).toEqual(before);
    await expect(fs.access(path.join(projectRoot, '.owner', 'config.yaml'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('activates an unconfigured project from the global workflow template', async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-global-home-'));
    await fs.mkdir(path.join(projectRoot, '.git'));
    const globalConfig = defaultProjectConfig('artifacts', 'zh-CN');
    globalConfig.workflows = ['loop'];
    await writeWorkflowGlobalConfig(homeDir, {
      ...globalConfig,
      schema: 'owner.global.v1',
    });

    try {
      await expect(resolveOrActivateOwnerEntry(projectRoot, { homeDir })).resolves.toEqual({
        workflow: 'loop',
        skill: 'owner-loop',
        source: 'global-config',
      });

      await expect(
        fs.readFile(path.join(projectRoot, '.owner', 'config.yaml'), 'utf8'),
      ).resolves.toContain('artifact_root: artifacts');
      await expect(
        fs.access(path.join(projectRoot, 'artifacts', 'owner', 'changes')),
      ).resolves.toBeUndefined();
      await expect(
        fs.access(path.join(homeDir, 'artifacts', 'owner', 'changes')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it('keeps an activated project stable after the global template changes', async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-global-home-'));
    await fs.mkdir(path.join(projectRoot, '.git'));
    const initial = defaultProjectConfig('docs');
    await writeWorkflowGlobalConfig(homeDir, { ...initial, schema: 'owner.global.v1' });

    try {
      await resolveOrActivateOwnerEntry(projectRoot, { homeDir });
      const changed = defaultProjectConfig('other-root');
      changed.default_workflow = 'pipeline';
      changed.workflows = ['pipeline'];
      await writeWorkflowGlobalConfig(homeDir, {
        ...changed,
        schema: 'owner.global.v1',
      });

      await expect(resolveOrActivateOwnerEntry(projectRoot, { homeDir })).resolves.toEqual({
        workflow: 'loop',
        skill: 'owner-loop',
        source: 'project-config',
      });
      await expect(
        fs.readFile(path.join(projectRoot, '.owner', 'config.yaml'), 'utf8'),
      ).resolves.toContain('artifact_root: docs');
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it('uses a built-in Loop default when no global template exists', async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-empty-home-'));
    await fs.mkdir(path.join(projectRoot, '.git'));
    try {
      await expect(resolveOrActivateOwnerEntry(projectRoot, { homeDir })).resolves.toEqual({
        workflow: 'loop',
        skill: 'owner-loop',
        source: 'built-in-default',
      });
      await expect(
        fs.access(path.join(projectRoot, 'docs', 'owner', 'changes')),
      ).resolves.toBeUndefined();
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it('fails closed on malformed global config without activating the project', async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-broken-home-'));
    await fs.mkdir(path.join(homeDir, '.owner'), { recursive: true });
    await fs.writeFile(path.join(homeDir, '.owner', 'config.yaml'), 'schema: [\n', 'utf8');
    try {
      await expect(resolveOrActivateOwnerEntry(projectRoot, { homeDir })).rejects.toThrow(
        'Invalid global Owner config',
      );
      await expect(
        fs.access(path.join(projectRoot, '.owner', 'config.yaml')),
      ).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it.each([
    ['loop', 'owner-loop'],
    ['pipeline', 'owner-pipeline'],
  ] as const)('obeys an explicit %s project default', async (workflow, skill) => {
    const config = defaultProjectConfig('docs');
    config.default_workflow = workflow;
    await writeProjectConfig(projectRoot, config);
    const before = await fs.readFile(path.join(projectRoot, '.owner', 'config.yaml'));

    await expect(resolveOwnerEntry(projectRoot)).resolves.toEqual({
      workflow,
      skill,
      source: 'project-config',
    });

    await expect(fs.readFile(path.join(projectRoot, '.owner', 'config.yaml'))).resolves.toEqual(
      before,
    );
  });

  it('discovers the configured project when resolution starts in a nested directory', async () => {
    const nested = path.join(projectRoot, 'packages', 'app', 'src');
    await fs.mkdir(nested, { recursive: true });
    await fs.mkdir(path.join(projectRoot, '.git'));
    await writeProjectConfig(projectRoot, defaultProjectConfig('docs'));

    await expect(resolveOwnerEntry(nested)).resolves.toMatchObject({
      workflow: 'loop',
      skill: 'owner-loop',
      source: 'project-config',
    });
  });

  it('fails closed for malformed YAML instead of using the Pipeline fallback', async () => {
    await fs.mkdir(path.join(projectRoot, '.owner'));
    await fs.writeFile(path.join(projectRoot, '.owner', 'config.yaml'), 'schema: [', 'utf8');

    await expect(resolveOwnerEntry(projectRoot)).rejects.toThrow();
  });

  it('accepts unknown extension fields without changing workflow ownership', async () => {
    await fs.mkdir(path.join(projectRoot, '.owner'));
    await fs.writeFile(
      path.join(projectRoot, '.owner', 'config.yaml'),
      [
        'schema: owner.project.v1',
        'default_workflow: loop',
        'loop:',
        '  artifact_root: .',
        '  unexpected: true',
        '',
      ].join('\n'),
      'utf8',
    );

    await expect(resolveOwnerEntry(projectRoot)).resolves.toMatchObject({
      workflow: 'loop',
      source: 'project-config',
    });
  });
});
