import type { InstallScope } from './types.js';

export const SUPPORTED_PLATFORM_IDS = ['claude', 'codex'] as const;
export type SupportedPlatformId = (typeof SUPPORTED_PLATFORM_IDS)[number];

export interface Platform {
  id: SupportedPlatformId;
  name: string;
  skillsDir: string;
  globalSkillsDir: string;
  legacySkillsDirs?: string[];
  configDir?: string;
  detectionPaths?: string[];
  openspecToolId: SupportedPlatformId;
  openspecSkillsDir?: string;
  rulesBaseDir?: string;
  rulesDir: 'rules';
  rulesFormat: 'md';
  supportsHooks: true;
  hookFormat: 'claude-code';
  hookConfigFile?: string;
  legacyHookConfigFiles?: string[];
}

const PLATFORM_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function isValidPlatformId(platformId: string): boolean {
  return PLATFORM_ID_PATTERN.test(platformId);
}

export function getPlatformSkillsDir(platform: Platform, scope: InstallScope): string {
  return scope === 'global' ? platform.globalSkillsDir : platform.skillsDir;
}

export function getPlatformSkillsDirs(platform: Platform, scope: InstallScope): string[] {
  return [
    ...new Set([getPlatformSkillsDir(platform, scope), ...(platform.legacySkillsDirs ?? [])]),
  ];
}

export function getPlatformConfigDir(platform: Platform, scope: InstallScope): string {
  return platform.configDir ?? getPlatformSkillsDir(platform, scope);
}

export const SUPPORTED_PLATFORMS: Platform[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    skillsDir: '.claude',
    globalSkillsDir: '.claude',
    openspecToolId: 'claude',
    rulesDir: 'rules',
    rulesFormat: 'md',
    supportsHooks: true,
    hookFormat: 'claude-code',
  },
  {
    id: 'codex',
    name: 'Codex',
    skillsDir: '.agents',
    globalSkillsDir: '.agents',
    legacySkillsDirs: ['.codex'],
    configDir: '.codex',
    detectionPaths: ['.codex'],
    openspecToolId: 'codex',
    openspecSkillsDir: '.agents',
    rulesBaseDir: '.codex',
    rulesDir: 'rules',
    rulesFormat: 'md',
    supportsHooks: true,
    hookFormat: 'claude-code',
    hookConfigFile: 'hooks.json',
    legacyHookConfigFiles: ['settings.local.json'],
  },
];

export const PLATFORMS = SUPPORTED_PLATFORMS;

export function isSupportedPlatformId(platformId: string): platformId is SupportedPlatformId {
  return SUPPORTED_PLATFORM_IDS.some((id) => id === platformId);
}
