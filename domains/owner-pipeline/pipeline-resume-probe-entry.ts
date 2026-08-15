import { pipelineResumeProbeCommand } from './pipeline-resume-probe-command.js';
import { runPipelineScript } from './pipeline-script-entry.js';

process.exitCode = await runPipelineScript('resume-probe', pipelineResumeProbeCommand);
