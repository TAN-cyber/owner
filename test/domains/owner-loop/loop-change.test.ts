import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { stringify } from 'yaml';

import {
  DEFAULT_LOOP_SNAPSHOT_CONFIG,
  defaultProjectConfig,
  writeProjectConfig,
} from '../../../domains/owner-loop/loop-config.js';
import {
  assertCapabilityId,
  assertLoopName,
  compareAndSwapLoopChange,
  createLoopChange,
  inspectLoopChangeValue,
  listLoopChanges,
  LOOP_CHANGE_DOCUMENT_MAX_BYTES,
  LoopChangeRevisionConflictError,
  loopChangeDocument,
  loopV2ChangeDocument,
  parseLegacyLoopChangeValue,
  parseLoopChangeValue,
  parseV2LoopChangeValue,
  readLoopChange,
  writeLoopChange,
} from '../../../domains/owner-loop/loop-change.js';
import {
  loopPreferredChangeRuntimeDir,
  loopProjectPaths,
} from '../../../domains/owner-loop/loop-paths.js';
import { readLoopBaselineManifest } from '../../../domains/owner-loop/loop-snapshot.js';
import {
  LOOP_CHANGE_SCHEMA,
  LOOP_LEGACY_CHANGE_SCHEMA,
  LOOP_RUNTIME_PROTOCOL_VERSION,
  LOOP_V2_CHANGE_SCHEMA,
  type LoopProjectPaths,
} from '../../../domains/owner-loop/loop-types.js';

function validLoopChangeValue(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: LOOP_CHANGE_SCHEMA,
    minimum_runtime_version: LOOP_RUNTIME_PROTOCOL_VERSION,
    revision: 1,
    verification_protocol: 'legacy-v1',
    name: 'parser-change',
    language: 'en',
    phase: 'shape',
    brief: 'brief.md',
    approval: null,
    spec_changes: [],
    verification_result: 'pending',
    verification_report: null,
    implementation_scope: null,
    verification_evidence: null,
    partial_allowance: null,
    archived: false,
    created_at: '2026-08-12',
    run_id: null,
    approved_contract_hash: null,
    ...patch,
  };
}

describe('Loop change store', () => {
  let projectRoot: string;
  let paths: LoopProjectPaths;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-change-'));
    paths = await loopProjectPaths(projectRoot, '.');
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('validates Loop names and parses legacy, v2, and current change documents', () => {
    expect(() => assertLoopName('valid-change-2')).not.toThrow();
    expect(() => assertCapabilityId('capability-2')).not.toThrow();
    expect(() => assertLoopName('Bad Change')).toThrow('Invalid Loop change name');
    expect(() => assertCapabilityId('../escape')).toThrow('Invalid Loop capability id');

    const legacy = {
      ...validLoopChangeValue(),
      schema: LOOP_LEGACY_CHANGE_SCHEMA,
    };
    delete legacy.minimum_runtime_version;
    delete legacy.revision;
    delete legacy.verification_protocol;
    delete legacy.approved_contract_hash;
    delete legacy.implementation_scope;
    delete legacy.verification_evidence;
    delete legacy.partial_allowance;
    const parsedLegacy = parseLegacyLoopChangeValue(legacy);
    expect(parsedLegacy.schema).toBe(LOOP_LEGACY_CHANGE_SCHEMA);

    const v2 = {
      ...legacy,
      schema: LOOP_V2_CHANGE_SCHEMA,
      minimum_runtime_version: 2,
      revision: 4,
    };
    const parsedV2 = parseV2LoopChangeValue(v2);
    expect(parsedV2.revision).toBe(4);

    const current = parseLoopChangeValue(
      validLoopChangeValue({
        approval: 'confirmed',
        approved_contract_hash: 'a'.repeat(64),
        implementation_scope: `runtime/evidence/scopes/${'b'.repeat(64)}.json`,
        verification_evidence: `runtime/evidence/verifications/${'c'.repeat(64)}.json`,
        partial_allowance: `runtime/evidence/allowances/${'d'.repeat(64)}.json`,
        verification_report: 'runtime/verification-report.json',
        run_id: 'run-1',
        archived: true,
        phase: 'archive',
        verification_result: 'pass',
        language: 'zh-CN',
        spec_changes: [
          { capability: 'new-cap', operation: 'create', source: 'specs/new.md', base_hash: null },
          {
            capability: 'replace-cap',
            operation: 'replace',
            source: 'specs/replace.md',
            base_hash: 'e'.repeat(64),
          },
          { capability: 'remove-cap', operation: 'remove', base_hash: 'f'.repeat(64) },
        ],
      }),
    );
    expect(current).toMatchObject({ phase: 'archive', approval: 'confirmed', archived: true });
    expect(loopChangeDocument(current).schema).toBe(LOOP_CHANGE_SCHEMA);
    expect(loopChangeDocument(current).spec_changes).toHaveLength(3);
    expect(loopV2ChangeDocument(parsedV2).schema).toBe(LOOP_V2_CHANGE_SCHEMA);
  });

  it('reports migration, incompatibility, and current inspection states', () => {
    const legacy = { ...validLoopChangeValue(), schema: LOOP_LEGACY_CHANGE_SCHEMA };
    delete legacy.minimum_runtime_version;
    delete legacy.revision;
    delete legacy.verification_protocol;
    delete legacy.approved_contract_hash;
    delete legacy.implementation_scope;
    delete legacy.verification_evidence;
    delete legacy.partial_allowance;

    expect(inspectLoopChangeValue(legacy)).toMatchObject({
      status: 'migration-required',
      schema: LOOP_LEGACY_CHANGE_SCHEMA,
    });
    expect(
      inspectLoopChangeValue({ schema: 'owner.loop.unknown', minimum_runtime_version: 9 }),
    ).toMatchObject({
      status: 'runtime-incompatible',
      minimumRuntimeVersion: 9,
    });
    expect(inspectLoopChangeValue({})).toMatchObject({
      status: 'runtime-incompatible',
      schema: '(missing)',
      minimumRuntimeVersion: null,
    });
    expect(inspectLoopChangeValue(validLoopChangeValue())).toMatchObject({
      status: 'current',
      minimumRuntimeVersion: LOOP_RUNTIME_PROTOCOL_VERSION,
    });
    expect(() => parseLoopChangeValue(legacy)).toThrow('run owner loop doctor');
    expect(() =>
      parseLoopChangeValue({
        ...legacy,
        schema: LOOP_V2_CHANGE_SCHEMA,
        minimum_runtime_version: 2,
        revision: 1,
      }),
    ).toThrow('run owner loop doctor');
  });

  it.each([
    ['unknown current field', { extra: true }, 'unknown field'],
    ['invalid minimum runtime', { minimum_runtime_version: 2 }, 'minimum_runtime_version must be'],
    ['future minimum runtime', { minimum_runtime_version: 4 }, 'runtime protocol'],
    ['invalid revision', { revision: 0 }, 'revision must be a positive integer'],
    [
      'invalid protocol',
      { verification_protocol: 'v2' },
      'verification_protocol must be legacy-v1',
    ],
    [
      'approval hash without approval',
      { approved_contract_hash: 'a'.repeat(64) },
      'requires an approval',
    ],
    ['invalid approval hash', { approved_contract_hash: 'bad' }, 'approved_contract_hash'],
    [
      'invalid evidence ref',
      { implementation_scope: 'runtime/evidence/bad.json' },
      'implementation_scope',
    ],
    ['invalid date', { created_at: '2026-02-30' }, 'created_at must be'],
    ['invalid run id', { run_id: '' }, 'run_id must be'],
    ['invalid archived type', { archived: 'false' }, 'archived must be boolean'],
    ['invalid verification report', { verification_report: 1 }, 'verification_report must be'],
  ])('rejects %s current field', (_label, patch, message) => {
    expect(() => parseLoopChangeValue(validLoopChangeValue(patch))).toThrow(message);
  });

  it.each([
    ['missing name', { name: null }, 'name is required'],
    ['invalid language', { language: 'fr' }, 'language must be'],
    ['invalid phase', { phase: 'unknown' }, 'phase is invalid'],
    ['invalid brief', { brief: 'README.md' }, 'brief must be'],
    ['invalid approval', { approval: 'pending' }, 'approval is invalid'],
    ['invalid spec list', { spec_changes: null }, 'spec_changes must be an array'],
    [
      'invalid verification result',
      { verification_result: 'unknown' },
      'verification_result is invalid',
    ],
    ['absolute verification report', { verification_report: '/tmp/report.json' }, 'stay inside'],
    ['parent verification report', { verification_report: '../report.json' }, 'stay inside'],
    ['invalid date shape', { created_at: '2026-1-1' }, 'created_at must be'],
    ['invalid run id type', { run_id: 1 }, 'run_id must be'],
  ])('rejects %s in the common change fields', (_label, patch, message) => {
    expect(() => parseLoopChangeValue(validLoopChangeValue(patch))).toThrow(message);
  });

  it('rejects duplicate capabilities and invalid content-addressed references', () => {
    expect(() =>
      parseLoopChangeValue(
        validLoopChangeValue({
          spec_changes: [
            { capability: 'same-cap', operation: 'create', source: 'one.md', base_hash: null },
            { capability: 'same-cap', operation: 'remove', base_hash: 'a'.repeat(64) },
          ],
        }),
      ),
    ).toThrow('Duplicate Loop capability operation');
    expect(() =>
      parseLoopChangeValue(
        validLoopChangeValue({
          implementation_scope: `runtime/evidence/unknown/${'a'.repeat(64)}.json`,
        }),
      ),
    ).toThrow('implementation_scope');
  });

  it('accepts omitted optional protocol bindings and all supported relative references', () => {
    const value = validLoopChangeValue();
    delete value.verification_protocol;
    delete value.approved_contract_hash;
    const parsed = parseLoopChangeValue(value);
    expect(parsed.verification_protocol).toBe('legacy-v1');
    expect(parsed.approved_contract_hash).toBeNull();
    expect(parsed.implementation_scope).toBeNull();
  });

  it.each([
    ['non-mapping spec change', [null], 'must be a mapping'],
    [
      'missing capability',
      [{ operation: 'create', source: 'spec.md', base_hash: null }],
      'capability is required',
    ],
    [
      'invalid operation',
      [{ capability: 'cap', operation: 'update', base_hash: null }],
      'Invalid spec operation',
    ],
    [
      'non-string source',
      [{ capability: 'cap', operation: 'create', source: 1, base_hash: null }],
      'must be a string',
    ],
    [
      'absolute source',
      [{ capability: 'cap', operation: 'create', source: '/tmp/spec.md', base_hash: null }],
      'stay inside',
    ],
    [
      'create without source',
      [{ capability: 'cap', operation: 'create', source: undefined, base_hash: null }],
      'requires source',
    ],
    [
      'create with base hash',
      [{ capability: 'cap', operation: 'create', source: 'spec.md', base_hash: 'a'.repeat(64) }],
      'requires null base_hash',
    ],
    [
      'replace without source',
      [{ capability: 'cap', operation: 'replace', base_hash: 'a'.repeat(64) }],
      'requires source',
    ],
    [
      'replace with invalid hash',
      [{ capability: 'cap', operation: 'replace', source: 'spec.md', base_hash: null }],
      'requires a SHA-256',
    ],
    [
      'remove with source',
      [{ capability: 'cap', operation: 'remove', source: 'spec.md', base_hash: 'a'.repeat(64) }],
      'forbids source',
    ],
    [
      'remove with invalid hash',
      [{ capability: 'cap', operation: 'remove', base_hash: null }],
      'requires a SHA-256',
    ],
  ])('rejects %s', (_label, specChanges, message) => {
    expect(() => parseLoopChangeValue(validLoopChangeValue({ spec_changes: specChanges }))).toThrow(
      message,
    );
  });

  it('creates the visible Loop change layout without claiming Shape is complete', async () => {
    const state = await createLoopChange({
      paths,
      name: 'add-authentication',
      language: 'zh-CN',
      now: new Date('2026-07-14T00:00:00Z'),
    });

    expect(state).toMatchObject({
      schema: LOOP_CHANGE_SCHEMA,
      minimum_runtime_version: LOOP_RUNTIME_PROTOCOL_VERSION,
      revision: 1,
      verification_protocol: 'legacy-v1',
      phase: 'shape',
      approval: null,
      approved_contract_hash: null,
      verification_result: 'pending',
      created_at: '2026-07-14',
    });
    expect(state).not.toHaveProperty('confirmation_required');
    expect(await readLoopChange(paths, state.name)).toEqual(state);
    await expect(
      fs.access(path.join(paths.changesDir, state.name, 'owner-state.yaml')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(paths.changesDir, state.name, 'change.yaml')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.stat(path.join(paths.changesDir, state.name, 'specs'))).toBeDefined();
    expect(
      await fs.stat(path.join(loopPreferredChangeRuntimeDir(paths, state.name), 'checkpoints')),
    ).toBeDefined();
    expect(await readLoopBaselineManifest(paths, state.name)).toMatchObject({
      schema: 'owner.loop.content-snapshot.v1',
      origin: 'change-created',
      complete: true,
      entries: [],
    });
  });

  it.skip('fails at change creation when the baseline snapshot is incomplete', async () => {
    const config = defaultProjectConfig('.');
    config.loop.snapshot.max_total_bytes = 5 * 1024 * 1024;
    await writeProjectConfig(projectRoot, config);
    await fs.writeFile(
      path.join(projectRoot, 'oversized-baseline.bin'),
      Buffer.alloc(5 * 1024 * 1024 + 1, 0x61),
    );

    await expect(
      createLoopChange({
        paths,
        name: 'incomplete-baseline',
        language: 'en',
        verificationProtocol: 'legacy-v1',
      }),
    ).rejects.toMatchObject({
      name: 'LoopBaselineIncompleteError',
      code: 'loop-baseline-incomplete',
      omittedCount: 1,
      samplePaths: ['oversized-baseline.bin'],
      sampleTruncated: false,
    });
    await expect(
      fs.access(path.join(paths.changesDir, 'incomplete-baseline')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('creates a complete baseline for a file larger than the legacy per-file limit', async () => {
    await writeProjectConfig(projectRoot, defaultProjectConfig('.'));
    await fs.writeFile(
      path.join(projectRoot, 'large-baseline.bin'),
      Buffer.alloc(5 * 1024 * 1024 + 1, 0x61),
    );

    const state = await createLoopChange({
      paths,
      name: 'large-baseline',
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });

    expect(await readLoopBaselineManifest(paths, state.name)).toMatchObject({
      complete: true,
      policy: {
        schema: 'owner.loop.snapshot-policy.v1',
        include: ['**/*'],
        exclude: DEFAULT_LOOP_SNAPSHOT_CONFIG.exclude,
      },
      entries: [
        expect.objectContaining({
          path: 'large-baseline.bin',
          size: 5 * 1024 * 1024 + 1,
        }),
      ],
    });
  });

  it.skip('creates a complete baseline after the project raises the total snapshot budget', async () => {
    const config = defaultProjectConfig('.');
    config.loop.snapshot.max_total_bytes = 1024;
    await writeProjectConfig(projectRoot, config);
    await fs.writeFile(path.join(projectRoot, 'dataset.bin'), Buffer.alloc(1025, 0x61));

    await expect(
      createLoopChange({
        paths,
        name: 'budget-too-small',
        language: 'en',
        verificationProtocol: 'legacy-v1',
      }),
    ).rejects.toMatchObject({
      name: 'LoopBaselineIncompleteError',
      effectiveLimits: expect.objectContaining({
        maxFileBytes: 1024,
        maxTotalBytes: 1024,
      }),
    });

    config.loop.snapshot.max_total_bytes = 2048;
    await writeProjectConfig(projectRoot, config);
    const state = await createLoopChange({
      paths,
      name: 'budget-raised',
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });

    expect(await readLoopBaselineManifest(paths, state.name)).toMatchObject({
      complete: true,
      limits: {
        maxFiles: 10_000,
        maxFileBytes: 2048,
        maxTotalBytes: 2048,
        maxManifestBytes: expect.any(Number),
        maxDurationMs: 60_000,
      },
      entries: [expect.objectContaining({ path: 'dataset.bin', size: 1025 })],
    });
  });

  it('reads older v3 state without an approval hash and canonicalizes it to null', async () => {
    const state = await createLoopChange({
      paths,
      name: 'legacy-v3-state',
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });
    const file = path.join(paths.changesDir, state.name, 'owner-state.yaml');
    const legacy = { ...state } as Record<string, unknown>;
    delete legacy.approved_contract_hash;
    delete legacy.verification_protocol;
    await fs.writeFile(file, stringify(legacy));

    const parsed = await readLoopChange(paths, state.name);
    expect(parsed.approved_contract_hash).toBeNull();
    expect(parsed.verification_protocol).toBe('legacy-v1');
    await writeLoopChange(paths, parsed);
    expect(await fs.readFile(file, 'utf8')).toContain('approved_contract_hash: null');
    expect(await fs.readFile(file, 'utf8')).toContain('verification_protocol: legacy-v1');
  });

  it('round-trips create, replace, and remove spec operations', async () => {
    const state = await createLoopChange({
      paths,
      name: 'update-auth',
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });
    state.spec_changes = [
      {
        capability: 'new-auth',
        operation: 'create',
        source: 'specs/new-auth/spec.md',
        base_hash: null,
      },
      {
        capability: 'old-auth',
        operation: 'replace',
        source: 'specs/old-auth/spec.md',
        base_hash: 'a'.repeat(64),
      },
      { capability: 'legacy-auth', operation: 'remove', base_hash: 'b'.repeat(64) },
    ];
    await writeLoopChange(paths, state);
    expect(state.revision).toBe(2);
    expect(await readLoopChange(paths, state.name)).toEqual(state);
  });

  it('fails closed before parsing an oversized change document', async () => {
    const state = await createLoopChange({
      paths,
      name: 'oversized-change',
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });
    await fs.writeFile(
      path.join(paths.changesDir, state.name, 'owner-state.yaml'),
      'x'.repeat(LOOP_CHANGE_DOCUMENT_MAX_BYTES + 1),
    );

    await expect(readLoopChange(paths, state.name)).rejects.toThrow(
      `exceeds ${LOOP_CHANGE_DOCUMENT_MAX_BYTES} bytes`,
    );
  });

  it('rejects a stale change write instead of silently overwriting a newer revision', async () => {
    const created = await createLoopChange({
      paths,
      name: 'revision-conflict',
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });
    const first = structuredClone(created);
    const stale = structuredClone(created);
    first.approval = 'implicit';
    stale.approval = 'confirmed';

    await compareAndSwapLoopChange(paths, first, created.revision);
    expect(first.revision).toBe(2);
    await expect(compareAndSwapLoopChange(paths, stale, created.revision)).rejects.toBeInstanceOf(
      LoopChangeRevisionConflictError,
    );
    expect(await readLoopChange(paths, created.name)).toMatchObject({
      revision: 2,
      approval: 'implicit',
    });
  });

  it('allows only one competing writer to advance the same revision', async () => {
    const created = await createLoopChange({
      paths,
      name: 'concurrent-cas',
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });
    const left = { ...structuredClone(created), approval: 'implicit' as const };
    const right = { ...structuredClone(created), approval: 'confirmed' as const };
    const results = await Promise.allSettled([
      compareAndSwapLoopChange(paths, left, created.revision),
      compareAndSwapLoopChange(paths, right, created.revision),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await readLoopChange(paths, created.name)).revision).toBe(2);
  });

  it('lists multiple active changes in name order', async () => {
    await createLoopChange({
      paths,
      name: 'zeta-change',
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });
    await createLoopChange({
      paths,
      name: 'alpha-change',
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });
    expect((await listLoopChanges(paths)).map((state) => state.name)).toEqual([
      'alpha-change',
      'zeta-change',
    ]);
  });

  it.each([
    ['unknown field', { extra: true }],
    ['bad phase', { phase: 'design' }],
    ['bad date', { created_at: '2026-02-31' }],
    ['bad name', { name: '../escape' }],
  ])('rejects %s', async (_label, patch) => {
    const state = await createLoopChange({
      paths,
      name: 'strict-change',
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });
    const file = path.join(paths.changesDir, state.name, 'owner-state.yaml');
    const value = { ...state, ...patch };
    await fs.writeFile(file, stringify(value));
    await expect(readLoopChange(paths, state.name)).rejects.toBeInstanceOf(Error);
  });

  it('requires field-specific change-relative content-addressed evidence refs', async () => {
    const state = await createLoopChange({
      paths,
      name: 'strict-evidence',
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });
    const file = path.join(paths.changesDir, state.name, 'owner-state.yaml');
    const hash = 'a'.repeat(64);
    await fs.writeFile(
      file,
      stringify({
        ...state,
        implementation_scope: `runtime/evidence/scopes/${hash}.json`,
        verification_evidence: `runtime/evidence/verifications/${hash}.json`,
        partial_allowance: `runtime/evidence/allowances/${hash}.json`,
      }),
    );
    await expect(readLoopChange(paths, state.name)).resolves.toMatchObject({
      implementation_scope: `runtime/evidence/scopes/${hash}.json`,
      verification_evidence: `runtime/evidence/verifications/${hash}.json`,
      partial_allowance: `runtime/evidence/allowances/${hash}.json`,
    });

    for (const patch of [
      { implementation_scope: `runtime/evidence/verifications/${hash}.json` },
      { verification_evidence: `runtime/evidence/verifications/${'A'.repeat(64)}.json` },
      { partial_allowance: `runtime/evidence/allowances/../${hash}.json` },
      { implementation_scope: `runtime/evidence/${hash}.json` },
    ]) {
      await fs.writeFile(file, stringify({ ...state, ...patch }));
      await expect(readLoopChange(paths, state.name)).rejects.toThrow(
        /must be null or runtime\/evidence/iu,
      );
    }

    const missing = { ...state } as Record<string, unknown>;
    delete missing.verification_evidence;
    await fs.writeFile(file, stringify(missing));
    await expect(readLoopChange(paths, state.name)).rejects.toThrow(
      /Loop verification_evidence must be null/iu,
    );
  });

  it('rejects duplicate capabilities and path traversal sources', async () => {
    const state = await createLoopChange({
      paths,
      name: 'strict-specs',
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });
    const file = path.join(paths.changesDir, state.name, 'owner-state.yaml');
    await fs.writeFile(
      file,
      stringify({
        ...state,
        spec_changes: [
          {
            capability: 'auth',
            operation: 'create',
            source: 'specs/auth/spec.md',
            base_hash: null,
          },
          { capability: 'auth', operation: 'create', source: '../auth.md', base_hash: null },
        ],
      }),
    );
    await expect(readLoopChange(paths, state.name)).rejects.toBeInstanceOf(Error);
  });
});
