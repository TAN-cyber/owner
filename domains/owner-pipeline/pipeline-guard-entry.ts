import { pipelineGuardCommand } from './pipeline-guard.js';
import { runPipelineScript } from './pipeline-script-entry.js';

process.exitCode = await runPipelineScript('guard', pipelineGuardCommand);
