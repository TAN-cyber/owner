import { loopRootCommand } from './loop-root-command.js';
import { runLoopScript } from './loop-script-entry.js';

process.exitCode = await runLoopScript('root', loopRootCommand);
