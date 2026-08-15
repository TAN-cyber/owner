import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { nativeProjectPaths } from '../../../domains/owner-native/native-paths.js';
import {
  defaultProjectConfig,
  writeProjectConfig,
} from '../../../domains/owner-native/native-config.js';
import { parseNativeVerificationEvidenceEnvelope } from '../../../domains/owner-native/native-verification-evidence.js';
import type { NativeProjectPaths } from '../../../domains/owner-native/native-types.js';

const fixture = path.resolve('test/fixtures/native-legacy-archive');
const envelopeRef =
  'runtime/evidence/verifications/3938bdbdfb79695122d3148cdeddb123e45756ab6287388e6d19b22c16cf2660.json';

describe('Native legacy v1 archive handling', () => {
  let root: string;
  let paths: NativeProjectPaths;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-native-v1-archive-'));
    paths = await nativeProjectPaths(root, '.');
    await writeProjectConfig(root, defaultProjectConfig('.'));
    await fs.mkdir(paths.archiveDir, { recursive: true });
    await fs.cp(fixture, path.join(paths.archiveDir, '2026-07-21-classic-config-block'), {
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
    expect(() => parseNativeVerificationEvidenceEnvelope(raw)).toThrow(
      'Native verification evidence has unknown field(s): receiptRef',
    );
  });
});
