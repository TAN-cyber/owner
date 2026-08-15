import { pipelineHookGuardCommand } from './pipeline-hook-guard.js';
import { runPipelineScript } from './pipeline-script-entry.js';

process.exitCode = await runPipelineScript('hook-guard', pipelineHookGuardCommand);
