import { loopInitCommand } from './loop-init-command.js';
import { runLoopScript } from './loop-script-entry.js';

process.exitCode = await runLoopScript('init', loopInitCommand);
