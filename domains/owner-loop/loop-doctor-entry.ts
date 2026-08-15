import { loopDoctorCommand } from './loop-doctor-command.js';
import { runLoopScript } from './loop-script-entry.js';

process.exitCode = await runLoopScript('doctor', loopDoctorCommand);
