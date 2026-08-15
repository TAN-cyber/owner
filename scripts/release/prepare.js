#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
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

if (globalInstall || !existsSync(huskyCommand)) {
  console.log(
    `[PREPARE] skipped Husky setup (${globalInstall ? 'global install' : 'Husky is unavailable'}).`,
  );
} else {
  execFileSync(huskyCommand, { stdio: 'inherit', shell: true });
}

execFileSync(process.execPath, ['build.js'], { stdio: 'inherit' });
