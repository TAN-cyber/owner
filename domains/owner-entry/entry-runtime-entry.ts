import { runOwnerEntryRuntime } from './entry-runtime.js';

process.exitCode = await runOwnerEntryRuntime(process.argv.slice(2));
