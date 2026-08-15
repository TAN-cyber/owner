import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { createLoopChange, loopChangeDir } from '../../../domains/owner-loop/loop-change.js';
import { inspectLoopGuard } from '../../../domains/owner-loop/loop-guards.js';
import { loopProjectPaths } from '../../../domains/owner-loop/loop-paths.js';
import { advanceLoopChange } from '../../../domains/owner-loop/loop-transitions.js';
import type { LoopChangeState, LoopProjectPaths } from '../../../domains/owner-loop/loop-types.js';

const completeBrief = `# Outcome
Ship the feature.
# Scope
One capability.
# Non-goals
No migration.
# Acceptance examples
- The feature works.
# Constraints and invariants
Keep compatibility.
# Decisions
Use existing APIs.
# Open questions

# Verification expectations
Run focused tests.
`;

describe('Loop phase guards', () => {
  let projectRoot: string;
  let paths: LoopProjectPaths;
  let state: LoopChangeState;
  let changeDir: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-guards-'));
    paths = await loopProjectPaths(projectRoot, '.');
    state = await createLoopChange({
      paths,
      name: 'guarded-change',
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });
    changeDir = loopChangeDir(paths, state.name);
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('blocks incomplete Shape without mutating state', async () => {
    const result = await inspectLoopGuard({
      paths,
      state,
      evidence: { summary: 'ready' },
      clarificationMode: 'sequential',
    });
    expect(result.valid).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'brief-section-empty' })]),
    );
    expect(result.findings).not.toContainEqual(
      expect.objectContaining({ code: 'shape-confirmation-required' }),
    );
  });

  it('does not let a confirmation flag bypass a blocking decision', async () => {
    await fs.writeFile(
      path.join(changeDir, 'brief.md'),
      completeBrief.replace(
        '# Open questions\n',
        '# Open questions\n- [blocking] Choose the public behavior.\n',
      ),
    );
    expect(
      (
        await inspectLoopGuard({
          paths,
          state,
          evidence: { summary: 'ready', confirmed: true },
          clarificationMode: 'sequential',
        })
      ).findings,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'brief-blocking-question' })]),
    );

    await fs.writeFile(path.join(changeDir, 'brief.md'), completeBrief);
    expect(
      await inspectLoopGuard({
        paths,
        state,
        evidence: { summary: 'ready', confirmed: true },
        clarificationMode: 'sequential',
      }),
    ).toEqual({
      valid: true,
      findings: [],
    });
  });

  it('requires explicit shared-understanding confirmation in Batch mode', async () => {
    await fs.writeFile(path.join(changeDir, 'brief.md'), completeBrief);
    const result = await inspectLoopGuard({
      paths,
      state,
      evidence: { summary: 'batch frontier is complete' },
      clarificationMode: 'batch',
    });

    expect(result).toMatchObject({
      valid: false,
      findings: [
        expect.objectContaining({
          code: 'shape-confirmation-required',
          message:
            'Loop clarification requires explicit user confirmation of the shared understanding before Build',
        }),
      ],
    });
  });

  it('requires a real artifact or a no-code reason in Build', async () => {
    await fs.writeFile(path.join(changeDir, 'brief.md'), completeBrief);
    state = (
      await advanceLoopChange({
        paths,
        name: state.name,
        evidence: { summary: 'shape is ready', confirmed: true },
        clarificationMode: 'batch',
      })
    ).change;
    expect(
      (
        await inspectLoopGuard({
          paths,
          state,
          evidence: { summary: 'built' },
          clarificationMode: 'batch',
        })
      ).findings,
    ).toContainEqual(expect.objectContaining({ code: 'build-evidence-missing' }));
    expect(
      await inspectLoopGuard({
        paths,
        state,
        evidence: { summary: 'docs only', noCodeReason: 'The change only updates documentation.' },
        clarificationMode: 'batch',
      }),
    ).toEqual({ valid: true, findings: [] });
  });

  it('keeps a newly discovered blocking decision from leaving Build', async () => {
    await fs.writeFile(path.join(changeDir, 'brief.md'), completeBrief);
    state = (
      await advanceLoopChange({
        paths,
        name: state.name,
        evidence: { summary: 'shape is ready', confirmed: true },
        clarificationMode: 'batch',
      })
    ).change;
    await fs.writeFile(
      path.join(changeDir, 'brief.md'),
      completeBrief.replace(
        '# Open questions\n',
        '# Open questions\n- [blocking] Choose the newly discovered public behavior.\n',
      ),
    );

    const result = await inspectLoopGuard({
      paths,
      state,
      clarificationMode: 'batch',
      evidence: {
        summary: 'implementation paused for the decision',
        noCodeReason: 'The decision is still unresolved.',
        confirmed: true,
      },
    });
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: 'brief-blocking-question' }),
    );
  });
});
