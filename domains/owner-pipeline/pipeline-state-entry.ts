import { pipelineStateCommand } from './pipeline-state-command.js';
import { runPipelineScript } from './pipeline-script-entry.js';

process.exitCode = await runPipelineScript('state', pipelineStateCommand);
