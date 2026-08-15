import { loopShowCommand } from './loop-show-command.js';
import { runLoopScript } from './loop-script-entry.js';

process.exitCode = await runLoopScript('show', loopShowCommand);
