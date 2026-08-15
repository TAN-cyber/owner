#!/usr/bin/env node

import { execFileSync } from 'child_process';

const npmCommand = process.env.npm_command ?? process.env.NPM_COMMAND;

if (npmCommand === 'publish') {
  console.log('[PREPARE] skipped during npm publish; prepublishOnly already runs build.');
  process.exit(0);
}

execFileSync('husky', { stdio: 'inherit', shell: true });
execFileSync(process.execPath, ['build.js'], { stdio: 'inherit' });
