import { loopStatusCommand } from './loop-status-command.js';
import { runLoopScript } from './loop-script-entry.js';

process.exitCode = await runLoopScript('status', loopStatusCommand);
