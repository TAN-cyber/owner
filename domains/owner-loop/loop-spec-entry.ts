import { loopSpecCommand } from './loop-spec-command.js';
import { runLoopScript } from './loop-script-entry.js';

process.exitCode = await runLoopScript('spec', loopSpecCommand);
