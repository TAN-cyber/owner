import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { PLATFORMS } from '../../../platform/install/platforms.js';

import {
  DEFAULT_LOOP_SNAPSHOT_CONFIG,
  defaultProjectConfig,
  mergeLoopSnapshotExcludes,
  readProjectConfig,
  resolveLoopProject,
  writeProjectConfig,
} from '../../../domains/owner-loop/loop-config.js';

describe('Loop project configuration', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-config-'));
    await fs.mkdir(path.join(projectRoot, '.git'));
    await fs.mkdir(path.join(projectRoot, '.owner'));
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('builds the shared default project config with docs as the Loop artifact root', () => {
    expect(defaultProjectConfig().loop.artifact_root).toBe('docs');
    expect(defaultProjectConfig().loop.clarification_mode).toBe('batch');
    expect(defaultProjectConfig().loop.archive_confirmation).toBe('automatic');
    expect(defaultProjectConfig().loop.max_verify_failures).toBe(5);
    expect(defaultProjectConfig().loop.snapshot).toEqual({
      include: ['**/*'],
      exclude: DEFAULT_LOOP_SNAPSHOT_CONFIG.exclude,
      max_files: 10_000,
      max_total_bytes: 256 * 1024 * 1024,
      max_duration_ms: 60_000,
    });
  });

  it('keeps every supported platform Skill directory outside the default baseline scope', () => {
    expect(DEFAULT_LOOP_SNAPSHOT_CONFIG.exclude).toEqual(
      expect.arrayContaining(PLATFORMS.map((platform) => `${platform.skillsDir}/skills/**`)),
    );
  });

  it('includes common generated, IDE, and Owner-managed paths in default snapshots', () => {
    expect(DEFAULT_LOOP_SNAPSHOT_CONFIG.exclude).toEqual(
      expect.arrayContaining([
        '**/.idea/**',
        '**/.vscode/**',
        '.codex/skills/**',
        '**/node_modules/**',
        '**/dist/**',
        '**/target/**',
        '**/__pycache__/**',
        '**/obj/**',
        '**/logs/**',
        '**/tmp/**',
        '**/temp/**',
      ]),
    );
    expect(DEFAULT_LOOP_SNAPSHOT_CONFIG.exclude).not.toContain('**/bin/**');
  });

  it('preserves custom exclusions while adding missing defaults', () => {
    const merged = mergeLoopSnapshotExcludes(['custom/generated/**', '**/dist/**']);

    expect(merged).toEqual(expect.arrayContaining(['custom/generated/**', '**/dist/**']));
    expect(merged).toEqual(expect.arrayContaining(['**/.idea/**', '**/node_modules/**']));
    expect(new Set(merged).size).toBe(merged.length);
  });

  it('round-trips a custom artifact root without persisting legacy snapshot settings', async () => {
    await writeProjectConfig(projectRoot, defaultProjectConfig('docs'));

    expect(await readProjectConfig(projectRoot)).toEqual({
      schema: 'owner.project.v1',
      default_workflow: 'loop',
      workflows: ['loop'],
      ambient_resume: true,
      loop: {
        artifact_root: 'docs',
        language: 'en',
        clarification_mode: 'batch',
        archive_confirmation: 'automatic',
        max_verify_failures: 5,
        snapshot: {
          include: ['**/*'],
          exclude: DEFAULT_LOOP_SNAPSHOT_CONFIG.exclude,
          max_files: 10_000,
          max_total_bytes: 256 * 1024 * 1024,
          max_duration_ms: 60_000,
        },
      },
    });
    const source = await fs.readFile(path.join(projectRoot, '.owner', 'config.yaml'), 'utf8');
    expect(source).toContain('# Enables automatic recovery');
    expect(source).toContain(
      '# Root directory where Loop stores Owner specs and changes. Runtime data stays under .owner.',
    );
    expect(source).toContain(
      '# Controls how Loop asks clarifying questions: batch asks every currently answerable question per round',
    );
    expect(source).toContain('# Controls whether Loop archives automatically');
    expect(source).toContain(
      '# Maximum failed Verify outcomes allowed for one confirmed acceptance target',
    );
    expect(source).toContain('ambient_resume: true');
    expect(source).toContain('clarification_mode: batch');
    expect(source).toContain('archive_confirmation: automatic');
    expect(source).toContain('max_verify_failures: 5');
    expect(source).not.toMatch(/^\s+snapshot:/mu);
  });

  it('does not write Loop project config through a linked .owner directory', async () => {
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-config-outside-'));
    try {
      await fs.rm(path.join(projectRoot, '.owner'), { recursive: true });
      try {
        await fs.symlink(
          outsideRoot,
          path.join(projectRoot, '.owner'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
        throw error;
      }

      await expect(writeProjectConfig(projectRoot, defaultProjectConfig('docs'))).rejects.toThrow(
        /symbolic link or junction|real directory/iu,
      );
      await expect(fs.access(path.join(outsideRoot, 'config.yaml'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it('does not replace a Loop project config symlink', async () => {
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-link-outside-'));
    const outsideConfig = path.join(outsideRoot, 'config.yaml');
    try {
      await fs.writeFile(outsideConfig, 'keep: true\n', 'utf8');
      try {
        await fs.symlink(outsideConfig, path.join(projectRoot, '.owner', 'config.yaml'), 'file');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
        throw error;
      }

      await expect(writeProjectConfig(projectRoot, defaultProjectConfig('docs'))).rejects.toThrow(
        /symbolic link or junction/iu,
      );
      await expect(fs.readFile(outsideConfig, 'utf8')).resolves.toBe('keep: true\n');
    } finally {
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it('does not overwrite a concurrent project config change before commit', async () => {
    const configPath = path.join(projectRoot, '.owner', 'config.yaml');
    await writeProjectConfig(projectRoot, defaultProjectConfig('docs'));
    const concurrentSource = [
      'schema: owner.project.v1',
      'default_workflow: loop',
      'workflows: [loop]',
      'ambient_resume: true',
      'loop:',
      '  artifact_root: concurrent-root',
      '  language: en',
      '  clarification_mode: sequential',
      'concurrent_extension: keep',
      '',
    ].join('\n');

    await expect(
      writeProjectConfig(projectRoot, defaultProjectConfig('updated-root'), {
        beforeCommit: () => fs.writeFile(configPath, concurrentSource, 'utf8'),
      }),
    ).rejects.toThrow('Project config changed before commit');
    await expect(fs.readFile(configPath, 'utf8')).resolves.toBe(concurrentSource);
  });

  it('round-trips Pipeline layout settings in the shared project config', async () => {
    const value = defaultProjectConfig('docs', 'zh-CN');
    value.default_workflow = 'pipeline';
    value.workflows = ['pipeline'];
    value.pipeline = {
      artifact_layout: 'docs',
      language: 'zh-CN',
      context_compression: 'off',
      review_mode: 'standard',
      auto_transition: true,
    };

    await writeProjectConfig(projectRoot, value);

    await expect(readProjectConfig(projectRoot)).resolves.toEqual(value);
    await expect(
      fs.readFile(path.join(projectRoot, '.owner', 'config.yaml'), 'utf8'),
    ).resolves.toContain('artifact_layout: docs');
  });

  it('normalizes a missing Pipeline layout to docs without changing the schema version', async () => {
    await fs.writeFile(
      path.join(projectRoot, '.owner', 'config.yaml'),
      [
        'schema: owner.project.v1',
        'default_workflow: pipeline',
        'workflows: [pipeline]',
        'loop:',
        '  artifact_root: docs',
        'pipeline:',
        '  language: zh-CN',
        '',
      ].join('\n'),
    );

    const value = await readProjectConfig(projectRoot);
    expect(value?.pipeline?.artifact_layout).toBe('docs');
    expect(value?.schema).toBe('owner.project.v1');
  });

  it('reads an older project config with the missing Loop defaults', async () => {
    await fs.writeFile(
      path.join(projectRoot, '.owner', 'config.yaml'),
      'schema: owner.project.v1\ndefault_workflow: loop\nloop:\n  artifact_root: .\n',
    );

    expect((await readProjectConfig(projectRoot))?.loop.language).toBe('en');
    expect((await readProjectConfig(projectRoot))?.loop.clarification_mode).toBe('batch');
    expect((await readProjectConfig(projectRoot))?.loop.archive_confirmation).toBe('automatic');
    expect((await readProjectConfig(projectRoot))?.loop.max_verify_failures).toBe(5);
    expect((await readProjectConfig(projectRoot))?.loop.snapshot).toEqual(
      defaultProjectConfig().loop.snapshot,
    );
    expect((await readProjectConfig(projectRoot))?.ambient_resume).toBe(true);
  });

  it('round-trips the sequential clarification mode', async () => {
    const config = defaultProjectConfig('docs');
    config.loop.clarification_mode = 'sequential';

    await writeProjectConfig(projectRoot, config);

    expect((await readProjectConfig(projectRoot))?.loop.clarification_mode).toBe('sequential');
    await expect(
      fs.readFile(path.join(projectRoot, '.owner', 'config.yaml'), 'utf8'),
    ).resolves.toContain('clarification_mode: sequential');
  });

  it('round-trips required Loop archive confirmation', async () => {
    const config = defaultProjectConfig('docs');
    config.loop.archive_confirmation = 'required';

    await writeProjectConfig(projectRoot, config);

    expect((await readProjectConfig(projectRoot))?.loop.archive_confirmation).toBe('required');
    await expect(
      fs.readFile(path.join(projectRoot, '.owner', 'config.yaml'), 'utf8'),
    ).resolves.toContain('archive_confirmation: required');
  });

  it('round-trips a custom Loop completion-loop budget', async () => {
    const config = defaultProjectConfig('docs');
    config.loop.max_verify_failures = 8;

    await writeProjectConfig(projectRoot, config);

    expect((await readProjectConfig(projectRoot))?.loop.max_verify_failures).toBe(8);
    await expect(
      fs.readFile(path.join(projectRoot, '.owner', 'config.yaml'), 'utf8'),
    ).resolves.toContain('max_verify_failures: 8');
  });

  it.each(['0', '-1', '1.5', '"five"'])(
    'rejects invalid Loop completion-loop budget %s',
    async (value) => {
      await fs.writeFile(
        path.join(projectRoot, '.owner', 'config.yaml'),
        `schema: owner.project.v1\ndefault_workflow: loop\nloop:\n  artifact_root: docs\n  max_verify_failures: ${value}\n`,
      );

      await expect(readProjectConfig(projectRoot)).rejects.toThrow(
        'loop.max_verify_failures must be a positive integer',
      );
    },
  );

  it('renders Chinese comments for a Chinese project config', async () => {
    await writeProjectConfig(projectRoot, defaultProjectConfig('docs', 'zh-CN'));

    const source = await fs.readFile(path.join(projectRoot, '.owner', 'config.yaml'), 'utf8');
    expect(source).toContain('# 是否启用只读的环境感知恢复探针');
    expect(source).toContain('# Loop 规格和 change 的存放根目录；运行时数据始终位于 .owner');
    expect(source).toContain('# Loop 提问澄清问题的方式');
    expect(source).toContain('# Loop 归档检查成功后自动归档');
    expect(source).toContain('# 同一个已确认验收目标最多允许的 Verify 失败次数');
    expect(source).not.toMatch(/^\s+snapshot:/mu);
    expect(source).not.toContain('# Enables automatic recovery');
  });

  it('rejects unsafe snapshot patterns', async () => {
    await fs.writeFile(
      path.join(projectRoot, '.owner', 'config.yaml'),
      [
        'schema: owner.project.v1',
        'default_workflow: loop',
        'loop:',
        '  artifact_root: docs',
        '  snapshot:',
        '    include: ["../outside/**"]',
        '    exclude: []',
        '',
      ].join('\n'),
    );

    await expect(readProjectConfig(projectRoot)).rejects.toThrow(
      'loop.snapshot.include contains an unsafe pattern',
    );
  });

  it.each([
    ['max_files', 0],
    ['max_total_bytes', 0],
    ['max_duration_ms', 0],
  ])('rejects invalid snapshot budget %s', async (field, value) => {
    await fs.writeFile(
      path.join(projectRoot, '.owner', 'config.yaml'),
      [
        'schema: owner.project.v1',
        'default_workflow: loop',
        'loop:',
        '  artifact_root: docs',
        '  snapshot:',
        `    ${field}: ${value}`,
        '',
      ].join('\n'),
    );

    await expect(readProjectConfig(projectRoot)).rejects.toThrow(`loop.snapshot.${field}`);
  });

  it.each([
    ['a'.repeat(1025), 'exceeds 1024 characters'],
    ['*a'.repeat(65), 'contains more than 64 wildcard tokens'],
  ])('rejects overly complex snapshot pattern', async (pattern, expected) => {
    await fs.writeFile(
      path.join(projectRoot, '.owner', 'config.yaml'),
      [
        'schema: owner.project.v1',
        'default_workflow: loop',
        'loop:',
        '  artifact_root: docs',
        '  snapshot:',
        `    include: ["${pattern}"]`,
        '',
      ].join('\n'),
    );

    await expect(readProjectConfig(projectRoot)).rejects.toThrow(expected);
  });

  it('rejects a non-boolean Ambient Resume setting', async () => {
    await fs.writeFile(
      path.join(projectRoot, '.owner', 'config.yaml'),
      'schema: owner.project.v1\ndefault_workflow: loop\nambient_resume: sometimes\nloop:\n  artifact_root: .\n',
    );

    await expect(readProjectConfig(projectRoot)).rejects.toThrow(
      'ambient_resume must be true or false',
    );
  });

  it('fails closed for an invalid clarification mode', async () => {
    await fs.writeFile(
      path.join(projectRoot, '.owner', 'config.yaml'),
      'schema: owner.project.v1\ndefault_workflow: loop\nloop:\n  artifact_root: docs\n  clarification_mode: sometimes\n',
    );

    await expect(readProjectConfig(projectRoot)).rejects.toThrow(
      'loop.clarification_mode must be sequential or batch',
    );
  });

  it('fails closed for an invalid archive confirmation mode', async () => {
    await fs.writeFile(
      path.join(projectRoot, '.owner', 'config.yaml'),
      'schema: owner.project.v1\ndefault_workflow: loop\nloop:\n  artifact_root: docs\n  archive_confirmation: sometimes\n',
    );

    await expect(readProjectConfig(projectRoot)).rejects.toThrow(
      'loop.archive_confirmation must be automatic or required',
    );
  });

  it('round-trips a transaction-bound root-move cleanup marker', async () => {
    const config = defaultProjectConfig('docs');
    config.loop.pending_root_move = {
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      fromArtifactRoot: '.',
      toArtifactRoot: 'docs',
      stage: 'switched',
      cleanup: {
        kind: 'forward-source',
        state: 'deleting',
        manifestHash: 'a'.repeat(64),
      },
    };
    config.workflows = ['loop'];

    await writeProjectConfig(projectRoot, config);

    expect(await readProjectConfig(projectRoot)).toEqual(config);
    expect(await fs.readFile(path.join(projectRoot, '.owner', 'config.yaml'), 'utf8')).toContain(
      'manifest_hash: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
  });

  it('discovers the nearest configured project from a nested directory', async () => {
    await writeProjectConfig(projectRoot, defaultProjectConfig('docs'));
    const nested = path.join(projectRoot, 'src', 'feature');
    await fs.mkdir(nested, { recursive: true });

    const resolved = await resolveLoopProject({ startPath: nested });

    expect(resolved.paths.projectRoot).toBe(projectRoot);
    expect(resolved.paths.loopRoot).toBe(path.join(projectRoot, 'docs', 'owner'));
    expect(resolved.configured).toBe(true);
  });

  it('uses docs as the default artifact root without config', async () => {
    const nested = path.join(projectRoot, 'src');
    await fs.mkdir(nested);

    const resolved = await resolveLoopProject({ startPath: nested });

    expect(resolved.config.loop.artifact_root).toBe('docs');
    expect(resolved.paths.loopRoot).toBe(path.join(projectRoot, 'docs', 'owner'));
    expect(resolved.configured).toBe(false);
  });

  it('can require an existing Loop project config', async () => {
    await expect(
      resolveLoopProject({ startPath: projectRoot, allowMissingConfig: false }),
    ).rejects.toThrow('.owner/config.yaml was not found');
  });

  it('refuses an explicit root that conflicts with persisted config', async () => {
    await writeProjectConfig(projectRoot, defaultProjectConfig('docs'));

    await expect(
      resolveLoopProject({ startPath: projectRoot, explicitArtifactRoot: 'artifacts' }),
    ).rejects.toThrow('refusing conflicting root');
  });

  it.each([
    [
      'duplicate keys',
      'schema: owner.project.v1\nschema: owner.project.v1\ndefault_workflow: loop\nloop:\n  artifact_root: .\n',
    ],
    ['missing Loop root', 'schema: owner.project.v1\ndefault_workflow: loop\nloop: {}\n'],
    [
      'bad pending move',
      'schema: owner.project.v1\ndefault_workflow: loop\nloop:\n  artifact_root: .\n  pending_root_move:\n    id: bad\n    from_artifact_root: .\n    to_artifact_root: docs\n    stage: unknown\n',
    ],
  ])('fails closed for %s', async (_label, source) => {
    await fs.writeFile(path.join(projectRoot, '.owner', 'config.yaml'), source);
    await expect(readProjectConfig(projectRoot)).rejects.toBeInstanceOf(Error);
  });

  it('does not migrate legacy Pipeline fields during Loop config writes', async () => {
    await fs.writeFile(
      path.join(projectRoot, '.owner', 'config.yaml'),
      'language: zh-CN\nreview_mode: thorough\ncustom_setting: keep\n',
    );

    await writeProjectConfig(projectRoot, defaultProjectConfig('docs', 'zh-CN'));

    const source = await fs.readFile(path.join(projectRoot, '.owner', 'config.yaml'), 'utf8');
    expect(source).toContain('review_mode: thorough');
    expect(source).toContain('custom_setting: keep');
    expect(source).toContain('artifact_root: docs');
  });

  it('preserves the nested Pipeline block during Loop config writes', async () => {
    await fs.writeFile(
      path.join(projectRoot, '.owner', 'config.yaml'),
      [
        'schema: owner.project.v1',
        'default_workflow: loop',
        'loop:',
        '  artifact_root: .',
        '  language: en',
        'pipeline:',
        '  language: zh-CN',
        '  context_compression: beta',
        '  review_mode: thorough',
        '  auto_transition: false',
        '',
      ].join('\n'),
    );

    await writeProjectConfig(projectRoot, defaultProjectConfig('docs', 'zh-CN'));

    const source = await fs.readFile(path.join(projectRoot, '.owner', 'config.yaml'), 'utf8');
    expect(source).toContain('pipeline:');
    expect(source).toContain('context_compression: beta');
    expect(source).toContain('review_mode: thorough');
    expect(source).toContain('auto_transition: false');
  });

  it('preserves extensions outside the retired Loop snapshot subtree', async () => {
    await fs.writeFile(
      path.join(projectRoot, '.owner', 'config.yaml'),
      [
        'schema: owner.project.v1',
        'default_workflow: loop',
        'workflows: [loop, pipeline]',
        'loop:',
        '  artifact_root: .',
        '  custom_extension:',
        '    owner: user',
        '  snapshot:',
        '    include: ["**/*"]',
        '    snapshot_extension: keep',
        'pipeline:',
        '  artifact_layout: legacy',
        '  pipeline_extension: keep',
        'top_extension:',
        '  enabled: true',
        '',
      ].join('\n'),
      'utf8',
    );

    const config = await readProjectConfig(projectRoot);
    expect(config).not.toBeNull();
    config!.loop.artifact_root = 'docs';
    await writeProjectConfig(projectRoot, config!);

    const source = await fs.readFile(path.join(projectRoot, '.owner', 'config.yaml'), 'utf8');
    expect(source).toContain('artifact_root: docs');
    expect(source).toContain('custom_extension:');
    expect(source).not.toContain('snapshot_extension: keep');
    expect(source).not.toMatch(/^\s+snapshot:/mu);
    expect(source).toContain('pipeline_extension: keep');
    expect(source).toContain('top_extension:');
  });

  it('rejects an oversized project config before parsing it', async () => {
    await fs.writeFile(
      path.join(projectRoot, '.owner', 'config.yaml'),
      Buffer.alloc(64 * 1024 + 1),
    );

    await expect(readProjectConfig(projectRoot)).rejects.toThrow('exceeds 65536 bytes');
  });
});
