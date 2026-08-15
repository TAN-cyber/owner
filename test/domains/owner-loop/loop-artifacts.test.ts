import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import {
  LOOP_ARTIFACT_VALIDATION_LIMITS,
  validateLoopBrief,
  validateLoopSpecChanges,
  validateLoopVerification,
} from '../../../domains/owner-loop/loop-artifacts.js';
import { createLoopChange, loopChangeDir } from '../../../domains/owner-loop/loop-change.js';
import { sha256Text } from '../../../domains/owner-loop/loop-hash.js';
import { loopProjectPaths } from '../../../domains/owner-loop/loop-paths.js';
import type { LoopChangeState, LoopProjectPaths } from '../../../domains/owner-loop/loop-types.js';

const brief = `# Outcome
Ship authentication.
# Scope
Login only.
# Non-goals
No social auth.
# Acceptance examples
- Valid credentials work.
# Constraints and invariants
Keep compatibility.
# Decisions
Use existing sessions.
# Open questions

# Verification expectations
Run auth tests.
`;

const verification = `# Acceptance evidence
Auth test covers login.
# Commands and results
npm test passed.
# Skipped checks
None.
# Spec consistency
Implementation matches the target spec.
# Known limitations and risks
No known limitations.
# Conclusion
Pass.
`;

describe('Loop artifact validation', () => {
  let projectRoot: string;
  let paths: LoopProjectPaths;
  let state: LoopChangeState;
  let changeDir: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-artifacts-'));
    paths = await loopProjectPaths(projectRoot, '.');
    state = await createLoopChange({
      paths,
      name: 'auth-change',
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });
    changeDir = loopChangeDir(paths, state.name);
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('accepts a complete brief and blocks multiple explicit blocking questions', async () => {
    await fs.writeFile(path.join(changeDir, 'brief.md'), brief);
    expect(await validateLoopBrief(changeDir, 'brief.md')).toEqual({ valid: true, findings: [] });

    await fs.writeFile(
      path.join(changeDir, 'brief.md'),
      brief.replace(
        '# Open questions\n',
        '# Open questions\n- [blocking] Q1: Choose token lifetime.\n- [blocking] Q2: Choose refresh behavior.\n',
      ),
    );
    expect((await validateLoopBrief(changeDir, 'brief.md')).findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'brief-blocking-question' })]),
    );
  });

  it('requires every verification section to be non-empty', async () => {
    await fs.writeFile(path.join(changeDir, 'verification.md'), verification);
    expect(await validateLoopVerification(changeDir, 'verification.md')).toEqual({
      valid: true,
      findings: [],
    });

    await fs.writeFile(
      path.join(changeDir, 'verification.md'),
      verification.replace('Pass.\n', ''),
    );
    expect((await validateLoopVerification(changeDir, 'verification.md')).valid).toBe(false);
  });

  it('bounds brief and verification reads before Markdown parsing', async () => {
    await fs.writeFile(
      path.join(changeDir, 'brief.md'),
      'x'.repeat(LOOP_ARTIFACT_VALIDATION_LIMITS.maxFileBytes + 1),
    );
    await fs.writeFile(
      path.join(changeDir, 'verification.md'),
      'x'.repeat(LOOP_ARTIFACT_VALIDATION_LIMITS.maxFileBytes + 1),
    );

    expect(await validateLoopBrief(changeDir, 'brief.md')).toMatchObject({
      valid: false,
      findings: [expect.objectContaining({ message: expect.stringContaining('exceeds') })],
    });
    expect(await validateLoopVerification(changeDir, 'verification.md')).toMatchObject({
      valid: false,
      findings: [expect.objectContaining({ message: expect.stringContaining('exceeds') })],
    });
  });

  it('validates complete target specs and canonical base hashes', async () => {
    const canonical = '# Authentication\nCurrent behavior.\n';
    const canonicalFile = path.join(paths.specsDir, 'authentication', 'spec.md');
    const proposedFile = path.join(changeDir, 'specs', 'authentication', 'spec.md');
    await fs.mkdir(path.dirname(canonicalFile), { recursive: true });
    await fs.mkdir(path.dirname(proposedFile), { recursive: true });
    await fs.writeFile(canonicalFile, canonical);
    await fs.writeFile(proposedFile, '# Authentication\nTarget behavior.\n');
    state.spec_changes = [
      {
        capability: 'authentication',
        operation: 'replace',
        source: 'specs/authentication/spec.md',
        base_hash: sha256Text(canonical),
      },
    ];

    expect(await validateLoopSpecChanges(paths, state)).toEqual({ valid: true, findings: [] });

    await fs.writeFile(canonicalFile, '# Authentication\nConcurrent change.\n');
    expect((await validateLoopSpecChanges(paths, state)).findings[0]).toMatchObject({
      code: 'spec-base-conflict',
    });
  });

  it('rejects a proposed spec symlink that escapes the change', async () => {
    const outside = path.join(projectRoot, 'outside-spec');
    const sourceDirectory = path.join(changeDir, 'specs', 'escaped');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'spec.md'), 'outside');
    await fs.symlink(outside, sourceDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    state.spec_changes = [
      {
        capability: 'escaped',
        operation: 'create',
        source: 'specs/escaped/spec.md',
        base_hash: null,
      },
    ];
    expect((await validateLoopSpecChanges(paths, state)).findings[0]).toMatchObject({
      code: 'spec-source-invalid',
    });
  });

  it('rejects a canonical spec directory symlink that escapes the Loop root', async () => {
    const outside = path.join(projectRoot, 'outside-canonical');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'spec.md'), 'outside canonical\n');
    await fs.mkdir(paths.specsDir, { recursive: true });
    await fs.symlink(
      outside,
      path.join(paths.specsDir, 'escaped'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    state.spec_changes = [
      {
        capability: 'escaped',
        operation: 'replace',
        source: 'specs/escaped/spec.md',
        base_hash: '0'.repeat(64),
      },
    ];

    expect((await validateLoopSpecChanges(paths, state)).findings[0]).toMatchObject({
      code: 'spec-canonical-unsafe',
    });
  });
});
