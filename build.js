#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { existsSync, rmSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const runTsc = (args = []) => {
  const tscPath = require.resolve('typescript/bin/tsc');
  execFileSync(process.execPath, [tscPath, ...args], { stdio: 'inherit' });
};

const buildPipelineRuntime = () => {
  execFileSync(process.execPath, ['scripts/build/build-pipeline-runtime.mjs'], {
    stdio: 'inherit',
  });
};

const buildLoopRuntime = () => {
  execFileSync(process.execPath, ['scripts/build/build-loop-runtime.mjs'], {
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

console.log('Building Pipeline runtime...');
try {
  buildPipelineRuntime();
  console.log('Building Loop runtime...');
  buildLoopRuntime();
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
