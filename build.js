#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { existsSync, rmSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const runTsc = (args = []) => {
  const tscPath = require.resolve('typescript/bin/tsc');
  execFileSync(process.execPath, [tscPath, ...args], { stdio: 'inherit' });
};

const buildClassicRuntime = () => {
  execFileSync(process.execPath, ['scripts/build/build-classic-runtime.mjs'], {
    stdio: 'inherit',
  });
};

const buildNativeRuntime = () => {
  execFileSync(process.execPath, ['scripts/build/build-native-runtime.mjs'], {
    stdio: 'inherit',
  });
};

const buildEntryRuntime = () => {
  execFileSync(process.execPath, ['scripts/build/build-entry-runtime.mjs'], {
    stdio: 'inherit',
  });
};

console.log('Building Owner...\n');

if (existsSync('dist')) {
  console.log('Cleaning dist directory...');
  rmSync('dist', { recursive: true, force: true });
}

console.log('Building Classic runtime...');
try {
  buildClassicRuntime();
  console.log('Building Native runtime...');
  buildNativeRuntime();
  console.log('Building entry resolver runtime...');
  buildEntryRuntime();
  console.log('Compiling TypeScript...');
  runTsc(['--version']);
  runTsc();

  console.log('\nBuild completed successfully!');
} catch (error) {
  console.error('\nBuild failed!');
  process.exit(1);
}
