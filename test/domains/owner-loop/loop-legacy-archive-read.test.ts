import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loopProjectPaths } from '../../../domains/owner-loop/loop-paths.js';
import {
  defaultProjectConfig,
  writeProjectConfig,
} from '../../../domains/owner-loop/loop-config.js';
import { parseLoopVerificationEvidenceEnvelope } from '../../../domains/owner-loop/loop-verification-evidence.js';
import type { LoopProjectPaths } from '../../../domains/owner-loop/loop-types.js';

const fixture = path.resolve('test/fixtures/loop-legacy-archive');
const envelopeRef =
  'runtime/evidence/verifications/3938bdbdfb79695122d3148cdeddb123e45756ab6287388e6d19b22c16cf2660.json';

describe('Loop legacy v1 archive handling', () => {
  let root: string;
  let paths: LoopProjectPaths;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-v1-archive-'));
    paths = await loopProjectPaths(root, '.');
    await writeProjectConfig(root, defaultProjectConfig('.'));
    await fs.mkdir(paths.archiveDir, { recursive: true });
    await fs.cp(fixture, path.join(paths.archiveDir, '2026-07-21-pipeline-config-block'), {
      recursive: true,
    });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('rejects removed historical evidence fields in the current parser', async () => {
    const raw = JSON.parse(
      await fs.readFile(path.join(fixture, ...envelopeRef.split('/')), 'utf8'),
    ) as unknown;
    expect(() => parseLoopVerificationEvidenceEnvelope(raw)).toThrow(
      'Loop verification evidence has unknown field(s): receiptRef',
    );
  });
});
