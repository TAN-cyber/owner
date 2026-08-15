import { execFileSync } from 'child_process';

import { printCommandErrorDetails } from '../../platform/process/command-error.js';
import type { SupportedPlatformId } from '../../platform/install/platforms.js';
import type { InstallScope } from '../../platform/install/types.js';

const SKILLS_AGENT_MAP: Record<SupportedPlatformId, string> = {
  claude: 'claude-code',
  codex: 'codex',
};

const VALID_PLATFORM_IDS = new Set(Object.keys(SKILLS_AGENT_MAP));
const SUPERPOWERS_INSTALL_TIMEOUT_MS = 300_000;

function buildSuperpowersInstallCommand(
  _projectPath: string,
  scope: InstallScope,
  platformIds: string[],
): { command: string; args: string[] } {
  const unknownIds = platformIds.filter((id) => !VALID_PLATFORM_IDS.has(id));
  if (unknownIds.length > 0) {
    throw new Error(`Unknown platform IDs: ${unknownIds.join(', ')}`);
  }

  const agentNames = [
    ...new Set(platformIds.map((id) => SKILLS_AGENT_MAP[id as SupportedPlatformId])),
  ];

  const args = ['skills', 'add', 'obra/superpowers', '-y'];
  if (scope === 'global') {
    args.push('-g');
  }
  for (const name of agentNames) {
    args.push('--agent', name);
  }
  return { command: getNpxExecutable(), args };
}

function getNpxExecutable(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'npx.cmd' : 'npx';
}

async function installSuperpowersForPlatforms(
  projectPath: string,
  scope: InstallScope,
  platformIds: string[],
  shouldInstall = true,
): Promise<'installed' | 'failed' | 'skipped'> {
  if (!shouldInstall) {
    return 'skipped';
  }

  const unknownIds = platformIds.filter((id) => !VALID_PLATFORM_IDS.has(id));
  if (unknownIds.length > 0) {
    throw new Error(`Unknown platform IDs: ${unknownIds.join(', ')}`);
  }

  const command = buildSuperpowersInstallCommand(projectPath, scope, platformIds);
  try {
    execFileSync(command.command, command.args, {
      cwd: projectPath,
      stdio: 'inherit',
      timeout: SUPERPOWERS_INSTALL_TIMEOUT_MS,
      shell: process.platform === 'win32',
    });
    return 'installed';
  } catch (error) {
    console.error(`    Superpowers install failed: ${(error as Error).message}`);
    printCommandErrorDetails(error);
    return 'failed';
  }
}

export { installSuperpowersForPlatforms, buildSuperpowersInstallCommand, SKILLS_AGENT_MAP };
