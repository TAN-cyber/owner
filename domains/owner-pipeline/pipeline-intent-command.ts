import type { PipelineCommandHandler, PipelineCommandResult } from './pipeline-cli.js';
import { OwnerIntentValidationError, resolveOwnerIntentRoute } from './pipeline-intent.js';

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
    'Usage: owner-intent.mjs route <frame-json>\nUsage: owner-intent.mjs route --stdin',
  );
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export const pipelineIntentCommand: PipelineCommandHandler = async (args, _options) => {
  const [subcommand, input] = args;
  if (subcommand !== 'route') return usage();

  const source = input === '--stdin' ? await readStdin() : input;
  if (!source) return usage();

  try {
    const resolution = resolveOwnerIntentRoute(JSON.parse(source));
    return result(0, `${JSON.stringify(resolution, null, 2)}\n`);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return result(1, undefined, `Invalid JSON: ${error.message}`);
    }
    if (error instanceof OwnerIntentValidationError) {
      return result(1, undefined, error.message);
    }
    throw error;
  }
};
