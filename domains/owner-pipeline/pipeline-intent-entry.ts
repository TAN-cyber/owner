import { pipelineIntentCommand } from './pipeline-intent-command.js';
import { runPipelineScript } from './pipeline-script-entry.js';

process.exitCode = await runPipelineScript('intent', pipelineIntentCommand);
