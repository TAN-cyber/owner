import { loopNewCommand } from './loop-new-command.js';
import { runLoopScript } from './loop-script-entry.js';

process.exitCode = await runLoopScript('new', loopNewCommand);
