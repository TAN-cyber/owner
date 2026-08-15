import { pipelineValidateCommand } from './pipeline-validate-command.js';
import { runPipelineScript } from './pipeline-script-entry.js';

process.exitCode = await runPipelineScript('validate', pipelineValidateCommand);
