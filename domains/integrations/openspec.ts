import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PLATFORMS } from '../../platform/install/platforms.js';
import { printCommandErrorDetails } from '../../platform/process/command-error.js';
import { quoteArgsForShell } from '../../platform/process/shell-quote.js';
import { atomicWriteContainedBytes } from '../workflow-contract/contained-atomic-write.js';
import {
  ensureProtectedProjectDirectory,
  inspectProtectedProjectPath,
} from '../workflow-contract/protected-project-path.js';

import type { InstallScope } from '../../platform/install/types.js';

const VALID_TOOL_IDS = new Set<string>(PLATFORMS.map((p) => p.openspecToolId));
const MINIMUM_OPENSPEC_VERSION = '1.5.0';
const ALL_OPENSPEC_WORKFLOWS = [
  'propose',
  'explore',
  'new',
  'continue',
  'apply',
  'ff',
  'sync',
  'archive',
  'bulk-archive',
  'verify',
  'onboard',
] as const;

type ProjectMutationGuard = () => void | Promise<void>;
type OpenSpecFailureObserver = (error: Error) => void;

class ProjectMutationGuardError extends Error {
  override readonly name = 'ProjectMutationGuardError';
}

function isProjectMutationGuardError(error: unknown): error is ProjectMutationGuardError {
  return error instanceof ProjectMutationGuardError;
}

function getNpmExecutable(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

function buildOpenSpecInitInvocation(
  projectPath: string,
  toolIds: string[],
  scope: InstallScope,
  homeDir = os.homedir(),
  includeProfileFlag = true,
): { command: string; args: string[] } {
  const targetPath = scope === 'global' ? homeDir : projectPath;
  const args = ['init', targetPath, '--tools', toolIds.join(',')];
  if (includeProfileFlag) {
    args.push('--profile', 'custom');
  }
  return { command: 'openspec', args };
}

async function assertProjectMutationAllowed(
  guard: ProjectMutationGuard | undefined,
  checkpoint: 'before' | 'after-external',
  partialMutationPossible = false,
): Promise<void> {
  if (!guard) return;
  try {
    await guard();
  } catch (error) {
    const detail = (error as Error).message;
    if (checkpoint === 'after-external' || partialMutationPossible) {
      throw new ProjectMutationGuardError(
        `OpenSpec project update partial failure: project mutation guard rejected the update after project mutation may have started: ${detail}`,
      );
    }
    throw new ProjectMutationGuardError(
      `Project mutation guard failed before OpenSpec project mutation: ${detail}`,
    );
  }
}

async function runOpenSpecInit(
  targetPath: string,
  toolIds: string[],
  env: NodeJS.ProcessEnv,
  projectMutationGuard?: ProjectMutationGuard,
  projectMutationAlreadyStarted = false,
  commandMayMutateProject = true,
): Promise<void> {
  const useShell = process.platform === 'win32';
  const invocation = buildOpenSpecInitInvocation(targetPath, toolIds, 'project');
  try {
    await assertProjectMutationAllowed(
      projectMutationGuard,
      'before',
      projectMutationAlreadyStarted,
    );
    const initArgs = useShell ? quoteArgsForShell(invocation.args) : invocation.args;
    execFileSync(invocation.command, initArgs, {
      cwd: targetPath,
      env,
      stdio: ['inherit', 'inherit', 'pipe'],
      timeout: 120_000,
      shell: useShell,
    });
    await assertProjectMutationAllowed(
      projectMutationGuard,
      'after-external',
      projectMutationAlreadyStarted || commandMayMutateProject,
    );
  } catch (firstError) {
    const stderrText = (firstError as { stderr?: Buffer }).stderr?.toString() ?? '';
    if (!stderrText.includes('unknown option') || !stderrText.includes('--profile')) {
      throw firstError;
    }
    await assertProjectMutationAllowed(
      projectMutationGuard,
      'after-external',
      projectMutationAlreadyStarted || commandMayMutateProject,
    );
    console.warn('    OpenSpec does not support --profile flag, retrying without it...');
    const fallbackInvocation = buildOpenSpecInitInvocation(
      targetPath,
      toolIds,
      'project',
      os.homedir(),
      false,
    );
    const fallbackArgs = useShell
      ? quoteArgsForShell(fallbackInvocation.args)
      : fallbackInvocation.args;
    await assertProjectMutationAllowed(
      projectMutationGuard,
      'before',
      projectMutationAlreadyStarted || commandMayMutateProject,
    );
    execFileSync(fallbackInvocation.command, fallbackArgs, {
      cwd: targetPath,
      env,
      stdio: 'inherit',
      timeout: 120_000,
      shell: useShell,
    });
    await assertProjectMutationAllowed(
      projectMutationGuard,
      'after-external',
      projectMutationAlreadyStarted || commandMayMutateProject,
    );
  }
}

function projectRelativePath(projectPath: string, target: string, label: string): string {
  const root = path.resolve(projectPath);
  const resolved = path.resolve(target);
  const relative = path.relative(root, resolved);
  if (
    relative === '' ||
    path.isAbsolute(relative) ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`${label} must stay inside the project root`);
  }
  return relative.split(path.sep).join('/');
}

/**
 * Whether a staged OpenSpec tool directory contains any files (recursively).
 *
 * The staging project is a private temporary directory freshly written by the
 * OpenSpec CLI, so the tree is small and bounded; walking it is cheap. This
 * distinguishes "no output at all" from "only empty directories" so a missing
 * or empty staged tool output fails the update instead of reporting success.
 */
async function hasGeneratedToolFiles(dir: string): Promise<boolean> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (await hasGeneratedToolFiles(path.join(dir, entry.name))) return true;
    } else {
      return true;
    }
  }
  return false;
}

async function copyGeneratedToolDirectory(
  stagingProject: string,
  source: string,
  projectPath: string,
  destination: string,
  projectMutationGuard?: ProjectMutationGuard,
): Promise<void> {
  const destinationRelative = projectRelativePath(
    projectPath,
    destination,
    'OpenSpec generated tool directory',
  );
  await assertProjectMutationAllowed(projectMutationGuard, 'before', true);
  await ensureProtectedProjectDirectory(projectPath, destinationRelative, {
    label: 'OpenSpec generated tool directory',
  });
  const entries = await fs.promises.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new Error(`OpenSpec generated tool source must not contain links: ${entry.name}`);
    }
    const sourceEntry = path.join(source, entry.name);
    const destinationEntry = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyGeneratedToolDirectory(
        stagingProject,
        sourceEntry,
        projectPath,
        destinationEntry,
        projectMutationGuard,
      );
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`OpenSpec generated tool source must contain only files: ${entry.name}`);
    }
    const sourceRelative = path.relative(stagingProject, sourceEntry);
    if (
      path.isAbsolute(sourceRelative) ||
      sourceRelative === '..' ||
      sourceRelative.startsWith(`..${path.sep}`)
    ) {
      throw new Error('OpenSpec generated tool source escaped its staging root');
    }
    const destinationFileRelative = projectRelativePath(
      projectPath,
      destinationEntry,
      'OpenSpec generated tool file',
    );
    await assertProjectMutationAllowed(projectMutationGuard, 'before', true);
    await inspectProtectedProjectPath(projectPath, destinationFileRelative, {
      label: 'OpenSpec generated tool file',
      expected: 'file',
    });
    const bytes = await fs.promises.readFile(sourceEntry);
    await atomicWriteContainedBytes(destinationEntry, bytes, {
      containedRoot: projectPath,
      beforeCommit: async () => {
        await assertProjectMutationAllowed(projectMutationGuard, 'before', true);
        await inspectProtectedProjectPath(projectPath, destinationFileRelative, {
          label: 'OpenSpec generated tool file',
          expected: 'file',
        });
      },
    });
  }
}

interface GeneratedToolCopy {
  source: string;
  destination: string;
}

async function resolveGeneratedToolCopies(
  stagingProject: string,
  projectPath: string,
  toolIds: readonly string[],
): Promise<GeneratedToolCopy[]> {
  const copies: GeneratedToolCopy[] = [];
  const mergedDestinations = new Set<string>();
  for (const toolId of toolIds) {
    const platform = PLATFORMS.find((candidate) => candidate.openspecToolId === toolId);
    if (!platform) continue;
    const destination = path.join(projectPath, platform.skillsDir);
    if (mergedDestinations.has(destination)) continue;
    const candidateDirs = [
      platform.openspecSkillsDir ?? platform.skillsDir,
      ...(platform.legacySkillsDirs ?? []),
    ];
    const sourceDir = candidateDirs.find((dir) => fs.existsSync(path.join(stagingProject, dir)));
    if (!sourceDir) {
      throw new Error(
        `OpenSpec generated no tool output for ${platform.id}: expected one of ${candidateDirs.join(', ')} under the staging project`,
      );
    }
    const source = path.join(stagingProject, sourceDir);
    if (!(await hasGeneratedToolFiles(source))) {
      throw new Error(
        `OpenSpec generated an empty tool output for ${platform.id}: ${sourceDir} contains no skills or commands`,
      );
    }
    copies.push({ source, destination });
    mergedDestinations.add(destination);
  }
  return copies;
}

/**
 * Validates that every requested platform produced non-empty staged tool output
 * before any project file is written. Runs after the staging `openspec init`
 * and before the artifact-root init/merge, so a missing or empty later platform
 * cannot leave partially written artifacts or Skills behind.
 */
async function preflightGeneratedToolDirectories(
  stagingProject: string,
  projectPath: string,
  toolIds: readonly string[],
): Promise<GeneratedToolCopy[]> {
  return resolveGeneratedToolCopies(stagingProject, projectPath, toolIds);
}

async function mergeGeneratedToolDirectories(
  copies: readonly GeneratedToolCopy[],
  stagingProject: string,
  projectPath: string,
  projectMutationGuard?: ProjectMutationGuard,
): Promise<void> {
  for (const copy of copies) {
    await copyGeneratedToolDirectory(
      stagingProject,
      copy.source,
      projectPath,
      copy.destination,
      projectMutationGuard,
    );
  }
}

const ALL_WORKFLOWS_CONFIG =
  JSON.stringify(
    {
      featureFlags: {},
      profile: 'custom',
      delivery: 'both',
      workflows: [...ALL_OPENSPEC_WORKFLOWS],
    },
    null,
    2,
  ) + '\n';

function getOpenSpecDefaultConfigDir(): string {
  const platform = os.platform();
  if (platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) {
      return path.join(appData, 'openspec');
    }
    return path.join(os.homedir(), 'AppData', 'Roaming', 'openspec');
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME;
  if (xdgConfig) {
    return path.join(xdgConfig, 'openspec');
  }
  return path.join(os.homedir(), '.config', 'openspec');
}

function getOpenSpecDefaultConfigPath(): string {
  return path.join(getOpenSpecDefaultConfigDir(), 'config.json');
}

function createOpenSpecAllWorkflowsEnv(): { env: NodeJS.ProcessEnv; configHome: string } {
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-openspec-profile-'));
  try {
    const openspecConfigDir = path.join(configHome, 'openspec');
    fs.mkdirSync(openspecConfigDir, { recursive: true });
    fs.writeFileSync(path.join(openspecConfigDir, 'config.json'), ALL_WORKFLOWS_CONFIG, 'utf-8');

    return {
      configHome,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: configHome,
      },
    };
  } catch (error) {
    fs.rmSync(configHome, { recursive: true, force: true });
    throw error;
  }
}

interface ConfigBackup {
  configPath: string;
  backupPath: string;
  hadExisting: boolean;
}

function writeAllWorkflowsToDefaultConfig(): ConfigBackup | null {
  const configPath = getOpenSpecDefaultConfigPath();
  const backupPath = configPath + '.owner-backup';
  let hadExisting = false;

  try {
    hadExisting = fs.existsSync(configPath);
    if (hadExisting) {
      fs.copyFileSync(configPath, backupPath);
    }

    const configDir = path.dirname(configPath);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    fs.writeFileSync(configPath, ALL_WORKFLOWS_CONFIG, 'utf-8');

    return { configPath, backupPath, hadExisting };
  } catch {
    if (hadExisting) {
      try {
        fs.unlinkSync(backupPath);
      } catch {
        // Best-effort cleanup
      }
    }
    return null;
  }
}

function restoreDefaultConfig(backup: ConfigBackup | null): void {
  if (!backup) return;
  try {
    if (backup.hadExisting) {
      fs.copyFileSync(backup.backupPath, backup.configPath);
      fs.unlinkSync(backup.backupPath);
    } else {
      if (fs.existsSync(backup.configPath)) {
        fs.unlinkSync(backup.configPath);
      }
    }
  } catch {
    // Best-effort restore
  }
}

function isCommandAvailable(command: string): boolean {
  try {
    const checker = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(checker, [command], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

interface SemanticVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

function parseSemanticVersion(value: string): SemanticVersion | null {
  const match = value.match(/(?:^|[^0-9])v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/u);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

function isOpenSpecVersionCompatible(versionOutput: string): boolean {
  const actual = parseSemanticVersion(versionOutput);
  const minimum = parseSemanticVersion(MINIMUM_OPENSPEC_VERSION);
  if (!actual || !minimum) return false;
  for (const field of ['major', 'minor', 'patch'] as const) {
    if (actual[field] > minimum[field]) return true;
    if (actual[field] < minimum[field]) return false;
  }
  return actual.prerelease === null;
}

function getOpenSpecVersion(): string | null {
  try {
    return execFileSync('openspec', ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
      shell: process.platform === 'win32',
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

export function isOpenSpecCliCompatible(): boolean {
  if (!isCommandAvailable('openspec')) return false;
  const version = getOpenSpecVersion();
  return version !== null && isOpenSpecVersionCompatible(version);
}

async function ensureOpenSpecCli(
  projectPath: string,
  shouldInstall = true,
): Promise<'ready' | 'missing' | 'incompatible' | 'failed'> {
  const alreadyInstalled = isCommandAvailable('openspec');
  if (!shouldInstall) {
    if (!alreadyInstalled) return 'missing';
    const version = getOpenSpecVersion();
    if (version && isOpenSpecVersionCompatible(version)) return 'ready';
    console.error(
      `    OpenSpec ${version || 'version unknown'} is incompatible; Owner requires >= ${MINIMUM_OPENSPEC_VERSION}. The OpenSpec upgrade was not selected; rerun owner init and select OpenSpec, or run: npm install -g @fission-ai/openspec@latest`,
    );
    return 'incompatible';
  }
  const label = alreadyInstalled ? 'Upgrading' : 'Installing';
  console.warn(`    ${label} OpenSpec CLI...`);
  try {
    // OpenSpec is invoked as a PATH command below; keep the CLI install global
    // regardless of Owner's project/global skill installation scope.
    const npmArgs = ['install', '-g', '@fission-ai/openspec@latest'];
    execFileSync(getNpmExecutable(), npmArgs, {
      cwd: os.homedir() || projectPath,
      stdio: 'inherit',
      timeout: 120_000,
      shell: process.platform === 'win32',
    });
    if (isCommandAvailable('openspec')) return 'ready';
    console.error(
      '    OpenSpec CLI installation completed, but the command is still unavailable on PATH. Restart the terminal or install manually: npm install -g @fission-ai/openspec@latest',
    );
    return 'failed';
  } catch (error) {
    if (alreadyInstalled) {
      const version = getOpenSpecVersion();
      if (version && isOpenSpecVersionCompatible(version)) {
        console.warn(
          `    OpenSpec upgrade failed, using compatible existing version ${version}: ${(error as Error).message}`,
        );
        return 'ready';
      }
      console.error(
        `    OpenSpec upgrade failed and existing ${version || 'version could not be read'} is incompatible; Owner requires >= ${MINIMUM_OPENSPEC_VERSION}.`,
      );
      printCommandErrorDetails(error);
      return 'incompatible';
    }
    console.error(`    Failed to install OpenSpec CLI: ${(error as Error).message}`);
    printCommandErrorDetails(error);
    return 'failed';
  }
}

async function installOpenSpec(
  projectPath: string,
  toolIds: string[],
  scope: InstallScope,
  shouldInstallCli = true,
  artifactLayout: 'legacy' | 'docs' = 'legacy',
  projectMutationGuard?: ProjectMutationGuard,
  failureObserver?: OpenSpecFailureObserver,
): Promise<'installed' | 'failed' | 'skipped'> {
  if (scope === 'project') {
    try {
      await assertProjectMutationAllowed(projectMutationGuard, 'before');
    } catch (error) {
      console.error(`    OpenSpec init failed: ${(error as Error).message}`);
      throw error;
    }
  }
  const cliStatus = await ensureOpenSpecCli(projectPath, shouldInstallCli);
  if (cliStatus === 'failed' || cliStatus === 'incompatible') {
    return 'failed';
  }
  if (cliStatus === 'missing') {
    return 'skipped';
  }

  const unknownIds = toolIds.filter((id) => !VALID_TOOL_IDS.has(id));
  if (unknownIds.length > 0) {
    throw new Error(`Unknown tool IDs: ${unknownIds.join(', ')}`);
  }

  let configHome: string | undefined;
  let configBackup: ConfigBackup | null = null;
  let stagingProject: string | undefined;
  let generatedToolCopies: GeneratedToolCopy[] | undefined;
  try {
    const openspecEnv = createOpenSpecAllWorkflowsEnv();
    configHome = openspecEnv.configHome;

    configBackup = writeAllWorkflowsToDefaultConfig();

    if (scope === 'project') {
      if (toolIds.length > 0) {
        stagingProject = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-openspec-tools-'));
        await runOpenSpecInit(
          stagingProject,
          toolIds,
          openspecEnv.env,
          projectMutationGuard,
          false,
          false,
        );
        generatedToolCopies = await preflightGeneratedToolDirectories(
          stagingProject,
          projectPath,
          toolIds,
        );
      }
      await assertProjectMutationAllowed(projectMutationGuard, 'before');
      const artifactBase = artifactLayout === 'docs' ? path.join(projectPath, 'docs') : projectPath;
      let artifactMutationGuard = projectMutationGuard;
      if (artifactLayout === 'docs') {
        await ensureProtectedProjectDirectory(projectPath, 'docs', {
          label: 'OpenSpec docs artifact base',
        });
        artifactMutationGuard = async () => {
          await projectMutationGuard?.();
          await inspectProtectedProjectPath(projectPath, 'docs', {
            label: 'OpenSpec docs artifact base',
            expected: 'directory',
          });
        };
      }
      await runOpenSpecInit(artifactBase, ['none'], openspecEnv.env, artifactMutationGuard, true);
      if (stagingProject && generatedToolCopies) {
        await assertProjectMutationAllowed(projectMutationGuard, 'before', true);
        await mergeGeneratedToolDirectories(
          generatedToolCopies,
          stagingProject,
          projectPath,
          projectMutationGuard,
        );
      }
      await assertProjectMutationAllowed(projectMutationGuard, 'after-external', true);
    } else {
      await runOpenSpecInit(os.homedir(), toolIds, openspecEnv.env);
    }

    return 'installed';
  } catch (error) {
    failureObserver?.(error as Error);
    console.error(`    OpenSpec init failed: ${(error as Error).message}`);
    printCommandErrorDetails(error);
    if (error instanceof ProjectMutationGuardError) {
      throw error;
    }
    return 'failed';
  } finally {
    restoreDefaultConfig(configBackup);
    if (configHome) {
      fs.rmSync(configHome, { recursive: true, force: true });
    }
    if (stagingProject) {
      fs.rmSync(stagingProject, { recursive: true, force: true });
    }
  }
}

export {
  MINIMUM_OPENSPEC_VERSION,
  installOpenSpec,
  isCommandAvailable,
  isOpenSpecVersionCompatible,
  getOpenSpecVersion,
  buildOpenSpecInitInvocation,
  getNpmExecutable,
  isProjectMutationGuardError,
};
export type { ProjectMutationGuard };
