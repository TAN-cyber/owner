import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { parse } from 'yaml';
import { getProjectRegistryPath } from '../../platform/install/project-registry.js';
import { stageOpenSpecSkills, unquoteWindowsArg } from '../helpers/openspec-test-utils.js';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockedExecFileSync = vi.mocked(execFileSync);

vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(),
  checkbox: vi.fn(),
}));

vi.mock('../../app/commands/platform-select-prompt.js', () => ({
  platformSelectPrompt: vi.fn(),
}));

vi.mock('../../platform/version/version.js', () => ({
  printVersionInfo: vi.fn(async (log: (message: string) => void) => {
    log('  Owner vtest');
    return {
      currentVersion: 'test',
      latestVersion: null,
      hasUpdate: false,
      checked: false,
    };
  }),
}));

vi.mock('../../app/cli/owner-banner.js', () => ({
  printOwnerBanner: vi.fn(async () => undefined),
}));

const manifestPath = path.resolve('assets', 'manifest.json');
const INIT_E2E_TIMEOUT_MS = 60_000;

async function readManifest() {
  return JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
}

function isNativeInstallSkillPath(skillPath: string): boolean {
  return (
    skillPath === 'owner/SKILL.md' ||
    skillPath === 'owner/scripts/owner-entry-runtime.mjs' ||
    skillPath === 'owner/scripts/owner-hook-router.mjs' ||
    skillPath.startsWith('owner-native/')
  );
}

function skillPathsForWorkflow(
  manifest: { skills: string[] },
  workflow: 'native' | 'classic' | 'both',
): string[] {
  if (workflow === 'both') return manifest.skills;
  if (workflow === 'native') return manifest.skills.filter(isNativeInstallSkillPath);
  return manifest.skills.filter((skillPath) => !skillPath.startsWith('owner-native/'));
}

function mockExternalSuccess(options: { openSpecConfig?: 'healthy' | 'missing' | 'corrupt' } = {}) {
  const openSpecConfig = options.openSpecConfig ?? 'healthy';
  mockedExecFileSync.mockImplementation((command: unknown, args?: unknown, opts?: unknown) => {
    const cmd = String(command);
    const cmdArgs = Array.isArray(args) ? args.map((arg) => String(arg)) : [];

    if (
      (cmd === 'npx' || cmd === 'npx.cmd') &&
      cmdArgs[0] === 'skills' &&
      cmdArgs.includes('--agent') &&
      cmdArgs.includes('claude-code')
    ) {
      const cwd = (opts as { cwd?: string } | undefined)?.cwd ?? os.tmpdir();
      const stagedSkillsDir = path.join(cwd, '.claude', 'skills', 'owner');
      mkdirSync(stagedSkillsDir, { recursive: true });
      writeFileSync(path.join(stagedSkillsDir, 'SKILL.md'), '# Owner\n');
      return Buffer.from('installed');
    }

    if ((cmd === 'which' || cmd === 'where') && cmdArgs[0] === 'openspec') {
      return Buffer.from('/usr/bin/openspec');
    }
    if (cmd === 'openspec' && cmdArgs[0] === '--version') {
      return Buffer.from('1.5.0');
    }
    if (cmd === 'openspec' && cmdArgs[0] === 'init') {
      const targetPath = unquoteWindowsArg(cmdArgs[1]);
      if (targetPath) {
        const toolsIndex = cmdArgs.indexOf('--tools');
        const tools = toolsIndex >= 0 ? cmdArgs[toolsIndex + 1] : undefined;
        if (tools && tools !== 'none') {
          stageOpenSpecSkills(targetPath, tools);
        } else {
          const openSpecRoot = path.join(targetPath, 'openspec');
          mkdirSync(path.join(openSpecRoot, 'changes', 'archive'), { recursive: true });
          if (openSpecConfig === 'healthy') {
            writeFileSync(path.join(openSpecRoot, 'config.yaml'), 'schema: spec-driven\n');
          } else if (openSpecConfig === 'corrupt') {
            writeFileSync(path.join(openSpecRoot, 'config.yaml'), 'schema: [broken\n');
          }
        }
      }
      return Buffer.from('ok');
    }
    if ((cmd === 'npx' || cmd === 'npx.cmd') && cmdArgs[0] === 'skills') {
      return Buffer.from('installed');
    }
    return Buffer.from('');
  });
}

async function captureJsonOutput(fn: () => Promise<void>): Promise<Record<string, unknown>> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = vi.fn((...args: unknown[]) => lines.push(String(args[0])));
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return JSON.parse(lines.join('\n'));
}

async function captureTextOutput(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = vi.fn((...args: unknown[]) => lines.push(args.map(String).join(' ')));
  console.error = vi.fn((...args: unknown[]) => errors.push(args.map(String).join(' ')));
  try {
    await fn();
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  return [...lines, ...errors].join('\n');
}

describe('owner init E2E', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `owner-init-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(tmpDir, { recursive: true });
    vi.resetAllMocks();
    vi.resetModules();
    vi.spyOn(os, 'homedir').mockReturnValue(path.join(tmpDir, 'fake-home'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('offers Native, Classic, and Both with concise user-facing descriptions', async () => {
    const { workflowChoiceNames } = await import('../../app/commands/init.js');

    expect(workflowChoiceNames('zh')).toEqual([
      expect.objectContaining({ value: 'native', name: expect.stringContaining('强模型') }),
      expect.objectContaining({ value: 'classic', name: expect.stringContaining('Spec/TDD') }),
      expect.objectContaining({ value: 'both', name: expect.stringContaining('两套独立入口') }),
    ]);
  });

  it('enables the banner for text output and disables it for JSON output', async () => {
    mockExternalSuccess();
    await fs.mkdir(path.join(tmpDir, '.claude'), { recursive: true });
    const { printOwnerBanner } = await import('../../app/cli/owner-banner.js');
    const { initCommand } = await import('../../app/commands/init.js');

    await captureTextOutput(() => initCommand(tmpDir, { yes: true, language: 'en' }));
    expect(printOwnerBanner).toHaveBeenLastCalledWith({ enabled: true });

    await captureJsonOutput(() => initCommand(tmpDir, { yes: true, json: true }));
    expect(printOwnerBanner).toHaveBeenLastCalledWith({ enabled: false });
  });

  it('waits for the banner before printing version info', async () => {
    mockExternalSuccess();
    await fs.mkdir(path.join(tmpDir, '.claude'), { recursive: true });
    let resolveBanner!: () => void;
    const bannerDone = new Promise<void>((resolve) => {
      resolveBanner = resolve;
    });
    const { printOwnerBanner } = await import('../../app/cli/owner-banner.js');
    const { printVersionInfo } = await import('../../platform/version/version.js');
    vi.mocked(printOwnerBanner).mockImplementationOnce(() => bannerDone);
    const { initCommand } = await import('../../app/commands/init.js');

    const initPromise = captureTextOutput(() => initCommand(tmpDir, { yes: true, language: 'en' }));
    await vi.waitFor(() => expect(printOwnerBanner).toHaveBeenCalledWith({ enabled: true }));
    expect(printVersionInfo).not.toHaveBeenCalled();

    resolveBanner();
    await initPromise;

    expect(vi.mocked(printOwnerBanner).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(printVersionInfo).mock.invocationCallOrder[0],
    );
  });

  it(
    'initializes a genuinely new project as self-contained Native with --yes --json',
    async () => {
      mockExternalSuccess();
      await fs.mkdir(path.join(tmpDir, '.claude'), { recursive: true });

      const { initCommand } = await import('../../app/commands/init.js');
      const result = await captureJsonOutput(() => initCommand(tmpDir, { yes: true, json: true }));

      expect(result.projectPath).toBe(tmpDir);
      expect(result.scope).toBe('project');
      expect(result.language).toBe('en');
      expect(result.selectedPlatforms).toContain('claude');
      expect(result.workingDirsCreated).toBe(true);
      expect(result).toMatchObject({
        workflow: 'native',
        workflowSource: 'new-project-default',
        projectConfigCreated: true,
        nativeArtifactRoot: 'docs',
      });

      const claudeResult = (
        result.results as {
          platform: string;
          owner: string;
          openspec: string;
          superpowers: string;
        }[]
      ).find((r) => r.platform === 'claude');
      expect(claudeResult?.owner).toBe('installed');
      expect(claudeResult?.openspec).toBe('skipped');
      expect(claudeResult?.superpowers).toBe('skipped');

      const manifest = await readManifest();
      const managedSkillPaths = [
        ...manifest.skills,
        ...(manifest.internalSkills ?? []),
      ] as string[];
      for (const skillPath of managedSkillPaths.filter(isNativeInstallSkillPath)) {
        const dest = path.join(tmpDir, '.claude', 'skills', skillPath);
        await expect(fs.access(dest)).resolves.toBeUndefined();
      }
      for (const skillPath of managedSkillPaths.filter(
        (skillPath) => !isNativeInstallSkillPath(skillPath),
      )) {
        const dest = path.join(tmpDir, '.claude', 'skills', skillPath);
        await expect(fs.access(dest)).rejects.toMatchObject({ code: 'ENOENT' });
      }

      await expect(fs.stat(path.join(tmpDir, 'docs', 'owner', 'specs'))).resolves.toBeDefined();
      await expect(fs.stat(path.join(tmpDir, 'docs', 'owner', 'changes'))).resolves.toBeDefined();
      await expect(fs.stat(path.join(tmpDir, 'docs', 'owner', 'archive'))).resolves.toBeDefined();
      await expect(fs.access(path.join(tmpDir, 'owner'))).rejects.toThrow();
      await expect(fs.stat(path.join(tmpDir, 'docs', 'superpowers'))).rejects.toThrow();
      await expect(fs.stat(path.join(tmpDir, '.owner', 'config.yaml'))).resolves.toBeDefined();
      await expect(
        fs.stat(path.join(tmpDir, '.claude', 'rules', 'owner-workflow-guard.md')),
      ).resolves.toBeDefined();
      await expect(
        fs.stat(path.join(tmpDir, '.claude', 'settings.local.json')),
      ).resolves.toBeDefined();

      const projectConfig = await fs.readFile(path.join(tmpDir, '.owner', 'config.yaml'), 'utf8');
      expect(projectConfig).toContain('default_workflow: native');
      expect(projectConfig).toContain('artifact_root: docs');
      expect(projectConfig).toContain('clarification_mode: batch');
      expect(projectConfig).not.toMatch(/^\s+snapshot:/mu);
      await expect(fs.readFile(path.join(tmpDir, '.gitignore'), 'utf8')).resolves.toContain(
        '!/.owner/config.yaml',
      );
      expect(mockedExecFileSync.mock.calls.some((call) => String(call[0]) === 'openspec')).toBe(
        false,
      );
      expect(
        mockedExecFileSync.mock.calls.some(
          (call) =>
            (String(call[0]) === 'npx' || String(call[0]) === 'npx.cmd') &&
            Array.isArray(call[1]) &&
            call[1].includes('skills'),
        ),
      ).toBe(false);
    },
    INIT_E2E_TIMEOUT_MS,
  );

  it('preserves a legacy Classic project and its dependency-aware setup by default', async () => {
    mockExternalSuccess();
    await fs.mkdir(path.join(tmpDir, '.claude'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, '.owner'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.owner', 'config.yaml'), 'language: en\n', 'utf8');
    await fs.mkdir(path.join(tmpDir, 'openspec'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'openspec', 'config.yaml'),
      'schema: spec-driven\n',
      'utf8',
    );

    const { initCommand } = await import('../../app/commands/init.js');
    const result = await captureJsonOutput(() => initCommand(tmpDir, { yes: true, json: true }));

    expect(result).toMatchObject({
      workflow: 'classic',
      workflowSource: 'legacy-project',
      projectConfigCreated: false,
    });
    await expect(fs.access(path.join(tmpDir, 'owner.config.yaml'))).rejects.toThrow();
    await expect(fs.stat(path.join(tmpDir, 'docs', 'superpowers', 'specs'))).resolves.toBeDefined();
    await expect(
      fs.access(path.join(tmpDir, '.claude', 'rules', 'owner-workflow-guard.md')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(tmpDir, '.claude', 'settings.local.json')),
    ).resolves.toBeUndefined();
    expect(mockedExecFileSync.mock.calls.some((call) => String(call[0]) === 'openspec')).toBe(true);
  });

  it('upgrades an incompatible OpenSpec CLI before non-interactive Classic setup', async () => {
    mockExternalSuccess();
    await fs.mkdir(path.join(tmpDir, '.claude'), { recursive: true });
    const externalSuccess = mockedExecFileSync.getMockImplementation();
    let openSpecVersion = '1.3.1';
    mockedExecFileSync.mockImplementation((command, args, options) => {
      const cmd = String(command);
      const cmdArgs = Array.isArray(args) ? args.map(String) : [];
      if (cmd === 'openspec' && cmdArgs[0] === '--version') {
        return Buffer.from(openSpecVersion);
      }
      if (
        (cmd === 'npm' || cmd === 'npm.cmd') &&
        cmdArgs.join(' ') === 'install -g @fission-ai/openspec@latest'
      ) {
        openSpecVersion = '1.5.0';
        return Buffer.from('upgraded');
      }
      return externalSuccess?.(command, args, options) ?? Buffer.from('');
    });

    const { initCommand } = await import('../../app/commands/init.js');
    const result = await captureJsonOutput(() =>
      initCommand(tmpDir, { yes: true, json: true, workflow: 'classic', language: 'en' }),
    );

    expect(result).toMatchObject({ status: 'complete' });
    expect(
      mockedExecFileSync.mock.calls.some(
        ([command, args]) =>
          (String(command) === 'npm' || String(command) === 'npm.cmd') &&
          Array.isArray(args) &&
          args.map(String).join(' ') === 'install -g @fission-ai/openspec@latest',
      ),
    ).toBe(true);
  });

  it('supports an explicit Native artifact root through the main init command', async () => {
    mockExternalSuccess();
    await fs.mkdir(path.join(tmpDir, '.claude'), { recursive: true });

    const { initCommand } = await import('../../app/commands/init.js');
    const result = await captureJsonOutput(() =>
      initCommand(tmpDir, {
        yes: true,
        json: true,
        workflow: 'native',
        artifactRoot: 'docs',
        installMode: 'symlink',
      }),
    );

    expect(result).toMatchObject({
      workflow: 'native',
      workflowSource: 'explicit-option',
      projectConfigCreated: true,
      nativeArtifactRoot: 'docs',
    });
    await expect(fs.stat(path.join(tmpDir, 'docs', 'owner', 'changes'))).resolves.toBeDefined();
    await expect(fs.stat(path.join(tmpDir, 'owner'))).rejects.toThrow();
    await expect(fs.stat(path.join(tmpDir, '.owner'))).resolves.toBeDefined();
  });

  it('initializes Native and Classic independently while defaulting /owner to Native', async () => {
    mockExternalSuccess();
    await fs.mkdir(path.join(tmpDir, '.claude'), { recursive: true });

    const { initCommand } = await import('../../app/commands/init.js');
    const result = await captureJsonOutput(() =>
      initCommand(tmpDir, {
        yes: true,
        json: true,
        workflow: 'both',
        language: 'en',
      }),
    );

    expect(result).toMatchObject({
      workflow: 'native',
      initializedWorkflows: ['native', 'classic'],
      nativeArtifactRoot: 'docs',
    });
    const config = await fs.readFile(path.join(tmpDir, '.owner', 'config.yaml'), 'utf8');
    expect(config).toContain('default_workflow: native');
    expect(config).toContain('- native');
    expect(config).toContain('- classic');
    expect(config).toContain('clarification_mode: batch');
    await expect(fs.stat(path.join(tmpDir, 'docs', 'owner', 'changes'))).resolves.toBeDefined();
    await expect(fs.stat(path.join(tmpDir, 'docs', 'superpowers', 'specs'))).resolves.toBeDefined();
    await expect(
      fs.stat(path.join(tmpDir, '.claude', 'rules', 'owner-workflow-guard.md')),
    ).resolves.toBeDefined();
    for (const skill of ['owner-native', 'owner-classic', 'owner-open']) {
      await expect(
        fs.access(path.join(tmpDir, '.claude', 'skills', skill, 'SKILL.md')),
      ).resolves.toBeUndefined();
    }
    await expect(
      fs.access(path.join(tmpDir, '.owner', 'current-change.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('adds Classic with the docs layout when a Native-only project is reinitialized as Both', async () => {
    mockExternalSuccess();
    await fs.mkdir(path.join(tmpDir, '.claude'), { recursive: true });
    const { initCommand } = await import('../../app/commands/init.js');

    await captureJsonOutput(() =>
      initCommand(tmpDir, { yes: true, json: true, workflow: 'native', language: 'en' }),
    );
    mockedExecFileSync.mockClear();
    mockExternalSuccess();

    const result = await captureJsonOutput(() =>
      initCommand(tmpDir, { yes: true, json: true, workflow: 'both', language: 'en' }),
    );
    const config = parse(await fs.readFile(path.join(tmpDir, '.owner', 'config.yaml'), 'utf8')) as {
      workflows?: string[];
      classic?: { artifact_layout?: string };
    };

    expect(result).toMatchObject({
      status: 'complete',
      projectConfigCreated: false,
      projectConfigUpdated: true,
    });
    expect(config.workflows).toEqual(['native', 'classic']);
    expect(config.classic?.artifact_layout).toBe('docs');
    await expect(fs.stat(path.join(tmpDir, 'docs', 'openspec'))).resolves.toBeDefined();
    await expect(fs.access(path.join(tmpDir, 'openspec'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('adopts a legacy Classic root when the project configuration is missing', async () => {
    mockExternalSuccess();
    await fs.mkdir(path.join(tmpDir, '.claude'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'openspec', 'changes', 'archive'), { recursive: true });
    const { initCommand } = await import('../../app/commands/init.js');

    const result = await captureJsonOutput(() =>
      initCommand(tmpDir, {
        yes: true,
        json: true,
        workflow: 'classic',
        language: 'en',
        overwrite: true,
      }),
    );

    expect(result).toMatchObject({
      status: 'complete',
      classicArtifactLayout: 'legacy',
      projectConfigCreated: true,
    });
    const config = parse(await fs.readFile(path.join(tmpDir, '.owner', 'config.yaml'), 'utf8')) as {
      classic?: { artifact_layout?: string };
    };
    expect(config.classic?.artifact_layout).toBe('legacy');
    await expect(fs.stat(path.join(tmpDir, 'openspec', 'config.yaml'))).resolves.toBeDefined();
    await expect(fs.access(path.join(tmpDir, 'docs', 'openspec'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('repairs missing Native defaults and removes legacy snapshot config while initializing Both', async () => {
    mockExternalSuccess();
    await fs.mkdir(path.join(tmpDir, '.claude'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'openspec', 'changes', 'archive'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, '.owner'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, '.owner', 'config.yaml'),
      [
        'schema: owner.project.v1',
        'default_workflow: native',
        'workflows: [native]',
        'native:',
        '  language: en',
        '  snapshot:',
        '    include: ["**/*"]',
        '    exclude:',
        '      - custom/init-generated/**',
        '',
      ].join('\n'),
      'utf8',
    );
    const { initCommand } = await import('../../app/commands/init.js');

    const result = await captureJsonOutput(() =>
      initCommand(tmpDir, {
        yes: true,
        json: true,
        workflow: 'both',
        language: 'en',
        overwrite: true,
      }),
    );

    expect(result).toMatchObject({
      status: 'complete',
      classicArtifactLayout: 'legacy',
      projectConfigCreated: false,
      projectConfigUpdated: true,
    });
    const config = parse(await fs.readFile(path.join(tmpDir, '.owner', 'config.yaml'), 'utf8')) as {
      native?: { artifact_root?: string; snapshot?: unknown };
      classic?: { artifact_layout?: string };
    };
    expect(config.native?.artifact_root).toBe('docs');
    expect(config.native?.snapshot).toBeUndefined();
    expect(config.classic?.artifact_layout).toBe('legacy');
    await expect(fs.stat(path.join(tmpDir, 'openspec', 'config.yaml'))).resolves.toBeDefined();
    await expect(fs.access(path.join(tmpDir, 'docs', 'openspec'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('preserves both configured workflows when non-interactive init is repeated without --workflow', async () => {
    mockExternalSuccess();
    await fs.mkdir(path.join(tmpDir, '.claude'), { recursive: true });
    const { initCommand } = await import('../../app/commands/init.js');

    await captureJsonOutput(() =>
      initCommand(tmpDir, { yes: true, json: true, workflow: 'both', language: 'en' }),
    );
    mockedExecFileSync.mockClear();
    mockExternalSuccess();

    const result = await captureJsonOutput(() =>
      initCommand(tmpDir, { yes: true, json: true, language: 'en', overwrite: true }),
    );
    const config = parse(await fs.readFile(path.join(tmpDir, '.owner', 'config.yaml'), 'utf8')) as {
      default_workflow?: string;
      workflows?: string[];
      native?: unknown;
      classic?: unknown;
    };

    expect(result).toMatchObject({
      status: 'complete',
      initializedWorkflows: ['native', 'classic'],
    });
    expect(config).toMatchObject({
      default_workflow: 'native',
      workflows: ['native', 'classic'],
      native: expect.any(Object),
      classic: expect.any(Object),
    });
  });

  it('uninstalls Owner-owned directories after real Classic init while preserving the OpenSpec root', async () => {
    mockExternalSuccess();
    await fs.mkdir(path.join(tmpDir, '.claude'), { recursive: true });
    const { initCommand } = await import('../../app/commands/init.js');
    const { removeWorkingDirs } = await import('../../domains/skill/uninstall.js');
    await captureJsonOutput(() =>
      initCommand(tmpDir, { yes: true, json: true, workflow: 'classic', language: 'en' }),
    );
    const openSpecConfig = path.join(tmpDir, 'docs', 'openspec', 'config.yaml');
    await expect(fs.readFile(openSpecConfig, 'utf8')).resolves.toContain('schema: spec-driven');

    await expect(removeWorkingDirs(tmpDir)).resolves.toEqual({ removed: 1, failed: 0 });

    await expect(fs.readFile(openSpecConfig, 'utf8')).resolves.toContain('schema: spec-driven');
    await expect(fs.stat(path.join(tmpDir, '.owner'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.stat(path.join(tmpDir, 'docs', 'superpowers'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('keeps a Classic-only config lossless when reinitializing it as Both', async () => {
    mockExternalSuccess();
    await fs.mkdir(path.join(tmpDir, '.claude'), { recursive: true });
    const { initCommand } = await import('../../app/commands/init.js');

    await captureJsonOutput(() =>
      initCommand(tmpDir, { yes: true, json: true, workflow: 'classic', language: 'en' }),
    );
    const configPath = path.join(tmpDir, '.owner', 'config.yaml');
    const classicOnly = await fs.readFile(configPath, 'utf8');
    expect(parse(classicOnly)).toMatchObject({
      default_workflow: 'classic',
      workflows: ['classic'],
      classic: { artifact_layout: 'docs' },
    });
    expect(parse(classicOnly)).not.toHaveProperty('native');
    await fs.writeFile(
      configPath,
      classicOnly
        .replace('classic:\n', 'classic:\n  custom_classic: keep-classic\n')
        .concat('custom_top: keep-top\n'),
      'utf8',
    );

    mockedExecFileSync.mockClear();
    mockExternalSuccess();
    const result = await captureJsonOutput(() =>
      initCommand(tmpDir, {
        yes: true,
        json: true,
        workflow: 'both',
        language: 'en',
        overwrite: true,
      }),
    );
    const updated = parse(await fs.readFile(configPath, 'utf8'));

    expect(result).toMatchObject({
      status: 'complete',
      projectConfigCreated: false,
      projectConfigUpdated: true,
    });
    expect(updated).toMatchObject({
      default_workflow: 'native',
      workflows: ['native', 'classic'],
      native: { artifact_root: 'docs' },
      classic: {
        artifact_layout: 'docs',
        custom_classic: 'keep-classic',
      },
      custom_top: 'keep-top',
    });
  });

  it('keeps the prior Classic-only config when the final Both config write fails', async () => {
    mockExternalSuccess();
    await fs.mkdir(path.join(tmpDir, '.claude'), { recursive: true });
    const { initCommand } = await import('../../app/commands/init.js');

    await captureJsonOutput(() =>
      initCommand(tmpDir, { yes: true, json: true, workflow: 'classic', language: 'en' }),
    );
    const configPath = path.join(tmpDir, '.owner', 'config.yaml');
    const classicOnly = await fs.readFile(configPath, 'utf8');
    expect(parse(classicOnly)).toMatchObject({
      default_workflow: 'classic',
      workflows: ['classic'],
    });

    const configWriter = await import('../../domains/workflow-contract/project-config-writer.js');
    vi.spyOn(configWriter, 'writeWorkflowProjectConfig').mockRejectedValueOnce(
      new Error('config commit failed'),
    );
    mockedExecFileSync.mockClear();
    mockExternalSuccess();

    const result = await captureJsonOutput(() =>
      initCommand(tmpDir, {
        yes: true,
        json: true,
        workflow: 'both',
        language: 'en',
        overwrite: true,
      }),
    );

    expect(result).toMatchObject({
      status: 'incomplete',
      projectConfigCreated: false,
      projectConfigUpdated: false,
      failures: [
        expect.objectContaining({
          component: 'Finalization',
          reason: 'config commit failed',
        }),
      ],
    });
    expect(await fs.readFile(configPath, 'utf8')).toBe(classicOnly);
  });

  it('preserves the owned Classic root and journal when a fresh config commit fails', async () => {
    mockExternalSuccess();
    await fs.mkdir(path.join(tmpDir, '.claude'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'docs'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'docs', 'keep.txt'), 'keep\n');
    const configWriter = await import('../../domains/workflow-contract/project-config-writer.js');
    vi.spyOn(configWriter, 'writeWorkflowProjectConfig').mockRejectedValueOnce(
      new Error('config commit failed'),
    );
    const { initCommand } = await import('../../app/commands/init.js');

    const result = await captureJsonOutput(() =>
      initCommand(tmpDir, {
        yes: true,
        json: true,
        workflow: 'classic',
        language: 'en',
      }),
    );

    expect(result).toMatchObject({
      status: 'incomplete',
      projectConfigCreated: false,
      projectConfigUpdated: false,
    });
    await expect(fs.readFile(path.join(tmpDir, 'docs', 'keep.txt'), 'utf8')).resolves.toBe(
      'keep\n',
    );
    await expect(fs.stat(path.join(tmpDir, 'docs', 'openspec'))).resolves.toBeDefined();
    await expect(
      fs.stat(path.join(tmpDir, '.owner', 'classic-init-ownership.json')),
    ).resolves.toBeDefined();
  });

  it('does not overwrite config drift introduced after Classic directories are created', async () => {
    mockExternalSuccess();
    await fs.mkdir(path.join(tmpDir, '.claude'), { recursive: true });
    const { initCommand } = await import('../../app/commands/init.js');

    await captureJsonOutput(() =>
      initCommand(tmpDir, { yes: true, json: true, workflow: 'native', language: 'en' }),
    );
    const configPath = path.join(tmpDir, '.owner', 'config.yaml');
    const projectInstructions = await import('../../domains/skill/project-instructions.js');
    const syncInstructions = projectInstructions.syncOwnerProjectInstructions;
    let drifted = false;
    vi.spyOn(projectInstructions, 'syncOwnerProjectInstructions').mockImplementation(
      async (...args) => {
        await syncInstructions(...args);
        if (!drifted) {
          const source = await fs.readFile(configPath, 'utf8');
          await fs.writeFile(
            configPath,
            source.replace('artifact_root: docs', 'artifact_root: artifacts'),
            'utf8',
          );
          drifted = true;
        }
      },
    );
    mockedExecFileSync.mockClear();
    mockExternalSuccess();

    const result = await captureJsonOutput(() =>
      initCommand(tmpDir, {
        yes: true,
        json: true,
        workflow: 'both',
        language: 'en',
        overwrite: true,
      }),
    );
    const driftedConfig = parse(await fs.readFile(configPath, 'utf8'));

    expect(result).toMatchObject({
      status: 'incomplete',
      projectConfigCreated: false,
      projectConfigUpdated: false,
      failures: [
        expect.objectContaining({
          component: 'Finalization',
          reason: expect.stringMatching(
            /project config changed during Classic layout initialization/iu,
          ),
        }),
      ],
    });
    expect(driftedConfig).toMatchObject({
      default_workflow: 'native',
      workflows: ['native'],
      native: { artifact_root: 'artifacts' },
    });
    expect(driftedConfig).not.toHaveProperty('classic');
  });

  it('does not use a stale workflow decision when config changes before Classic preflight', async () => {
    mockExternalSuccess();
    await fs.mkdir(path.join(tmpDir, '.claude'), { recursive: true });
    const { initCommand } = await import('../../app/commands/init.js');

    await captureJsonOutput(() =>
      initCommand(tmpDir, { yes: true, json: true, workflow: 'native', language: 'en' }),
    );
    const configPath = path.join(tmpDir, '.owner', 'config.yaml');
    const platformInstall = await import('../../domains/skill/platform-install.js');
    const prepareNativeTarget = platformInstall.prepareNativeSkillInstallTarget;
    let drifted = false;
    vi.spyOn(platformInstall, 'prepareNativeSkillInstallTarget').mockImplementation(
      async (...args) => {
        await prepareNativeTarget(...args);
        if (!drifted) {
          const source = await fs.readFile(configPath, 'utf8');
          await fs.writeFile(
            configPath,
            source.replace('artifact_root: docs', 'artifact_root: artifacts'),
            'utf8',
          );
          drifted = true;
        }
      },
    );
    mockedExecFileSync.mockClear();
    mockExternalSuccess();

    const result = await captureJsonOutput(() =>
      initCommand(tmpDir, {
        yes: true,
        json: true,
        workflow: 'both',
        language: 'en',
        overwrite: true,
      }),
    );
    const driftedConfig = parse(await fs.readFile(configPath, 'utf8'));

    expect(result).toMatchObject({
      status: 'incomplete',
      projectConfigCreated: false,
      projectConfigUpdated: false,
    });
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: expect.stringMatching(
            /project config changed (?:after the workflow decision|before commit)/iu,
          ),
        }),
      ]),
    );
    expect(driftedConfig).toMatchObject({
      default_workflow: 'native',
      workflows: ['native'],
      native: { artifact_root: 'artifacts' },
    });
    expect(driftedConfig).not.toHaveProperty('classic');
    expect(
      mockedExecFileSync.mock.calls.filter(
        ([command, args]) =>
          String(command) === 'openspec' && Array.isArray(args) && args.map(String)[0] === 'init',
      ),
    ).toHaveLength(0);
    await expect(fs.access(path.join(tmpDir, 'docs', 'openspec'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('does not update an existing config when artifact-root OpenSpec init fails', async () => {
    mockExternalSuccess();
    await fs.mkdir(path.join(tmpDir, '.claude'), { recursive: true });
    const { initCommand } = await import('../../app/commands/init.js');

    await captureJsonOutput(() =>
      initCommand(tmpDir, { yes: true, json: true, workflow: 'native', language: 'en' }),
    );
    const configPath = path.join(tmpDir, '.owner', 'config.yaml');
    const configBefore = await fs.readFile(configPath);
    const externalSuccess = mockedExecFileSync.getMockImplementation();
    mockedExecFileSync.mockImplementation((command, args, options) => {
      const commandArgs = Array.isArray(args) ? args.map(String) : [];
      const toolsIndex = commandArgs.indexOf('--tools');
      if (
        String(command) === 'openspec' &&
        commandArgs[0] === 'init' &&
        toolsIndex >= 0 &&
        commandArgs[toolsIndex + 1] === 'none'
      ) {
        throw new Error('artifact root init failed');
      }
      return externalSuccess?.(command, args, options);
    });

    const result = await captureJsonOutput(() =>
      initCommand(tmpDir, {
        yes: true,
        json: true,
        workflow: 'both',
        language: 'en',
        overwrite: true,
      }),
    );

    expect(result).toMatchObject({
      status: 'incomplete',
      projectConfigCreated: false,
      projectConfigUpdated: false,
      failures: [
        expect.objectContaining({
          component: 'OpenSpec',
          reason: expect.stringContaining('artifact root init failed'),
        }),
      ],
    });
    await expect(fs.readFile(configPath)).resolves.toEqual(configBefore);
  });

  it('reuses the Classic permit and reports a partial failure when config drifts during OpenSpec init', async () => {
    mockExternalSuccess();
    await fs.mkdir(path.join(tmpDir, '.claude'), { recursive: true });
    const { initCommand } = await import('../../app/commands/init.js');

    await captureJsonOutput(() =>
      initCommand(tmpDir, { yes: true, json: true, workflow: 'native', language: 'en' }),
    );
    const configPath = path.join(tmpDir, '.owner', 'config.yaml');
    const externalSuccess = mockedExecFileSync.getMockImplementation();
    let drifted = false;
    mockedExecFileSync.mockImplementation((command, args, options) => {
      const commandArgs = Array.isArray(args) ? args.map(String) : [];
      if (String(command) === 'openspec' && commandArgs[0] === 'init' && !drifted) {
        const source = readFileSync(configPath, 'utf8');
        writeFileSync(
          configPath,
          source.replace('artifact_root: docs', 'artifact_root: artifacts'),
          'utf8',
        );
        drifted = true;
      }
      return externalSuccess?.(command, args, options);
    });

    const result = await captureJsonOutput(() =>
      initCommand(tmpDir, {
        yes: true,
        json: true,
        workflow: 'both',
        language: 'en',
        overwrite: true,
      }),
    );
    const driftedConfig = parse(await fs.readFile(configPath, 'utf8'));

    expect(result).toMatchObject({
      status: 'incomplete',
      projectConfigCreated: false,
      projectConfigUpdated: false,
    });
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          component: 'OpenSpec',
          reason: expect.stringMatching(/partial failure.*project config changed/iu),
        }),
      ]),
    );
    expect(driftedConfig).toMatchObject({
      default_workflow: 'native',
      workflows: ['native'],
      native: { artifact_root: 'artifacts' },
    });
    await expect(fs.access(path.join(tmpDir, 'docs', 'openspec'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.each(['missing', 'corrupt'] as const)(
    'does not commit the project config when OpenSpec exits successfully with a %s config',
    async (openSpecConfig) => {
      mockExternalSuccess({ openSpecConfig });
      await fs.mkdir(path.join(tmpDir, '.claude'), { recursive: true });
      const { initCommand } = await import('../../app/commands/init.js');

      const result = await captureJsonOutput(() =>
        initCommand(tmpDir, {
          yes: true,
          json: true,
          workflow: 'classic',
          language: 'en',
        }),
      );

      expect(result).toMatchObject({
        status: 'incomplete',
        projectConfigCreated: false,
        projectConfigUpdated: false,
      });
      expect(result.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            component: 'OpenSpec',
            reason: expect.stringMatching(/OpenSpec root is unhealthy/iu),
          }),
        ]),
      );
      await expect(fs.access(path.join(tmpDir, '.owner', 'config.yaml'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );

  it('initializes Classic with a config-bound permit when every OpenSpec asset is skipped', async () => {
    mockExternalSuccess();
    await fs.mkdir(path.join(tmpDir, '.claude'), { recursive: true });
    const { initCommand } = await import('../../app/commands/init.js');

    await captureJsonOutput(() =>
      initCommand(tmpDir, { yes: true, json: true, workflow: 'native', language: 'en' }),
    );
    await fs.mkdir(path.join(tmpDir, '.claude', 'skills', 'openspec-propose'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(tmpDir, '.claude', 'skills', 'openspec-propose', 'SKILL.md'),
      '# OpenSpec\n',
      'utf8',
    );
    mockedExecFileSync.mockClear();
    mockExternalSuccess();

    const result = await captureJsonOutput(() =>
      initCommand(tmpDir, {
        yes: true,
        json: true,
        workflow: 'both',
        language: 'en',
        skipExisting: true,
      }),
    );
    const config = parse(await fs.readFile(path.join(tmpDir, '.owner', 'config.yaml'), 'utf8'));

    expect(result).toMatchObject({
      status: 'complete',
      projectConfigUpdated: true,
      classicArtifactLayout: 'docs',
    });
    expect(config).toMatchObject({
      workflows: ['native', 'classic'],
      classic: { artifact_layout: 'docs' },
    });
    expect(
      mockedExecFileSync.mock.calls.some(
        ([command, args]) =>
          String(command) === 'openspec' && Array.isArray(args) && args.map(String)[0] === 'init',
      ),
    ).toBe(true);
    expect(
      mockedExecFileSync.mock.calls.filter(
        ([command, args]) =>
          String(command) === 'openspec' && Array.isArray(args) && args.map(String)[0] === 'init',
      ),
    ).toHaveLength(1);
    expect(
      mockedExecFileSync.mock.calls.find(
        ([command, args]) =>
          String(command) === 'openspec' && Array.isArray(args) && args.map(String)[0] === 'init',
      )?.[1],
    ).toEqual(expect.arrayContaining(['--tools', 'none']));
    await expect(
      fs.readFile(path.join(tmpDir, 'docs', 'openspec', 'config.yaml'), 'utf8'),
    ).resolves.toContain('schema: spec-driven');
  });

  it.each([
    {
      label: 'Native',
      workflow: 'native' as const,
      artifactRoot: undefined,
      included: ['docs/owner/'],
      excluded: ['docs/superpowers/'],
    },
    {
      label: 'Native with a custom root',
      workflow: 'native' as const,
      artifactRoot: 'artifacts',
      included: ['artifacts/owner/'],
      excluded: ['docs/owner/', 'docs/superpowers/'],
    },
    {
      label: 'Classic',
      workflow: 'classic' as const,
      artifactRoot: undefined,
      included: ['docs/superpowers/specs/', 'docs/superpowers/plans/'],
      excluded: ['docs/owner/'],
    },
    {
      label: 'Both',
      workflow: 'both' as const,
      artifactRoot: undefined,
      included: ['docs/owner/', 'docs/superpowers/specs/', 'docs/superpowers/plans/'],
      excluded: [],
    },
  ])(
    'prints only the actual $label workspace paths in the text summary',
    async ({ workflow, artifactRoot, included, excluded }) => {
      mockExternalSuccess();
      await fs.mkdir(path.join(tmpDir, '.claude'), { recursive: true });

      const { initCommand } = await import('../../app/commands/init.js');
      const output = (
        await captureTextOutput(() =>
          initCommand(tmpDir, {
            yes: true,
            workflow,
            artifactRoot,
            language: 'en',
          }),
        )
      ).replaceAll('\\', '/');

      for (const expected of included) expect(output).toContain(expected);
      for (const unexpected of excluded) expect(output).not.toContain(unexpected);
    },
    INIT_E2E_TIMEOUT_MS,
  );

  it.each([
    { workflow: 'classic' as const, migrated: true },
    { workflow: 'native' as const, migrated: false },
  ])(
    'migrates Classic v1 selection only when init enables Classic ($workflow)',
    async ({ workflow, migrated }) => {
      mockExternalSuccess();
      await fs.mkdir(path.join(tmpDir, '.claude'), { recursive: true });
      const selectionPath = path.join(tmpDir, '.owner', 'current-change.json');
      await fs.mkdir(path.dirname(selectionPath), { recursive: true });
      await fs.writeFile(
        selectionPath,
        `${JSON.stringify({ version: 1, change: 'legacy-change', branch: null })}\n`,
      );

      const { initCommand } = await import('../../app/commands/init.js');
      await captureJsonOutput(() =>
        initCommand(tmpDir, { yes: true, json: true, workflow, language: 'en' }),
      );

      const selection = JSON.parse(await fs.readFile(selectionPath, 'utf8'));
      expect(selection).toEqual(
        migrated
          ? {
              schema: 'owner.selection.v2',
              workflow: 'classic',
              change: 'legacy-change',
              branch: null,
            }
          : { version: 1, change: 'legacy-change', branch: null },
      );
    },
  );

  it('materializes an old symlink installation before Native copy without writing through it', async () => {
    mockExternalSuccess();
    const centralSkills = path.join(tmpDir, '.owner', 'skills', 'skills');
    const centralOwner = path.join(centralSkills, 'owner');
    const platformSkills = path.join(tmpDir, '.claude', 'skills');
    await fs.mkdir(centralOwner, { recursive: true });
    await fs.writeFile(path.join(centralOwner, 'SKILL.md'), '# Central stale Owner\n', 'utf8');
    await fs.mkdir(path.dirname(platformSkills), { recursive: true });
    await fs.symlink(
      centralSkills,
      platformSkills,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const { initCommand } = await import('../../app/commands/init.js');
    const result = await captureJsonOutput(() =>
      initCommand(tmpDir, {
        yes: true,
        json: true,
        scope: 'project',
        workflow: 'native',
        installMode: 'symlink',
      }),
    );

    expect(result).toMatchObject({ workflow: 'native', projectConfigCreated: true });
    expect((await fs.lstat(platformSkills)).isSymbolicLink()).toBe(false);
    await expect(
      fs.readFile(path.join(platformSkills, 'owner', 'SKILL.md'), 'utf8'),
    ).resolves.toContain('owner workflow resolve . --activate --json');
    await expect(fs.readFile(path.join(centralOwner, 'SKILL.md'), 'utf8')).resolves.toBe(
      '# Central stale Owner\n',
    );
    await expect(
      fs.access(path.join(centralSkills, 'owner-native', 'SKILL.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['native', 'classic'] as const)(
    'installs project-scoped %s assets even when Owner is installed globally',
    async (workflow) => {
      mockExternalSuccess();
      await fs.mkdir(path.join(tmpDir, '.claude'), { recursive: true });
      await fs.mkdir(path.join(os.homedir(), '.claude', 'skills', 'owner'), { recursive: true });
      await fs.writeFile(
        path.join(os.homedir(), '.claude', 'skills', 'owner', 'SKILL.md'),
        '# global Owner\n',
        'utf8',
      );

      const { initCommand } = await import('../../app/commands/init.js');
      const result = await captureJsonOutput(() =>
        initCommand(tmpDir, { yes: true, json: true, scope: 'project', workflow }),
      );

      const claudeResult = (result.results as { platform: string; owner: string }[]).find(
        (candidate) => candidate.platform === 'claude',
      );
      expect(claudeResult?.owner).toBe('installed');

      const manifest = await readManifest();
      for (const skillPath of skillPathsForWorkflow(manifest, workflow)) {
        await expect(
          fs.access(path.join(tmpDir, '.claude', 'skills', skillPath)),
        ).resolves.toBeUndefined();
      }
      const excludedPaths = manifest.skills.filter(
        (skillPath: string) => !skillPathsForWorkflow(manifest, workflow).includes(skillPath),
      );
      for (const skillPath of excludedPaths) {
        await expect(
          fs.access(path.join(tmpDir, '.claude', 'skills', skillPath)),
        ).rejects.toMatchObject({ code: 'ENOENT' });
      }
    },
  );

  it('fills missing workflow entries without overwriting an existing Owner Skill', async () => {
    mockExternalSuccess();
    const existingSkill = path.join(tmpDir, '.claude', 'skills', 'owner', 'SKILL.md');
    await fs.mkdir(path.dirname(existingSkill), { recursive: true });
    const bundledEntry = await fs.readFile(
      path.resolve('assets', 'skills', 'owner', 'SKILL.md'),
      'utf8',
    );
    await fs.writeFile(existingSkill, bundledEntry, 'utf8');

    const { initCommand } = await import('../../app/commands/init.js');
    const result = await captureJsonOutput(() =>
      initCommand(tmpDir, {
        yes: true,
        json: true,
        scope: 'project',
        workflow: 'native',
      }),
    );

    expect(result).toMatchObject({
      workflow: 'native',
      projectConfigCreated: true,
      results: [expect.objectContaining({ platform: 'claude', owner: 'installed' })],
    });
    await expect(fs.readFile(existingSkill, 'utf8')).resolves.toBe(bundledEntry);
    await expect(
      fs.access(path.join(tmpDir, '.claude', 'skills', 'owner-native', 'SKILL.md')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(tmpDir, '.claude', 'skills', 'owner-classic', 'SKILL.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not activate Native with --skip-existing when required Native assets are missing', async () => {
    mockExternalSuccess();
    const skillsRoot = path.join(tmpDir, '.claude', 'skills');
    const preinstalledFiles = ['owner/SKILL.md', 'owner/scripts/owner-entry-runtime.mjs'];

    for (const relativePath of preinstalledFiles) {
      const destination = path.join(skillsRoot, ...relativePath.split('/'));
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(path.resolve('assets', 'skills', ...relativePath.split('/')), destination);
    }

    const { initCommand } = await import('../../app/commands/init.js');
    await expect(
      initCommand(tmpDir, {
        yes: true,
        json: true,
        scope: 'project',
        workflow: 'native',
        skipExisting: true,
      }),
    ).rejects.toThrow(/required Native asset owner\/scripts\/owner-hook-router\.mjs is missing/u);

    await expect(fs.access(path.join(tmpDir, '.owner', 'config.yaml'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.access(path.join(tmpDir, 'owner'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not activate Native over a mismatched existing /owner entry without overwrite', async () => {
    mockExternalSuccess();
    const existingSkill = path.join(tmpDir, '.claude', 'skills', 'owner', 'SKILL.md');
    await fs.mkdir(path.dirname(existingSkill), { recursive: true });
    await fs.writeFile(existingSkill, '# User-pinned legacy Owner\n', 'utf8');

    const { initCommand } = await import('../../app/commands/init.js');
    await expect(
      initCommand(tmpDir, {
        yes: true,
        json: true,
        scope: 'project',
        workflow: 'native',
      }),
    ).rejects.toThrow(/differs from the bundled routing contract.*--overwrite/iu);

    await expect(fs.readFile(existingSkill, 'utf8')).resolves.toBe('# User-pinned legacy Owner\n');
    await expect(fs.access(path.join(tmpDir, '.owner', 'config.yaml'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.access(path.join(tmpDir, 'owner'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed on malformed project config before installer writes', async () => {
    mockExternalSuccess();
    await fs.mkdir(path.join(tmpDir, '.claude'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, '.owner'), { recursive: true });
    const configPath = path.join(tmpDir, '.owner', 'config.yaml');
    const malformed = 'schema: [broken\n';
    await fs.writeFile(configPath, malformed, 'utf8');

    const { initCommand } = await import('../../app/commands/init.js');
    await expect(initCommand(tmpDir, { yes: true, json: true, scope: 'project' })).rejects.toThrow(
      /Invalid \.owner\/config\.yaml/u,
    );

    await expect(fs.readFile(configPath, 'utf8')).resolves.toBe(malformed);
    await expect(fs.access(path.join(tmpDir, '.claude', 'skills'))).rejects.toThrow();
    await expect(fs.access(path.join(tmpDir, 'owner'))).rejects.toThrow();
    await expect(fs.access(path.join(tmpDir, '.owner'))).resolves.toBeUndefined();
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it('uses detected platforms without prompting in JSON mode', async () => {
    await fs.mkdir(path.join(tmpDir, '.codex'), { recursive: true });
    const { platformSelectPrompt } = await import('../../app/commands/platform-select-prompt.js');

    const { initCommand } = await import('../../app/commands/init.js');
    const result = await captureJsonOutput(() =>
      initCommand(tmpDir, {
        json: true,
        scope: 'project',
        language: 'en',
        installMode: 'copy',
      }),
    );

    expect(result).toMatchObject({
      status: 'complete',
      workflow: 'native',
      projectConfigCreated: true,
      selectedPlatforms: ['codex'],
      results: [expect.objectContaining({ platform: 'codex', owner: 'installed' })],
    });
    expect(platformSelectPrompt).not.toHaveBeenCalled();
  });

  it('initializes only the explicit native platform target', async () => {
    mockExternalSuccess();
    const { platformSelectPrompt } = await import('../../app/commands/platform-select-prompt.js');
    const { initCommand } = await import('../../app/commands/init.js');

    const result = await captureJsonOutput(() =>
      initCommand(tmpDir, {
        yes: true,
        json: true,
        platform: 'codex',
      }),
    );

    expect(result).toMatchObject({
      status: 'complete',
      selectedPlatforms: ['codex'],
      results: [expect.objectContaining({ platform: 'codex', owner: 'installed' })],
    });
    expect(platformSelectPrompt).not.toHaveBeenCalled();
    await expect(
      fs.access(path.join(tmpDir, '.agents', 'skills', 'owner', 'SKILL.md')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(tmpDir, '.claude', 'skills', 'owner', 'SKILL.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('stores a project-relative Native artifact template at global scope without creating artifacts', async () => {
    mockExternalSuccess();
    await fs.mkdir(path.join(tmpDir, '.claude'), { recursive: true });

    const { initCommand } = await import('../../app/commands/init.js');
    const result = await captureJsonOutput(() =>
      initCommand(tmpDir, {
        yes: true,
        json: true,
        scope: 'global',
        workflow: 'native',
        artifactRoot: 'artifacts',
      }),
    );

    expect(result).toMatchObject({ scope: 'global', workflow: 'native' });
    await expect(
      fs.readFile(path.join(os.homedir(), '.owner', 'config.yaml'), 'utf8'),
    ).resolves.toContain('artifact_root: artifacts');
    await expect(
      fs.readFile(path.join(os.homedir(), '.owner', 'config.yaml'), 'utf8'),
    ).resolves.not.toMatch(/^\s+snapshot:/mu);
    await expect(fs.access(path.join(os.homedir(), 'artifacts', 'owner'))).rejects.toThrow();
    await expect(fs.access(path.join(tmpDir, '.owner', 'config.yaml'))).rejects.toThrow();
  });

  it('preserves an existing global Ambient Resume preference during re-initialization', async () => {
    mockExternalSuccess();
    const fakeHome = path.join(tmpDir, 'fake-home-existing-global');
    await fs.mkdir(path.join(fakeHome, '.owner'), { recursive: true });
    await fs.writeFile(
      path.join(fakeHome, '.owner', 'config.yaml'),
      [
        'schema: owner.global.v1',
        'default_workflow: native',
        'workflows:',
        '  - native',
        'ambient_resume: false',
        'native:',
        '  artifact_root: docs',
        '  snapshot:',
        '    include: ["**/*"]',
        '    exclude:',
        '      - custom/global-generated/**',
        '',
      ].join('\n'),
    );
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

    try {
      const { initCommand } = await import('../../app/commands/init.js');
      await captureJsonOutput(() =>
        initCommand(tmpDir, {
          yes: true,
          json: true,
          scope: 'global',
          workflow: 'native',
        }),
      );
    } finally {
      homedirSpy.mockRestore();
    }

    await expect(
      fs.readFile(path.join(fakeHome, '.owner', 'config.yaml'), 'utf8'),
    ).resolves.toMatch(/ambient_resume: false/);
    const globalConfig = parse(
      await fs.readFile(path.join(fakeHome, '.owner', 'config.yaml'), 'utf8'),
    ) as { native: { snapshot?: unknown } };
    expect(globalConfig.native.snapshot).toBeUndefined();
  });

  it('does not publish a global Classic default when OpenSpec initialization fails', async () => {
    mockExternalSuccess();
    await fs.mkdir(path.join(tmpDir, '.claude'), { recursive: true });
    const externalSuccess = mockedExecFileSync.getMockImplementation();
    mockedExecFileSync.mockImplementation((command, args, options) => {
      const cmd = String(command);
      const cmdArgs = Array.isArray(args) ? args.map(String) : [];
      if (cmd === 'openspec' && cmdArgs[0] === 'init') {
        throw new Error('OpenSpec global initialization failed');
      }
      return externalSuccess?.(command, args, options) ?? Buffer.from('');
    });

    const { initCommand } = await import('../../app/commands/init.js');
    const result = await captureJsonOutput(() =>
      initCommand(tmpDir, {
        yes: true,
        json: true,
        scope: 'global',
        workflow: 'classic',
      }),
    );

    expect(result.status).toBe('incomplete');
    await expect(fs.access(path.join(os.homedir(), '.owner', 'config.yaml'))).rejects.toMatchObject(
      { code: 'ENOENT' },
    );
  });

  it(
    'initializes both Native and Classic skills at global scope when explicitly selected',
    async () => {
      mockExternalSuccess();
      await fs.mkdir(path.join(tmpDir, '.claude'), { recursive: true });
      const fakeHome = path.join(tmpDir, 'fake-home');
      await fs.mkdir(fakeHome, { recursive: true });

      const { initCommand } = await import('../../app/commands/init.js');
      const result = await captureJsonOutput(() =>
        initCommand(tmpDir, {
          yes: true,
          json: true,
          scope: 'global',
          workflow: 'both',
          language: 'en',
        }),
      );

      expect(result).toMatchObject({
        scope: 'global',
        workflow: 'native',
        initializedWorkflows: ['native', 'classic'],
        workingDirsCreated: false,
      });
      for (const skill of ['owner-native', 'owner-classic']) {
        await expect(
          fs.access(path.join(fakeHome, '.claude', 'skills', skill, 'SKILL.md')),
        ).resolves.toBeUndefined();
      }
    },
    INIT_E2E_TIMEOUT_MS,
  );

  it(
    'offers Native, Classic, and Both during interactive global initialization',
    async () => {
      mockExternalSuccess();
      await fs.mkdir(path.join(tmpDir, '.codex'), { recursive: true });
      const fakeHome = path.join(tmpDir, 'fake-home');
      await fs.mkdir(fakeHome, { recursive: true });

      const { checkbox, select } = await import('@inquirer/prompts');
      const { platformSelectPrompt } = await import('../../app/commands/platform-select-prompt.js');
      vi.mocked(select).mockResolvedValueOnce('both').mockResolvedValueOnce('copy');
      vi.mocked(platformSelectPrompt).mockResolvedValue(['codex']);
      vi.mocked(checkbox).mockResolvedValue([]);

      const { initCommand } = await import('../../app/commands/init.js');
      await captureTextOutput(() =>
        initCommand(tmpDir, {
          scope: 'global',
          language: 'en',
        }),
      );

      expect(select).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          message: 'Select Owner workflow(s):',
          choices: [
            expect.objectContaining({ value: 'native' }),
            expect.objectContaining({ value: 'classic' }),
            expect.objectContaining({ value: 'both' }),
          ],
          default: 'native',
        }),
      );
      for (const skill of ['owner-native', 'owner-classic']) {
        await expect(
          fs.access(path.join(fakeHome, '.agents', 'skills', skill, 'SKILL.md')),
        ).resolves.toBeUndefined();
      }
    },
    INIT_E2E_TIMEOUT_MS,
  );

  it('leaves project workflow state untouched when every Owner asset copy fails', async () => {
    mockExternalSuccess();
    await fs.mkdir(path.join(tmpDir, '.claude'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.claude', 'skills'), 'not a directory', 'utf8');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { initCommand } = await import('../../app/commands/init.js');
    const result = await captureJsonOutput(() =>
      initCommand(tmpDir, { yes: true, json: true, scope: 'project' }),
    );

    expect(result).toMatchObject({
      status: 'incomplete',
      workflow: 'native',
      projectConfigCreated: false,
      workingDirsCreated: false,
    });
    expect(result.failures).toEqual([
      expect.objectContaining({
        platform: 'claude',
        component: 'Owner',
        reason: expect.any(String),
      }),
    ]);
    expect(result.results).toEqual([
      expect.objectContaining({ platform: 'claude', owner: 'failed' }),
    ]);
    await expect(fs.access(path.join(tmpDir, '.owner', 'config.yaml'))).rejects.toThrow();
    await expect(fs.access(path.join(tmpDir, 'owner'))).rejects.toThrow();
    await expect(fs.access(path.join(tmpDir, '.owner'))).rejects.toThrow();
  });

  it('does not activate a project workflow when any selected platform copy fails', async () => {
    mockExternalSuccess();
    await fs.mkdir(path.join(tmpDir, '.claude'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, '.codex'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.claude', 'skills'), 'not a directory', 'utf8');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { initCommand } = await import('../../app/commands/init.js');
    const result = await captureJsonOutput(() =>
      initCommand(tmpDir, {
        yes: true,
        json: true,
        scope: 'project',
        workflow: 'native',
      }),
    );

    expect(result).toMatchObject({
      workflow: 'native',
      projectConfigCreated: false,
      workingDirsCreated: false,
      results: expect.arrayContaining([
        expect.objectContaining({ platform: 'claude', owner: 'failed' }),
        expect.objectContaining({ platform: 'codex', owner: 'installed' }),
      ]),
    });
    await expect(fs.access(path.join(tmpDir, '.owner', 'config.yaml'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.access(path.join(tmpDir, 'owner'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    { label: 'create', existingWorkflow: null },
    { label: 'switch', existingWorkflow: 'classic' as const },
  ])(
    'does not $label Native activation when the second project instructions file is invalid',
    async ({ existingWorkflow }) => {
      mockExternalSuccess();
      await fs.mkdir(path.join(tmpDir, '.claude'), { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, 'CLAUDE.md'),
        '# User rules\n\n<owner-ambient-resume>\nincomplete\n',
        'utf8',
      );

      const configPath = path.join(tmpDir, '.owner', 'config.yaml');
      if (existingWorkflow) {
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(
          configPath,
          [
            'schema: owner.project.v1',
            `default_workflow: ${existingWorkflow}`,
            'native:',
            '  artifact_root: .',
            '',
          ].join('\n'),
          'utf8',
        );
      }

      const { initCommand } = await import('../../app/commands/init.js');
      const result = await captureJsonOutput(() =>
        initCommand(tmpDir, {
          yes: true,
          json: true,
          scope: 'project',
          workflow: 'native',
        }),
      );
      expect(result).toMatchObject({
        status: 'incomplete',
        failures: [
          expect.objectContaining({
            component: 'Finalization',
            reason: expect.stringMatching(/incomplete managed block/u),
          }),
        ],
      });

      if (existingWorkflow) {
        const config = await fs.readFile(configPath, 'utf8');
        expect(config).toContain(`default_workflow: ${existingWorkflow}`);
        expect(config).not.toContain('default_workflow: native');
      } else {
        await expect(fs.access(configPath)).rejects.toThrow();
      }
    },
  );

  it(
    'installs Owner skills at global scope',
    async () => {
      mockExternalSuccess();

      await fs.mkdir(path.join(tmpDir, '.claude'), { recursive: true });
      const fakeHome = path.join(tmpDir, 'fake-home');
      await fs.mkdir(fakeHome, { recursive: true });

      vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

      const { initCommand } = await import('../../app/commands/init.js');
      const result = await captureJsonOutput(() =>
        initCommand(tmpDir, { yes: true, scope: 'global', json: true }),
      );

      expect(result.scope).toBe('global');
      expect(result.workingDirsCreated).toBe(false);

      const config = await fs.readFile(path.join(fakeHome, '.owner', 'config.yaml'), 'utf-8');
      expect(config).toContain('schema: owner.global.v1');
      expect(config).toContain('default_workflow: native');
      expect(config).toContain('language: en');

      const manifest = await readManifest();
      for (const skillPath of skillPathsForWorkflow(manifest, 'native')) {
        const dest = path.join(fakeHome, '.claude', 'skills', skillPath);
        await expect(fs.access(dest)).resolves.toBeUndefined();
      }
      await expect(
        fs.access(path.join(fakeHome, '.claude', 'skills', 'owner-native', 'SKILL.md')),
      ).resolves.toBeUndefined();

      await expect(fs.stat(path.join(tmpDir, 'docs', 'superpowers', 'specs'))).rejects.toThrow();
    },
    INIT_E2E_TIMEOUT_MS,
  );

  it(
    'installs Codex skills under .agents while keeping phase rules under .codex',
    async () => {
      mockExternalSuccess();
      await fs.mkdir(path.join(tmpDir, '.codex'), { recursive: true });

      const { initCommand } = await import('../../app/commands/init.js');
      const result = await captureJsonOutput(() =>
        initCommand(tmpDir, { yes: true, json: true, workflow: 'classic' }),
      );

      expect(result.selectedPlatforms).toEqual(['codex']);
      await expect(
        fs.access(path.join(tmpDir, '.agents', 'skills', 'owner', 'SKILL.md')),
      ).resolves.toBeUndefined();
      await expect(
        fs.access(path.join(tmpDir, '.codex', 'skills', 'owner', 'SKILL.md')),
      ).rejects.toThrow();

      const ruleDest = path.join(tmpDir, '.codex', 'rules', 'owner-workflow-guard.md');
      await expect(fs.access(ruleDest)).resolves.toBeUndefined();
      await expect(
        fs.access(path.join(tmpDir, '.agents', 'rules', 'owner-workflow-guard.md')),
      ).rejects.toThrow();

      const hooks = JSON.parse(
        await fs.readFile(path.join(tmpDir, '.codex', 'hooks.json'), 'utf8'),
      );
      const hookCommand = hooks.hooks.PreToolUse[0].hooks[0].command as string;
      expect(hookCommand.replaceAll('\\', '/')).toContain(
        '/.agents/skills/owner/scripts/owner-hook-router.mjs',
      );
      await expect(
        fs.access(path.join(tmpDir, '.codex', 'settings.local.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    },
    INIT_E2E_TIMEOUT_MS,
  );

  it(
    'Skill failure skips dependent Rule and Hook installation and leaves init incomplete',
    async () => {
      mockExternalSuccess();
      await fs.mkdir(path.join(tmpDir, '.codex'), { recursive: true });
      const centralOwnerDir = path.join(tmpDir, '.owner', 'skills', 'skills', 'owner');
      await fs.mkdir(centralOwnerDir, { recursive: true });
      await fs.writeFile(path.join(centralOwnerDir, 'scripts'), 'blocking file');

      const { initCommand } = await import('../../app/commands/init.js');
      const output = await captureTextOutput(() =>
        initCommand(tmpDir, {
          yes: true,
          language: 'en',
          installMode: 'symlink',
          workflow: 'classic',
        }),
      );

      expect(output).toMatch(/Codex \(Owner failed\)/u);
      await expect(
        fs.access(path.join(tmpDir, '.codex', 'rules', 'owner-workflow-guard.md')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.access(path.join(tmpDir, '.codex', 'hooks.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(
        fs.access(getProjectRegistryPath(path.join(tmpDir, 'fake-home'))),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    },
    INIT_E2E_TIMEOUT_MS,
  );

  it(
    'init --yes reuses an existing managed Skill and restores missing Codex Rule and Hook components',
    async () => {
      mockExternalSuccess();
      const fakeHome = path.join(tmpDir, 'fake-home');
      await fs.mkdir(path.join(tmpDir, '.codex'), { recursive: true });
      const { initCommand } = await import('../../app/commands/init.js');

      await captureJsonOutput(() =>
        initCommand(tmpDir, { yes: true, json: true, language: 'en', workflow: 'classic' }),
      );
      await fs.rm(path.join(tmpDir, '.codex', 'rules'), { recursive: true, force: true });
      await fs.rm(path.join(tmpDir, '.codex', 'hooks.json'), { force: true });
      await fs.rm(getProjectRegistryPath(fakeHome), { force: true });

      const result = await captureJsonOutput(() =>
        initCommand(tmpDir, { yes: true, json: true, language: 'en', workflow: 'classic' }),
      );
      const codex = (result.results as Array<{ platform: string; owner: string }>).find(
        (candidate) => candidate.platform === 'codex',
      );

      expect(codex?.owner).toBe('installed');
      await expect(
        fs.access(path.join(tmpDir, '.codex', 'rules', 'owner-workflow-guard.md')),
      ).resolves.toBeUndefined();
      await expect(fs.access(path.join(tmpDir, '.codex', 'hooks.json'))).resolves.toBeUndefined();
      const registry = JSON.parse(await fs.readFile(getProjectRegistryPath(fakeHome), 'utf8')) as {
        projects: Array<{ lastTargets: Array<{ platform: string }> }>;
      };
      expect(registry.projects[0].lastTargets).toContainEqual(
        expect.objectContaining({ platform: 'codex' }),
      );
    },
    INIT_E2E_TIMEOUT_MS,
  );

  it(
    'repeated init preserves both artifact roots and uses the configured Classic layout when both roots exist',
    async () => {
      mockExternalSuccess();
      await fs.mkdir(path.join(tmpDir, '.codex'), { recursive: true });
      const { initCommand } = await import('../../app/commands/init.js');

      await captureJsonOutput(() =>
        initCommand(tmpDir, { yes: true, json: true, language: 'en', workflow: 'classic' }),
      );
      await fs.mkdir(path.join(tmpDir, 'openspec'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'openspec', 'legacy-marker.txt'), 'legacy\n', 'utf8');
      await fs.writeFile(
        path.join(tmpDir, 'docs', 'openspec', 'docs-marker.txt'),
        'docs\n',
        'utf8',
      );
      mockedExecFileSync.mockClear();
      mockExternalSuccess();
      const result = await captureJsonOutput(() =>
        initCommand(tmpDir, { yes: true, json: true, language: 'en', workflow: 'classic' }),
      );

      expect(result).toMatchObject({
        status: 'complete',
        classicArtifactLayout: 'docs',
      });
      expect(
        mockedExecFileSync.mock.calls.some(
          ([command, args]) => command === 'openspec' && Array.isArray(args) && args[0] === 'init',
        ),
      ).toBe(true);
      await expect(
        fs.readFile(path.join(tmpDir, 'openspec', 'legacy-marker.txt'), 'utf8'),
      ).resolves.toBe('legacy\n');
      await expect(
        fs.readFile(path.join(tmpDir, 'docs', 'openspec', 'docs-marker.txt'), 'utf8'),
      ).resolves.toBe('docs\n');
      const config = parse(
        await fs.readFile(path.join(tmpDir, '.owner', 'config.yaml'), 'utf8'),
      ) as {
        classic?: { artifact_layout?: string };
      };
      expect(config.classic?.artifact_layout).toBe('docs');
    },
    INIT_E2E_TIMEOUT_MS,
  );

  it(
    'init --yes project scope does not treat a global-only Skill as a complete local install',
    async () => {
      mockExternalSuccess();
      const fakeHome = path.join(tmpDir, 'fake-home');
      await fs.mkdir(path.join(tmpDir, '.codex'), { recursive: true });
      const { initCommand } = await import('../../app/commands/init.js');

      await captureJsonOutput(() =>
        initCommand(tmpDir, { yes: true, json: true, language: 'en', scope: 'global' }),
      );
      await fs.mkdir(path.join(tmpDir, '.agents'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, '.agents', 'skills'), 'blocking file', 'utf8');

      const result = await captureJsonOutput(() =>
        initCommand(tmpDir, { yes: true, json: true, language: 'en', scope: 'project' }),
      );
      const codex = (result.results as Array<{ platform: string; owner: string }>).find(
        (candidate) => candidate.platform === 'codex',
      );

      expect(codex?.owner).toBe('failed');
      await expect(fs.access(path.join(tmpDir, '.codex', 'hooks.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(fs.access(getProjectRegistryPath(fakeHome))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
    INIT_E2E_TIMEOUT_MS,
  );

  it(
    'init --yes repairs a partial local Skill before restoring dependent Rule and Hook components',
    async () => {
      mockExternalSuccess();
      const fakeHome = path.join(tmpDir, 'fake-home');
      await fs.mkdir(path.join(tmpDir, '.codex'), { recursive: true });
      const { initCommand } = await import('../../app/commands/init.js');
      const guardScript = path.join(
        tmpDir,
        '.agents',
        'skills',
        'owner',
        'scripts',
        'owner-hook-router.mjs',
      );

      await captureJsonOutput(() =>
        initCommand(tmpDir, { yes: true, json: true, language: 'en', workflow: 'classic' }),
      );
      await fs.rm(guardScript, { force: true });
      await fs.rm(path.join(tmpDir, '.codex', 'rules'), { recursive: true, force: true });
      await fs.rm(path.join(tmpDir, '.codex', 'hooks.json'), { force: true });
      await fs.rm(getProjectRegistryPath(fakeHome), { force: true });

      const result = await captureJsonOutput(() =>
        initCommand(tmpDir, { yes: true, json: true, language: 'en', workflow: 'classic' }),
      );
      const codex = (result.results as Array<{ platform: string; owner: string }>).find(
        (candidate) => candidate.platform === 'codex',
      );

      expect(codex?.owner).toBe('installed');
      await expect(fs.access(guardScript)).resolves.toBeUndefined();
      await expect(fs.access(path.join(tmpDir, '.codex', 'hooks.json'))).resolves.toBeUndefined();
      const registry = JSON.parse(await fs.readFile(getProjectRegistryPath(fakeHome), 'utf8')) as {
        projects: Array<{ lastTargets: Array<{ platform: string }> }>;
      };
      expect(registry.projects[0].lastTargets).toContainEqual(
        expect.objectContaining({ platform: 'codex' }),
      );
    },
    INIT_E2E_TIMEOUT_MS,
  );

  it(
    'init --yes does not register reused Skills when canonical Hook validation fails',
    async () => {
      mockExternalSuccess();
      const fakeHome = path.join(tmpDir, 'fake-home');
      await fs.mkdir(path.join(tmpDir, '.codex'), { recursive: true });
      const { initCommand } = await import('../../app/commands/init.js');

      await captureJsonOutput(() =>
        initCommand(tmpDir, { yes: true, json: true, language: 'en', workflow: 'classic' }),
      );
      await fs.writeFile(path.join(tmpDir, '.codex', 'hooks.json'), '[]\n', 'utf8');
      await fs.rm(getProjectRegistryPath(fakeHome), { force: true });

      const result = await captureJsonOutput(() =>
        initCommand(tmpDir, { yes: true, json: true, language: 'en', workflow: 'classic' }),
      );
      const codex = (result.results as Array<{ platform: string; owner: string }>).find(
        (candidate) => candidate.platform === 'codex',
      );

      expect(codex?.owner).toBe('failed');
      let projects: unknown[] = [];
      try {
        projects = (
          JSON.parse(await fs.readFile(getProjectRegistryPath(fakeHome), 'utf8')) as {
            projects: unknown[];
          }
        ).projects;
      } catch (error) {
        expect(error).toMatchObject({ code: 'ENOENT' });
      }
      expect(projects).toEqual([]);
    },
    INIT_E2E_TIMEOUT_MS,
  );

  it(
    'an explicit skip of existing Owner Skills does not register an incomplete target',
    async () => {
      mockExternalSuccess();
      const fakeHome = path.join(tmpDir, 'fake-home');
      await fs.mkdir(path.join(tmpDir, '.codex'), { recursive: true });
      const { initCommand } = await import('../../app/commands/init.js');

      await captureJsonOutput(() =>
        initCommand(tmpDir, { yes: true, json: true, language: 'en', workflow: 'classic' }),
      );
      await fs.rm(path.join(tmpDir, '.codex', 'rules'), { recursive: true, force: true });
      await fs.rm(path.join(tmpDir, '.codex', 'hooks.json'), { force: true });
      await fs.rm(getProjectRegistryPath(fakeHome), { force: true });

      await captureJsonOutput(() =>
        initCommand(tmpDir, {
          yes: true,
          json: true,
          language: 'en',
          workflow: 'classic',
          skipExisting: true,
        }),
      );

      let projects: unknown[] = [];
      try {
        projects = (
          JSON.parse(await fs.readFile(getProjectRegistryPath(fakeHome), 'utf8')) as {
            projects: unknown[];
          }
        ).projects;
      } catch (error) {
        expect(error).toMatchObject({ code: 'ENOENT' });
      }
      expect(projects).toEqual([]);
    },
    INIT_E2E_TIMEOUT_MS,
  );

  it.each([
    { component: 'Rule', outcome: 'returned' },
    { component: 'Rule', outcome: 'thrown' },
    { component: 'Hook', outcome: 'returned' },
    { component: 'Hook', outcome: 'thrown' },
  ] as const)(
    '$component $outcome failure makes init Owner failed and prevents registry success',
    async ({ component, outcome }) => {
      mockExternalSuccess();
      await fs.mkdir(path.join(tmpDir, '.codex'), { recursive: true });
      const platformInstall = await import('../../domains/skill/platform-install.js');

      if (component === 'Rule') {
        const ruleSpy = vi.spyOn(platformInstall, 'copyOwnerRulesForPlatform');
        if (outcome === 'returned') {
          ruleSpy.mockResolvedValueOnce({ copied: 0, skipped: 0, failed: 1 });
        } else {
          ruleSpy.mockRejectedValueOnce(new Error('rule install threw'));
        }
      } else {
        const hookSpy = vi.spyOn(platformInstall, 'installOwnerHooksForPlatform');
        if (outcome === 'returned') {
          hookSpy.mockResolvedValueOnce({
            status: 'failed',
            reason: 'hook install returned failed',
          });
        } else {
          hookSpy.mockRejectedValueOnce(new Error('hook install threw'));
        }
      }

      const { initCommand } = await import('../../app/commands/init.js');
      const result = await captureJsonOutput(() =>
        initCommand(tmpDir, { yes: true, json: true, language: 'en', workflow: 'classic' }),
      );
      const codexResult = (result.results as { platform: string; owner: string }[]).find(
        (candidate) => candidate.platform === 'codex',
      );

      expect(codexResult?.owner).toBe('failed');
      expect(result).toMatchObject({
        status: 'incomplete',
        failures: [
          expect.objectContaining({
            platform: 'codex',
            component,
            reason: expect.stringMatching(component === 'Rule' ? /rule/iu : /hook/iu),
          }),
        ],
      });
      await expect(
        fs.access(getProjectRegistryPath(path.join(tmpDir, 'fake-home'))),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    },
    INIT_E2E_TIMEOUT_MS,
  );

  it('records project-scope Owner installs in the user project registry', async () => {
    const fakeHome = path.join(tmpDir, 'fake-home');
    await fs.mkdir(fakeHome, { recursive: true });
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

    try {
      const { initCommand } = await import('../../app/commands/init.js');
      await captureJsonOutput(() =>
        initCommand(tmpDir, { yes: true, scope: 'project', json: true, language: 'en' }),
      );
    } finally {
      homedirSpy.mockRestore();
    }

    const registry = JSON.parse(await fs.readFile(getProjectRegistryPath(fakeHome), 'utf-8'));
    expect(registry.projects).toHaveLength(1);
    expect(registry.projects[0]).toMatchObject({
      path: path.resolve(tmpDir),
      lastSource: 'init',
    });
    expect(registry.projects[0].lastTargets.length).toBeGreaterThan(0);
  });

  it('removes the historical global Router when project init installs the replacement', async () => {
    mockExternalSuccess();
    const fakeHome = os.homedir();
    const globalHooksPath = path.join(fakeHome, '.codex', 'hooks.json');
    const userHook = { type: 'command', command: 'node user-hook.mjs' };
    const globalRouter = {
      type: 'command',
      command: `node "${path.join(
        fakeHome,
        '.agents',
        'skills',
        'owner',
        'scripts',
        'owner-hook-router.mjs',
      )}" --platform codex`,
    };
    await fs.mkdir(path.dirname(globalHooksPath), { recursive: true });
    await fs.writeFile(
      globalHooksPath,
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'Write|Edit', hooks: [userHook, globalRouter] }] },
      }),
      'utf8',
    );

    const { initCommand } = await import('../../app/commands/init.js');
    const result = await captureJsonOutput(() =>
      initCommand(tmpDir, {
        yes: true,
        json: true,
        scope: 'project',
        platform: 'codex',
        workflow: 'native',
        language: 'en',
      }),
    );

    expect(result.status).toBe('complete');
    const globalHooks = JSON.parse(await fs.readFile(globalHooksPath, 'utf8'));
    expect(globalHooks.hooks.PreToolUse[0].hooks).toEqual([userHook]);
    const projectHooks = await fs.readFile(path.join(tmpDir, '.codex', 'hooks.json'), 'utf8');
    expect(projectHooks.replaceAll('\\', '/')).toContain(
      `${tmpDir.replaceAll('\\', '/')}/.agents/skills/owner/scripts/owner-hook-router.mjs`,
    );
  });

  it('reports project init as incomplete when historical global Hook cleanup is unsafe', async () => {
    mockExternalSuccess();
    const fakeHome = os.homedir();
    const legacyPath = path.join(fakeHome, '.codex', 'settings.local.json');
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(legacyPath, '{not-json', 'utf8');

    const { initCommand } = await import('../../app/commands/init.js');
    const result = await captureJsonOutput(() =>
      initCommand(tmpDir, {
        yes: true,
        json: true,
        scope: 'project',
        platform: 'codex',
        workflow: 'native',
        language: 'en',
      }),
    );

    expect(result.status).toBe('incomplete');
    expect(JSON.stringify(result)).toContain('historical global Hook');
    await expect(fs.readFile(legacyPath, 'utf8')).resolves.toBe('{not-json');
    await expect(fs.access(path.join(tmpDir, '.codex', 'hooks.json'))).resolves.toBeUndefined();
  });

  it('preserves the installed language when reusing an explicit project target', async () => {
    mockExternalSuccess();
    const fakeHome = path.join(tmpDir, 'fake-home-explicit-reuse-language');
    await fs.mkdir(path.join(tmpDir, '.agents', 'skills', 'owner'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, '.agents', 'skills', 'owner', 'SKILL.md'),
      '# Owner\n\n当用户提出需求时使用这个技能。',
      'utf-8',
    );
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

    try {
      const { initCommand } = await import('../../app/commands/init.js');
      await captureJsonOutput(() =>
        initCommand(tmpDir, {
          yes: true,
          scope: 'project',
          json: true,
          workflow: 'classic',
          platform: 'codex',
          language: 'en',
        }),
      );
    } finally {
      homedirSpy.mockRestore();
    }

    const registry = JSON.parse(await fs.readFile(getProjectRegistryPath(fakeHome), 'utf-8'));
    expect(registry.projects[0].lastTargets).toContainEqual({
      platform: 'codex',
      language: 'zh',
    });
  });

  it('does not record global-scope installs in the user project registry', async () => {
    const fakeHome = path.join(tmpDir, 'fake-home-global');
    await fs.mkdir(fakeHome, { recursive: true });
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

    try {
      const { initCommand } = await import('../../app/commands/init.js');
      await captureJsonOutput(() =>
        initCommand(tmpDir, { yes: true, scope: 'global', json: true, language: 'en' }),
      );
    } finally {
      homedirSpy.mockRestore();
    }

    await expect(fs.access(getProjectRegistryPath(fakeHome))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it(
    'reuses already-installed Owner skills with --yes and validates lifecycle components',
    async () => {
      mockExternalSuccess();
      await fs.mkdir(path.join(tmpDir, '.claude'), { recursive: true });

      const { initCommand } = await import('../../app/commands/init.js');
      const result1 = await captureJsonOutput(() =>
        initCommand(tmpDir, { yes: true, json: true, workflow: 'classic' }),
      );
      const claude1 = (result1.results as { platform: string; owner: string }[]).find(
        (r) => r.platform === 'claude',
      );
      expect(claude1?.owner).toBe('installed');

      vi.resetModules();
      vi.resetAllMocks();
      vi.spyOn(os, 'homedir').mockReturnValue(path.join(tmpDir, 'fake-home'));
      mockExternalSuccess();

      const { initCommand: init2 } = await import('../../app/commands/init.js');
      const result2 = await captureJsonOutput(() =>
        init2(tmpDir, { yes: true, json: true, workflow: 'classic' }),
      );
      const claude2 = (result2.results as { platform: string; owner: string }[]).find(
        (r) => r.platform === 'claude',
      );
      expect(claude2?.owner).toBe('installed');
    },
    INIT_E2E_TIMEOUT_MS,
  );

  it(
    'overwrites existing Owner skills with --overwrite',
    async () => {
      mockExternalSuccess();
      await fs.mkdir(path.join(tmpDir, '.claude'), { recursive: true });

      const { initCommand } = await import('../../app/commands/init.js');
      await captureJsonOutput(() => initCommand(tmpDir, { yes: true, json: true }));

      vi.resetModules();
      vi.resetAllMocks();
      vi.spyOn(os, 'homedir').mockReturnValue(path.join(tmpDir, 'fake-home'));
      mockExternalSuccess();

      const { initCommand: init2 } = await import('../../app/commands/init.js');
      const result = await captureJsonOutput(() =>
        init2(tmpDir, { yes: true, overwrite: true, json: true }),
      );
      const claude = (result.results as { platform: string; owner: string }[]).find(
        (r) => r.platform === 'claude',
      );
      expect(claude?.owner).toBe('installed');
    },
    INIT_E2E_TIMEOUT_MS,
  );

  it('fails before installer writes when the project registry is corrupt', async () => {
    mockExternalSuccess();
    await fs.mkdir(path.join(tmpDir, '.codex'), { recursive: true });
    const registryPath = getProjectRegistryPath(path.join(tmpDir, 'fake-home'));
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(registryPath, '{not-json', 'utf-8');

    const { initCommand } = await import('../../app/commands/init.js');
    await expect(initCommand(tmpDir, { yes: true, json: true, scope: 'project' })).rejects.toThrow(
      /registry is invalid JSON/iu,
    );
    await expect(fs.readFile(registryPath, 'utf-8')).resolves.toBe('{not-json');
    await expect(fs.access(path.join(tmpDir, '.agents', 'skills'))).rejects.toThrow();
  });

  it('uses platform selection prompt with selected summary labels in English', async () => {
    mockExternalSuccess();
    await fs.mkdir(path.join(tmpDir, '.codex'), { recursive: true });

    const { checkbox } = await import('@inquirer/prompts');
    const { platformSelectPrompt } = await import('../../app/commands/platform-select-prompt.js');
    vi.mocked(platformSelectPrompt).mockResolvedValue(['codex']);
    vi.mocked(checkbox).mockResolvedValue([]);

    const { initCommand } = await import('../../app/commands/init.js');

    await captureTextOutput(() =>
      initCommand(tmpDir, {
        scope: 'project',
        language: 'en',
        workflow: 'classic',
      }),
    );

    expect(platformSelectPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Select platforms to set up:',
        selectedLabel: 'Selected:',
        emptyLabel: 'none',
        requiredErrorLabel: 'Select at least one platform.',
        required: true,
      }),
    );
    expect(platformSelectPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        choices: expect.arrayContaining([
          expect.objectContaining({
            value: 'codex',
            name: 'Codex (detected)',
            summaryName: 'Codex',
            checked: true,
          }),
        ]),
      }),
    );
    expect(checkbox).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Select npm dependencies to install/upgrade:',
      }),
    );
  });

  it('uses localized selected summary labels in Chinese', async () => {
    mockExternalSuccess();
    await fs.mkdir(path.join(tmpDir, '.codex'), { recursive: true });

    const { checkbox } = await import('@inquirer/prompts');
    const { platformSelectPrompt } = await import('../../app/commands/platform-select-prompt.js');
    vi.mocked(platformSelectPrompt).mockResolvedValue(['codex']);
    vi.mocked(checkbox).mockResolvedValue([]);

    const { initCommand } = await import('../../app/commands/init.js');

    await captureTextOutput(() => initCommand(tmpDir, { scope: 'project', language: 'zh' }));

    expect(platformSelectPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '选择要配置的平台：',
        selectedLabel: '已选择：',
        emptyLabel: '无',
        requiredErrorLabel: '请至少选择一个平台。',
        required: true,
      }),
    );
  });
});
