import { pipelineHandoffCommand } from './pipeline-handoff.js';
import { runPipelineScript } from './pipeline-script-entry.js';

process.exitCode = await runPipelineScript('handoff', pipelineHandoffCommand);
