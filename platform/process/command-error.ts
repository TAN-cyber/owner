const ESC = String.fromCharCode(27);
const ANSI_ESCAPE_PATTERN = new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, 'g');
const LOOSE_ESCAPE_PATTERN = new RegExp(`${ESC}\\[[^a-zA-Z\\r\\n]*`, 'g');

type CommandError = Error & {
  stderr?: Buffer | string;
  stdout?: Buffer | string;
  code?: string;
  killed?: boolean;
};

function streamToText(stream: Buffer | string | undefined): string {
  if (!stream) return '';
  return Buffer.isBuffer(stream) ? stream.toString() : stream;
}

function cleanCommandOutput(output: string): string {
  return output
    .replace(ANSI_ESCAPE_PATTERN, '')
    .replace(LOOSE_ESCAPE_PATTERN, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !/^(│|├|╮|╯|●|◇|◒|◐|◓|◑|■)/.test(line.trim()))
    .join('\n')
    .trim();
}

function formatCommandErrorDetails(error: unknown): string[] {
  const details: string[] = [];
  if (!error || typeof error !== 'object') {
    details.push('Unknown error occurred');
    return details;
  }

  const commandError = error as CommandError;

  for (const [label, stream] of [
    ['stderr', commandError.stderr],
    ['stdout', commandError.stdout],
  ] as const) {
    const cleaned = cleanCommandOutput(streamToText(stream));
    if (cleaned) {
      details.push(`${label}:\n${cleaned}`);
    }
  }

  if (details.length === 0) {
    const reason = commandError.killed
      ? 'Process was killed (likely timed out)'
      : commandError.code === 'ETIMEDOUT'
        ? 'Process timed out'
        : commandError.code === 'ENOENT'
          ? 'Command not found — check that the required CLI is installed and on PATH'
          : 'No error output captured';
    details.push(reason);
  }

  return details;
}

function printCommandErrorDetails(error: unknown, indent = '    '): void {
  for (const detail of formatCommandErrorDetails(error)) {
    console.error(`${indent}${detail.split('\n').join(`\n${indent}`)}`);
  }
}

export { printCommandErrorDetails, formatCommandErrorDetails };
