import { pipelineArchiveCommand } from './pipeline-archive.js';
import { runPipelineScript } from './pipeline-script-entry.js';

process.exitCode = await runPipelineScript('archive', pipelineArchiveCommand);
