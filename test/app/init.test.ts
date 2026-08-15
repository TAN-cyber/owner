import { describe, expect, it } from 'vitest';
import { applyBulkOverwriteChoice } from '../../app/commands/init.js';
import { mergeProjectConfig } from '../../domains/skill/platform-install.js';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { parse } from 'yaml';

describe('init command helpers', () => {
  it('can apply a single overwrite choice to all existing components on a platform', () => {
    const plan = {
      osAction: 'install' as const,
      spAction: 'install' as const,
      cmAction: 'install' as const,
    };

    expect(applyBulkOverwriteChoice(plan, 'overwrite-all')).toEqual({
      osAction: 'overwrite',
      spAction: 'overwrite',
      cmAction: 'overwrite',
    });
    expect(applyBulkOverwriteChoice(plan, 'skip-all')).toEqual({
      osAction: 'skip',
      spAction: 'skip',
      cmAction: 'skip',
    });
  });

  it('only affects existing components when hasExisting is provided with skip-all', () => {
    const plan = {
      osAction: 'install' as const,
      spAction: 'install' as const,
      cmAction: 'install' as const,
    };
    const hasExisting = { os: true, sp: false, cm: true };

    expect(applyBulkOverwriteChoice(plan, 'skip-all', hasExisting)).toEqual({
      osAction: 'skip',
      spAction: 'install',
      cmAction: 'skip',
    });
  });

  it('only affects existing components when hasExisting is provided with overwrite-all', () => {
    const plan = {
      osAction: 'install' as const,
      spAction: 'install' as const,
      cmAction: 'install' as const,
    };
    const hasExisting = { os: false, sp: true, cm: false };

    expect(applyBulkOverwriteChoice(plan, 'overwrite-all', hasExisting)).toEqual({
      osAction: 'install',
      spAction: 'overwrite',
      cmAction: 'install',
    });
  });

  it('creates a project Owner config with context compression disabled by default', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-init-config-'));

    try {
      await mergeProjectConfig(tmpDir, 'zh-CN', 'docs');

      const config = await fs.readFile(path.join(tmpDir, '.owner', 'config.yaml'), 'utf-8');
      expect(parse(config)).toMatchObject({
        ambient_resume: true,
        pipeline: {
          artifact_layout: 'docs',
          language: 'zh-CN',
          context_compression: 'off',
          review_mode: 'standard',
          auto_transition: true,
        },
      });
      expect(config).not.toMatch(/^(language|context_compression|review_mode|auto_transition):/mu);
      expect(config).toContain('# Pipeline 工作流文档使用的产物语言');
      expect(config).toContain('artifact_layout: docs');
      expect(config).toContain('language: zh-CN');
      expect(config).toContain('# 新建 Pipeline change 是否启用 beta 上下文压缩');
      expect(config).toContain('context_compression: off');
      expect(config).toContain('# 新建 Pipeline change 默认使用的审查深度');
      expect(config).toContain('review_mode: standard');
      expect(config).toContain('# Pipeline 阶段通过后是否自动进入下一阶段');
      expect(config).toContain('auto_transition: true');
      expect(config).toContain('# 是否启用只读的环境感知恢复探针');
      expect(config).toContain('ambient_resume: true');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('preserves existing user config values and fills missing managed fields', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-init-merge-'));

    try {
      await fs.mkdir(path.join(tmpDir, '.owner'), { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, '.owner', 'config.yaml'),
        'context_compression: beta\ncustom_key: custom_value\n',
        'utf-8',
      );

      await mergeProjectConfig(tmpDir);

      const config = await fs.readFile(path.join(tmpDir, '.owner', 'config.yaml'), 'utf-8');
      expect(config).toContain('language: en');
      expect(config).toContain('context_compression: beta');
      expect(config).toContain('review_mode: standard');
      expect(config).toContain('auto_transition: true');
      expect(config).toContain('custom_key: custom_value');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('defaults the project Owner config language to en when createWorkingDirs is called without one', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-init-config-default-'));

    try {
      await mergeProjectConfig(tmpDir);

      const config = await fs.readFile(path.join(tmpDir, '.owner', 'config.yaml'), 'utf-8');
      expect(config).toContain('# language: en | zh-CN');
      expect(config).toContain('language: en');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
