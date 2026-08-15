import path from 'path';
import os from 'os';

import { fileExists, readDir } from '../fs/file-system.js';
import { SUPPORTED_PLATFORMS, getPlatformSkillsDirs, type Platform } from './platforms.js';

import type { InstallScope } from './types.js';

const SUPERPOWERS_SKILLS = [
  'brainstorming',
  'using-superpowers',
  'writing-plans',
  'test-driven-development',
  'subagent-driven-development',
];

async function hasSuperpowersInPluginCache(pluginsCacheDir: string): Promise<boolean> {
  const marketplaceEntries = await readDir(pluginsCacheDir);
  for (const marketplace of marketplaceEntries) {
    const superpowersDir = path.join(pluginsCacheDir, marketplace, 'superpowers');
    if (!(await fileExists(superpowersDir))) continue;

    const versionEntries = await readDir(superpowersDir);
    for (const version of versionEntries) {
      const skillsDir = path.join(superpowersDir, version, 'skills');
      const skills = await readDir(skillsDir);
      if (SUPERPOWERS_SKILLS.some((name) => skills.includes(name))) {
        return true;
      }
    }
  }

  return false;
}

function getBaseDir(scope: InstallScope, projectPath: string): string {
  return scope === 'global' ? os.homedir() : projectPath;
}

/**
 * Check if superpowers are installed via Claude Code plugin system.
 * Looks in ~/.claude/plugins/cache/{marketplace}/superpowers/{version}/skills/
 */
async function hasPluginSuperpowers(): Promise<boolean> {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const pluginsCacheDir = path.join(claudeDir, 'plugins', 'cache');

  return hasSuperpowersInPluginCache(pluginsCacheDir);
}

/**
 * Check if superpowers are installed via Codex plugin system.
 * Looks in ~/.codex/plugins/cache/{marketplace}/superpowers/{version}/skills/
 */
async function hasCodexPluginSuperpowers(): Promise<boolean> {
  const codexDir =
    process.env.CODEX_HOME || process.env.CODEX_CONFIG_DIR || path.join(os.homedir(), '.codex');
  const pluginsCacheDir = path.join(codexDir, 'plugins', 'cache');

  return hasSuperpowersInPluginCache(pluginsCacheDir);
}

async function hasPlatformDetectionPath(baseDir: string, platform: Platform): Promise<boolean> {
  if (!platform.detectionPaths || platform.detectionPaths.length === 0) return true;
  for (const detectionPath of platform.detectionPaths) {
    if (await fileExists(path.join(baseDir, detectionPath))) return true;
  }
  return false;
}

async function detectPlatforms(projectPath: string): Promise<Set<string>> {
  const detected = new Set<string>();

  for (const platform of SUPPORTED_PLATFORMS) {
    if (platform.detectionPaths && platform.detectionPaths.length > 0) {
      for (const p of platform.detectionPaths) {
        if (await fileExists(path.join(projectPath, p))) {
          detected.add(platform.id);
          break;
        }
      }
    } else {
      for (const skillsDir of getPlatformSkillsDirs(platform, 'project')) {
        const dirPath = path.join(projectPath, skillsDir);
        if (await fileExists(dirPath)) {
          detected.add(platform.id);
          break;
        }
      }
    }
  }

  return detected;
}

async function hasSkills(
  baseDir: string,
  platform: Platform,
  component: 'openspec' | 'superpowers' | 'owner',
  _selectedPlatforms: Platform[] = [],
  scope: InstallScope = 'project',
  options: { includeGlobalFallback?: boolean; includePluginFallback?: boolean } = {},
): Promise<boolean> {
  const skillDirEntries = await Promise.all(
    getPlatformSkillsDirs(platform, scope).map(async (skillsDir) => {
      const fullPath = path.join(baseDir, skillsDir, 'skills');
      return {
        skillsDir,
        entries: (await fileExists(fullPath)) ? await readDir(fullPath) : [],
      };
    }),
  );
  const entries = skillDirEntries.flatMap((dir) => dir.entries);

  switch (component) {
    case 'openspec':
      if (entries.some((e) => e.startsWith('openspec-'))) return true;
      break;
    case 'superpowers':
      if (SUPERPOWERS_SKILLS.some((name) => entries.includes(name))) return true;
      break;
    case 'owner':
      if (entries.some((e) => e.startsWith('owner'))) return true;
      break;
  }

  if (scope === 'project' && options.includeGlobalFallback === false) {
    return false;
  }

  if (scope === 'project' && baseDir !== os.homedir()) {
    const globalSkillDirEntries = await Promise.all(
      getPlatformSkillsDirs(platform, 'global').map(async (skillsDir) => {
        const fullPath = path.join(os.homedir(), skillsDir, 'skills');
        return {
          skillsDir,
          entries: (await fileExists(fullPath)) ? await readDir(fullPath) : [],
        };
      }),
    );
    const globalEntries = globalSkillDirEntries.flatMap((dir) => dir.entries);

    switch (component) {
      case 'openspec':
        if (globalEntries.some((e) => e.startsWith('openspec-'))) return true;
        break;
      case 'superpowers':
        if (SUPERPOWERS_SKILLS.some((name) => globalEntries.includes(name))) return true;
        break;
      case 'owner':
        if (globalEntries.some((e) => e.startsWith('owner'))) return true;
        break;
    }
  }

  if (options.includePluginFallback === false) return false;

  // Check Claude Code plugin cache for plugin-installed superpowers
  if (component === 'superpowers' && platform.id === 'claude') {
    if (await hasPluginSuperpowers()) return true;
  }

  // Check Codex plugin cache for plugin-installed superpowers
  if (component === 'superpowers' && platform.id === 'codex') {
    if (await hasCodexPluginSuperpowers()) return true;
  }

  return false;
}

export {
  detectPlatforms,
  hasPlatformDetectionPath,
  hasSkills,
  hasPluginSuperpowers,
  hasCodexPluginSuperpowers,
  getBaseDir,
};
export type { InstallScope };
