import { loopArchiveCommand } from './loop-archive-command.js';
import { runLoopScript } from './loop-script-entry.js';

process.exitCode = await runLoopScript('archive', loopArchiveCommand);
