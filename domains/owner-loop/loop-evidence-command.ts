import path from 'path';

import { serializeLoopVerificationMachineBlock } from './loop-acceptance.js';
import { MAX_LOOP_IMPLEMENTATION_EVIDENCE_DOCUMENT_BYTES } from './loop-verification-scope.js';
import {
  assertNoArguments,
  LoopUsageError,
  readBoundedEvidenceFile,
  readBoundedEvidenceStdin,
  requiredPositional,
  success,
  takeOption,
  type DispatchResult,
} from './loop-cli-shared.js';

export async function loopEvidenceCommand(
  args: string[],
  _projectRoot: string,
): Promise<DispatchResult> {
  const subcommand = requiredPositional(args, 'evidence subcommand');
  if (subcommand === 'format') {
    const entriesPath = takeOption(args, '--entries');
    assertNoArguments(args);
    let raw: string;
    if (entriesPath) {
      raw = await readBoundedEvidenceFile(
        path.resolve(entriesPath),
        MAX_LOOP_IMPLEMENTATION_EVIDENCE_DOCUMENT_BYTES,
      );
    } else {
      if (process.stdin.isTTY) {
        throw new LoopUsageError(
          'evidence format requires acceptance evidence entries JSON on stdin, or --entries <path>',
        );
      }
      raw = await readBoundedEvidenceStdin(MAX_LOOP_IMPLEMENTATION_EVIDENCE_DOCUMENT_BYTES);
    }
    let entries: unknown;
    try {
      entries = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `Acceptance evidence entries must be valid JSON: ${(error as Error).message}`,
        { cause: error },
      );
    }
    if (!Array.isArray(entries)) {
      throw new Error('Acceptance evidence entries must be a JSON array');
    }
    const block = serializeLoopVerificationMachineBlock(entries);
    return success('evidence format', { block }, `${block}\n`);
  }
  throw new LoopUsageError(`Unknown evidence command: ${subcommand}`);
}
