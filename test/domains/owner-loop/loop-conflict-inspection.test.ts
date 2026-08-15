import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { prepareLoopBuildEvidence } from '../../../domains/owner-loop/loop-build-evidence.js';
import {
  createLoopChange,
  loopChangeDir,
  writeLoopChange,
} from '../../../domains/owner-loop/loop-change.js';
import {
  inspectLoopChangeConflicts,
  inspectLoopConflictRadar,
} from '../../../domains/owner-loop/loop-conflict-inspection.js';
import { inspectLoopStatus } from '../../../domains/owner-loop/loop-diagnostics.js';
import { loopProjectPaths } from '../../../domains/owner-loop/loop-paths.js';
import type { LoopChangeState, LoopProjectPaths } from '../../../domains/owner-loop/loop-types.js';

const brief = `# Outcome
Ship the shared behavior.
# Scope
Update the shared implementation.
# Non-goals
No unrelated refactor.
# Acceptance examples
- The shared behavior works.
# Constraints and invariants
Keep callers stable.
# Decisions
Use the existing module.
# Open questions
None.
# Verification expectations
Run the focused check.
`;

describe('Loop conflict radar collection', () => {
  let projectRoot: string;
  let paths: LoopProjectPaths;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-conflict-inspection-'));
    await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'src', 'shared.ts'), 'export const value = 1;\n');
    paths = await loopProjectPaths(projectRoot, '.');
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  async function change(name: string): Promise<LoopChangeState> {
    const created = await createLoopChange({
      paths,
      name,
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });
    await fs.writeFile(path.join(loopChangeDir(paths, name), 'brief.md'), brief);
    await fs.mkdir(path.join(loopChangeDir(paths, name), 'specs'), { recursive: true });
    await fs.writeFile(
      path.join(loopChangeDir(paths, name), 'specs', 'shared-capability.md'),
      '# Shared capability\n',
    );
    const state: LoopChangeState = {
      ...created,
      phase: 'build',
      approval: 'implicit',
      spec_changes: [
        {
          capability: 'shared-capability',
          operation: 'replace',
          base_hash: 'a'.repeat(64),
          source: 'specs/shared-capability.md',
        },
      ],
    };
    await writeLoopChange(paths, state);
    return state;
  }

  it('collects current spec and content-addressed artifact overlap from one Loop root', async () => {
    const alpha = await change('alpha-change');
    const beta = await change('beta-change');
    await fs.writeFile(path.join(projectRoot, 'src', 'shared.ts'), 'export const value = 2;\n');
    for (const state of [alpha, beta]) {
      const prepared = await prepareLoopBuildEvidence({
        paths,
        state,
        artifactRefs: ['src/shared.ts'],
      });
      await writeLoopChange(paths, {
        ...state,
        implementation_scope: prepared.scopeRef as LoopChangeState['implementation_scope'],
      });
    }

    const radar = await inspectLoopConflictRadar(paths);

    expect(radar).toMatchObject({
      changeCount: 2,
      relationshipCount: 1,
      counts: { definiteConflict: 1 },
      relationships: [
        {
          left: 'alpha-change',
          right: 'beta-change',
          classification: 'definite-conflict',
          signalCount: 2,
        },
      ],
    });
    await expect(inspectLoopChangeConflicts(paths, 'alpha-change')).resolves.toEqual({
      definiteConflictCount: 1,
      possibleOverlapCount: 0,
      findingCodes: ['loop-change-conflict'],
    });
    const status = await inspectLoopStatus(paths, 'alpha-change', { details: true });
    expect(status.findings).toContainEqual(
      expect.objectContaining({ code: 'loop-change-conflict' }),
    );
  });

  it('fails closed when a visible change points at invalid scope evidence', async () => {
    const state = await change('invalid-scope');
    await writeLoopChange(paths, {
      ...state,
      implementation_scope:
        `runtime/evidence/scopes/${'f'.repeat(64)}.json` as LoopChangeState['implementation_scope'],
    });

    await expect(inspectLoopConflictRadar(paths)).rejects.toThrow();
  });

  it('does not traverse a symlinked change directory', async () => {
    await change('real-change');
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-conflict-outside-'));
    try {
      await fs.symlink(outside, path.join(paths.changesDir, 'linked-change'), 'junction');
      const radar = await inspectLoopConflictRadar(paths);
      expect(radar.changeCount).toBe(1);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
