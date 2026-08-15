import type { PipelineCommandHandler, PipelineCommandResult } from './pipeline-cli.js';
import {
  OWNER_RESUME_PROBE_SCHEMA_VERSION,
  resolveOwnerResumeProbe,
} from './pipeline-resume-probe.js';
import {
  pipelineCommandProjectRoot,
  withPipelineCommandContext,
} from './pipeline-command-context.js';

function result(exitCode: number, stdout?: string, stderr?: string): PipelineCommandResult {
  return {
    exitCode,
    ...(stdout === undefined ? {} : { stdout }),
    ...(stderr === undefined ? {} : { stderr }),
  };
}

function usage(): PipelineCommandResult {
  return result(
    64,
    undefined,
    'Usage: owner-resume-probe.mjs probe <input-json>\nUsage: owner-resume-probe.mjs probe --stdin',
  );
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function rawUtteranceInput(utterance: string) {
  return {
    schema_version: OWNER_RESUME_PROBE_SCHEMA_VERSION,
    utterance,
    locale: 'unknown',
    agent_context: {
      non_trivial_work: true,
      already_in_owner_flow: false,
    },
  };
}

function parseStdinInput(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    return rawUtteranceInput(source);
  }
}

export const pipelineResumeProbeCommand: PipelineCommandHandler = async (args, options) =>
  withPipelineCommandContext(options, async () => {
    const [subcommand, input] = args;
    if (subcommand !== 'probe') return usage();

    const fromStdin = input === '--stdin';
    const source = fromStdin ? await readStdin() : input;
    if (!source) return usage();

    try {
      const parsedInput = fromStdin ? parseStdinInput(source) : JSON.parse(source);
      const resolution = await resolveOwnerResumeProbe(pipelineCommandProjectRoot(), parsedInput);
      return result(0, `${JSON.stringify(resolution, null, 2)}\n`);
    } catch (error) {
      if (error instanceof SyntaxError) {
        return result(1, undefined, `Invalid JSON: ${error.message}`);
      }
      return result(1, undefined, error instanceof Error ? error.message : String(error));
    }
  });
