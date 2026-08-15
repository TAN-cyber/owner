import path from 'path';

import type { LoopProjectPaths } from './loop-types.js';

export const LOOP_EXCLUDED_DIRECTORY_NAMES = new Set([
  '.cache',
  '.git',
  '.gradle',
  '.gnupg',
  '.mypy_cache',
  '.next',
  '.npm',
  '.pnpm-store',
  '.pytest_cache',
  '.ssh',
  '.turbo',
  '.venv',
  '.yarn',
  '__pycache__',
  'node_modules',
  'venv',
]);

const LOOP_SENSITIVE_FILE_NAMES = new Set([
  '.git-credentials',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'auth.json',
  'credentials.json',
]);

export function isLoopEnvFileName(name: string): boolean {
  return name.toLowerCase().startsWith('.env');
}

/** Returns a stable exclusion reason for project-relative sensitive paths. */
export function loopSensitiveRelativePathReason(relativeRef: string): string | null {
  const segments = relativeRef.replaceAll('\\', '/').split('/').filter(Boolean);
  const lower = segments.map((segment) => segment.toLowerCase());
  if (lower.some((segment) => isLoopEnvFileName(segment))) return 'environment-file';
  if (lower.some((segment) => LOOP_SENSITIVE_FILE_NAMES.has(segment))) {
    return 'credential-config';
  }
  if (lower.includes('.git')) return 'git-metadata';
  if (lower.some((segment) => LOOP_EXCLUDED_DIRECTORY_NAMES.has(segment))) {
    return 'dependency-or-cache';
  }
  if (lower.join('/') === '.owner/config.yaml') {
    return 'owner-config';
  }
  if (lower.join('/') === '.owner/current-change.json') {
    return 'owner-selection';
  }
  return null;
}

export function loopSensitiveArtifactReason(
  paths: LoopProjectPaths,
  relativeRef: string,
): string | null {
  const generic = loopSensitiveRelativePathReason(relativeRef);
  if (generic) return generic;
  const target = path.resolve(paths.projectRoot, ...relativeRef.split('/'));
  const relativeLoopRoot = path.relative(paths.projectRoot, paths.loopRoot).replaceAll('\\', '/');
  const normalized = relativeRef.replaceAll('\\', '/');
  if (
    normalized === relativeLoopRoot ||
    normalized.startsWith(`${relativeLoopRoot}/`) ||
    target === path.resolve(paths.configFile)
  ) {
    return 'loop-runtime';
  }
  return null;
}
