#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';

const npmCommand = process.env.npm_command ?? process.env.NPM_COMMAND;

if (npmCommand === 'publish') {
  console.log('[PREPARE] skipped during npm publish; prepublishOnly already runs build.');
  process.exit(0);
}

const huskyCommand = path.resolve(
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'husky.cmd' : 'husky',
);
const globalInstall = ['true', '1'].includes(
  (process.env.npm_config_global ?? process.env.NPM_CONFIG_GLOBAL ?? '').toLowerCase(),
);

const require = createRequire(import.meta.url);
const buildDependencies = [
  'esbuild/package.json',
  'typescript/package.json',
  '@types/node/package.json',
];

function hasBuildDependencies() {
  return buildDependencies.every((dependency) => {
    try {
      require.resolve(dependency);
      return true;
    } catch {
      return false;
    }
  });
}

function installBuildDependencies() {
  if (hasBuildDependencies()) return;

  console.log('[PREPARE] build dependencies are unavailable; installing them before the build.');
  const npmArgs = [
    'install',
    '--ignore-scripts',
    '--include=dev',
    '--no-save',
    '--no-audit',
    '--no-fund',
  ];
  const npmExecPath = process.env.npm_execpath ?? process.env.NPM_EXECPATH;
  const env = {
    ...process.env,
    npm_config_global: 'false',
    NPM_CONFIG_GLOBAL: 'false',
  };

  if (npmExecPath) {
    execFileSync(process.execPath, [npmExecPath, ...npmArgs], { stdio: 'inherit', env });
  } else {
    execFileSync('npm', npmArgs, { stdio: 'inherit', env });
  }
}

if (globalInstall || !existsSync(huskyCommand)) {
  console.log(
    `[PREPARE] skipped Husky setup (${globalInstall ? 'global install' : 'Husky is unavailable'}).`,
  );
} else {
  execFileSync(huskyCommand, { stdio: 'inherit', shell: true });
}

installBuildDependencies();
execFileSync(process.execPath, ['build.js'], { stdio: 'inherit' });
