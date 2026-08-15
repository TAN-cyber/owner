import path from 'path';

import type { Platform } from '../../platform/install/platforms.js';
import type { InstallScope } from '../../platform/install/types.js';
import type { InitWorkflowSelection } from '../owner-entry/types.js';
import { installOwnerHooksForPlatform, type HookInstallResult } from './platform-install.js';
import { removeOwnerHooksForPlatform } from './uninstall.js';

export async function reconcileOwnerHooksForPlatform(
  baseDir: string,
  platform: Platform,
  scope: InstallScope = 'project',
  workflowSelection: InitWorkflowSelection = 'classic',
): Promise<HookInstallResult> {
  if (scope === 'project') {
    return installOwnerHooksForPlatform(baseDir, platform, scope, workflowSelection);
  }

  if (!platform.supportsHooks) {
    return { status: 'skipped', reason: 'platform does not support hooks' };
  }
  if (!platform.hookFormat) {
    return {
      status: 'failed',
      reason: 'hook-capable platform does not declare a hook format',
    };
  }

  const cleanup = await removeOwnerHooksForPlatform(baseDir, platform, scope);
  if (cleanup.failed > 0) {
    return {
      status: 'failed',
      reason: `failed to remove ${cleanup.failed} legacy global Hook configuration(s)`,
      cleanupFailed: cleanup.failed,
    };
  }
  return {
    status: 'skipped',
    reason:
      cleanup.removed > 0
        ? `blocking Hooks are project-scoped; removed ${cleanup.removed} legacy global Hook${cleanup.removed === 1 ? '' : 's'}`
        : 'blocking Hooks are project-scoped',
  };
}

export async function reconcileProjectOwnerHooksForPlatform(
  projectRoot: string,
  platform: Platform,
  workflowSelection: InitWorkflowSelection,
  options: { globalBaseDir: string },
): Promise<HookInstallResult> {
  const project = await installOwnerHooksForPlatform(
    projectRoot,
    platform,
    'project',
    workflowSelection,
  );
  if (project.status !== 'installed') return project;
  if (path.resolve(projectRoot) === path.resolve(options.globalBaseDir)) return project;

  const globalCleanup = await removeOwnerHooksForPlatform(
    options.globalBaseDir,
    platform,
    'global',
  );
  if (globalCleanup.failed > 0) {
    return {
      status: 'failed',
      cleanupFailed: globalCleanup.failed,
      reason: `project Router installed, but failed to remove ${globalCleanup.failed} historical global Hook configuration(s)`,
    };
  }
  return project;
}
