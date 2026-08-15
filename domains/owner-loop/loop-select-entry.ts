import { loopSelectCommand } from './loop-select-command.js';
import { runLoopScript } from './loop-script-entry.js';

process.exitCode = await runLoopScript('select', loopSelectCommand);
