import { loopNextCommand } from './loop-next-command.js';
import { runLoopScript } from './loop-script-entry.js';

process.exitCode = await runLoopScript('next', loopNextCommand);
