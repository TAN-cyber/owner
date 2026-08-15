import { inspectLoopChange, loopChangeDir, LoopRuntimeCompatibilityError } from './loop-change.js';
import { readLoopBoundedTextFile } from './loop-bounded-file.js';
import { inspectLoopChildren } from './loop-children.js';
import { LOOP_CONTRACT_FILE_LIMITS } from './loop-contract-files.js';
import { readLoopProposedSpecs } from './loop-specs.js';
import { loopPortableContinuation } from './loop-portable-continuation.js';
import {
  isLoopPortableChange,
  loopPortableChangeDir,
  readLoopPortableChange,
} from './loop-portable-runtime.js';
import {
  assertNoArguments,
  configuredPaths,
  LOOP_SHOW_MAX_SERIALIZED_BYTES,
  requiredPositional,
  success,
  type DispatchResult,
} from './loop-cli-shared.js';

export async function loopShowCommand(
  args: string[],
  projectRoot: string,
): Promise<DispatchResult> {
  const name = requiredPositional(args, 'change name');
  assertNoArguments(args);
  const { paths } = await configuredPaths(projectRoot);
  if (await isLoopPortableChange(paths, name)) {
    const state = await readLoopPortableChange(paths, name);
    const changeDir = loopPortableChangeDir(paths, name);
    const brief = await readLoopBoundedTextFile({
      root: changeDir,
      ref: state.brief,
      maxBytes: null,
      includeHash: false,
    });
    const proposedSpecs = [];
    for (const spec of state.spec_changes) {
      if (spec.source === null) continue;
      const source = await readLoopBoundedTextFile({
        root: changeDir,
        ref: spec.source,
        maxBytes: null,
        includeHash: false,
      });
      proposedSpecs.push({
        capability: spec.capability,
        operation: spec.operation,
        source: spec.source,
        content: source.text,
      });
    }
    const payload = {
      state,
      brief: brief.text,
      proposedSpecs,
      continuation: loopPortableContinuation(state, await inspectLoopChildren({ paths, state })),
    };
    return success('show', payload);
  }
  const inspection = await inspectLoopChange(paths, name);
  if (inspection.status === 'migration-required') {
    return success('show', {
      name,
      schema: inspection.schema,
      minimumRuntimeVersion: inspection.minimumRuntimeVersion,
      migrationRequired: true,
      message: inspection.message,
    });
  }
  if (inspection.status !== 'current' || !inspection.state) {
    throw new LoopRuntimeCompatibilityError(inspection.schema, inspection.minimumRuntimeVersion);
  }
  const state = inspection.state;
  const changeDir = loopChangeDir(paths, name);
  const proposedSpecs = await readLoopProposedSpecs(paths, name);
  const brief = await readLoopBoundedTextFile({
    root: changeDir,
    ref: state.brief,
    maxBytes: LOOP_CONTRACT_FILE_LIMITS.maxFileBytes,
  });
  const payload = {
    state,
    brief: brief.text,
    proposedSpecs,
  };
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > LOOP_SHOW_MAX_SERIALIZED_BYTES) {
    throw new Error('Loop show output exceeds its serialized byte budget');
  }
  return success('show', payload);
}
