import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createLoopChange,
  loopChangeDir,
  readLoopChange,
} from '../../../domains/owner-loop/loop-change.js';
import { sha256File } from '../../../domains/owner-loop/loop-hash.js';
import { loopProjectPaths } from '../../../domains/owner-loop/loop-paths.js';
import {
  markLoopSpecRemoval,
  readLoopProposedSpecs,
  reconcileLoopSpecChanges,
} from '../../../domains/owner-loop/loop-specs.js';
import { loopTransitionJournalFile } from '../../../domains/owner-loop/loop-transition-journal.js';
import type { LoopProjectPaths } from '../../../domains/owner-loop/loop-types.js';
import { advanceLoopChange } from '../../helpers/loop-confirmed-transition.js';

const brief = `# Outcome
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

describe('Loop runtime-owned spec metadata', () => {
  let projectRoot: string;
  let paths: LoopProjectPaths;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-specs-'));
    paths = await loopProjectPaths(projectRoot, '.');
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  async function proposed(change: string, capability: string, source: string): Promise<void> {
    const file = path.join(loopChangeDir(paths, change), 'specs', capability, 'spec.md');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, source);
  }

  async function canonical(capability: string, source: string): Promise<string> {
    const file = path.join(paths.specsDir, capability, 'spec.md');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, source);
    return file;
  }

  it('infers create and replace while preserving the first canonical base hash', async () => {
    let state = await createLoopChange({
      paths,
      name: 'sync-specs',
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });
    const canonicalFile = await canonical('existing-capability', 'original\n');
    const originalHash = await sha256File(canonicalFile);
    await proposed('sync-specs', 'new-capability', 'new target\n');
    await proposed('sync-specs', 'existing-capability', 'replacement target\n');

    state = { ...state, spec_changes: await reconcileLoopSpecChanges(paths, state) };
    expect(state.spec_changes).toEqual([
      {
        capability: 'existing-capability',
        operation: 'replace',
        source: 'specs/existing-capability/spec.md',
        base_hash: originalHash,
      },
      {
        capability: 'new-capability',
        operation: 'create',
        source: 'specs/new-capability/spec.md',
        base_hash: null,
      },
    ]);

    await fs.writeFile(canonicalFile, 'concurrent change\n');
    expect(await reconcileLoopSpecChanges(paths, state)).toEqual(state.spec_changes);
  });

  it('records remove through a command-owned mutation and rejects a proposed/remove conflict', async () => {
    await createLoopChange({
      paths,
      name: 'remove-spec',
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });
    const canonicalFile = await canonical('legacy-capability', 'legacy\n');
    const baseHash = await sha256File(canonicalFile);

    const removed = await markLoopSpecRemoval(paths, 'remove-spec', 'legacy-capability');
    expect(removed.spec_changes).toEqual([
      {
        capability: 'legacy-capability',
        operation: 'remove',
        base_hash: baseHash,
      },
    ]);
    expect((await readLoopChange(paths, 'remove-spec')).spec_changes).toEqual(removed.spec_changes);

    await proposed('remove-spec', 'legacy-capability', 'keep it after all\n');
    await expect(reconcileLoopSpecChanges(paths, removed)).rejects.toThrow(
      'both a proposed spec and a remove intent',
    );
  });

  it('keeps the first remove hash when the canonical spec later changes', async () => {
    await createLoopChange({
      paths,
      name: 'stable-remove',
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });
    const canonicalFile = await canonical('legacy-capability', 'legacy v1\n');
    const originalHash = await sha256File(canonicalFile);

    await markLoopSpecRemoval(paths, 'stable-remove', 'legacy-capability');
    await fs.writeFile(canonicalFile, 'legacy v2 from another change\n');
    const repeated = await markLoopSpecRemoval(paths, 'stable-remove', 'legacy-capability');

    expect(repeated.spec_changes).toEqual([
      {
        capability: 'legacy-capability',
        operation: 'remove',
        base_hash: originalHash,
      },
    ]);
  });

  it('continues a pending transition before recording a remove intent', async () => {
    const state = await createLoopChange({
      paths,
      verificationProtocol: 'legacy-v1',
      name: 'remove-after-recovery',
      language: 'en',
    });
    await fs.writeFile(path.join(loopChangeDir(paths, state.name), 'brief.md'), brief);
    await canonical('legacy-capability', 'legacy\n');
    await expect(
      advanceLoopChange({
        paths,
        name: state.name,
        evidence: { summary: 'shape is ready' },
        hooks: {
          afterPrepared: () => {
            throw new Error('interrupt before spec remove');
          },
        },
      }),
    ).rejects.toThrow('interrupt before spec remove');

    const removed = await markLoopSpecRemoval(paths, state.name, 'legacy-capability');
    expect(removed).toMatchObject({
      phase: 'build',
      spec_changes: [{ capability: 'legacy-capability', operation: 'remove' }],
    });
    await expect(fs.access(loopTransitionJournalFile(paths, state.name))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('keeps existing remove metadata when no proposed specs remain and reads an empty proposal set', async () => {
    const state = await createLoopChange({
      paths,
      verificationProtocol: 'legacy-v1',
      name: 'empty-proposals',
      language: 'en',
    });
    const canonicalFile = await canonical('legacy-capability', 'legacy\n');
    const baseHash = await sha256File(canonicalFile);
    const withRemoval = await markLoopSpecRemoval(paths, state.name, 'legacy-capability');

    await expect(reconcileLoopSpecChanges(paths, withRemoval)).resolves.toEqual([
      { capability: 'legacy-capability', operation: 'remove', base_hash: baseHash },
    ]);
    await expect(readLoopProposedSpecs(paths, state.name)).resolves.toEqual({});
  });
});
