#!/usr/bin/env node
// Owner script locator — prints the absolute path to this scripts directory.
//
// Usage:
//   OWNER_SCRIPTS_DIR="$(node /path/to/owner-env.mjs)"
//
// The skill boilerplate runs this once to resolve the sibling command scripts
// (owner-state.mjs, owner-guard.mjs, ...) without depending on bash.
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Use forward slashes so the path is safe to interpolate into any shell and
// is accepted verbatim by Node on every platform (Windows included).
const scriptDir = dirname(fileURLToPath(import.meta.url)).replace(/\\/gu, '/');
process.stdout.write(`${scriptDir}\n`);
