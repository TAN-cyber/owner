import { readLoopChange } from '../../domains/owner-loop/loop-change.js';
import { advanceLoopChange as advanceRuntimeLoopChange } from '../../domains/owner-loop/loop-transitions.js';
import type { LoopClarificationMode } from '../../domains/owner-loop/loop-types.js';
import { loopVerificationFixtureReceipt } from './loop-verification.js';

type AdvanceOptions = Omit<Parameters<typeof advanceRuntimeLoopChange>[0], 'clarificationMode'> & {
  clarificationMode?: LoopClarificationMode;
};

/**
 * Advance fixtures that are not testing clarification itself through the
 * mandatory shared-understanding confirmation at Shape.
 */
export async function advanceLoopChange(options: AdvanceOptions) {
  let state;
  try {
    state = await readLoopChange(options.paths, options.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return advanceRuntimeLoopChange({
      ...options,
      clarificationMode: options.clarificationMode ?? 'sequential',
    });
  }
  const evidence =
    state.phase === 'verify' &&
    options.evidence.verificationResult === 'pass' &&
    !options.evidence.verificationReceipt
      ? {
          ...options.evidence,
          verificationReceipt: await loopVerificationFixtureReceipt({
            paths: options.paths,
            name: options.name,
          }),
        }
      : state.phase === 'shape' && options.evidence.confirmed === undefined
        ? { ...options.evidence, confirmed: true }
        : options.evidence;
  return advanceRuntimeLoopChange({
    ...options,
    clarificationMode: options.clarificationMode ?? 'sequential',
    evidence,
  });
}
