import { loopHookGuardCommand } from './loop-hook-guard-command.js';
import { runLoopScript } from './loop-script-entry.js';

process.exitCode = await runLoopScript('hook-guard', loopHookGuardCommand);
