import { DEFAULT_LOOP_ARTIFACT_MAX_BYTES, readLoopBoundedTextFile } from './loop-bounded-file.js';
import {
  buildLoopContractSnapshot,
  type LoopContractSnapshot,
  type LoopContractSpecInput,
} from './loop-contract.js';
import type { LoopSpecChange } from './loop-types.js';

export const LOOP_CONTRACT_FILE_LIMITS = {
  maxSpecs: 64,
  maxFileBytes: DEFAULT_LOOP_ARTIFACT_MAX_BYTES,
  maxTotalBytes: 4 * 1024 * 1024,
} as const;

export interface LoopCollectedContract {
  contract: LoopContractSnapshot;
  sourceCount: number;
  totalBytes: number;
}

/**
 * Read the bounded change artifacts that form the user-visible contract.
 *
 * The collector returns hashes and derived acceptance only; source contents do not escape this
 * seam. Canonical specs are represented by the frozen base hashes already in each spec change.
 */
export async function collectLoopContractFiles(options: {
  changeDir: string;
  briefRef: string;
  specChanges: readonly LoopSpecChange[];
}): Promise<LoopCollectedContract> {
  if (options.specChanges.length > LOOP_CONTRACT_FILE_LIMITS.maxSpecs) {
    throw new Error('Loop contract exceeds its spec-count budget');
  }
  const brief = await readLoopBoundedTextFile({
    root: options.changeDir,
    ref: options.briefRef,
    maxBytes: LOOP_CONTRACT_FILE_LIMITS.maxFileBytes,
  });
  let totalBytes = brief.size;
  const specs: LoopContractSpecInput[] = [];
  for (const change of options.specChanges) {
    if (change.operation === 'remove') {
      specs.push({
        capability: change.capability,
        operation: 'remove',
        source: null,
        baseHash: change.base_hash,
        markdown: null,
      });
      continue;
    }
    if (!change.source) {
      throw new Error(`Loop contract ${change.capability} has no proposed spec source`);
    }
    const source = await readLoopBoundedTextFile({
      root: options.changeDir,
      ref: change.source,
      maxBytes: LOOP_CONTRACT_FILE_LIMITS.maxFileBytes,
    });
    totalBytes += source.size;
    if (totalBytes > LOOP_CONTRACT_FILE_LIMITS.maxTotalBytes) {
      throw new Error('Loop contract exceeds its total byte budget');
    }
    specs.push({
      capability: change.capability,
      operation: change.operation,
      source: source.ref,
      baseHash: change.base_hash,
      markdown: source.text,
    });
  }
  return {
    contract: buildLoopContractSnapshot({
      briefSource: brief.ref,
      briefMarkdown: brief.text,
      specs,
    }),
    sourceCount: specs.filter((spec) => spec.source !== null).length + 1,
    totalBytes,
  };
}
