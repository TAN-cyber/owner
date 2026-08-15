import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLoopChange } from '../../../domains/owner-loop/loop-change.js';
import {
  MAX_LOOP_EVIDENCE_DOCUMENT_BYTES,
  listLoopVerificationReceiptRefs,
  readLoopImplementationScope,
  readLoopPartialAllowance,
  readLoopVerificationReportSnapshot,
  readLoopVerificationEvidence,
  readArchivedLoopVerificationAcceptanceCounts,
  loopEvidenceRef,
  writeLoopImplementationScope,
  writeLoopPartialAllowance,
  writeLoopVerificationReportSnapshot,
  writeLoopVerificationEvidence,
} from '../../../domains/owner-loop/loop-evidence-storage.js';
import { canonicalHash } from '../../../domains/owner-loop/loop-canonical-hash.js';
import {
  loopChangeRuntimeDir,
  loopProjectPaths,
  loopRuntimeRefFile,
} from '../../../domains/owner-loop/loop-paths.js';
import type {
  LoopContentSnapshotManifest,
  LoopProjectPaths,
} from '../../../domains/owner-loop/loop-types.js';
import {
  buildLoopImplementationScopeBundle,
  LOOP_IMPLEMENTATION_SCOPE_SCHEMA,
} from '../../../domains/owner-loop/loop-verification-scope.js';
import {
  buildLoopAcceptanceEvidenceTrace,
  buildLoopPartialAllowance,
  buildLoopVerificationEvidenceEnvelope,
} from '../../../domains/owner-loop/loop-verification-evidence.js';
import { buildLoopContractSnapshot } from '../../../domains/owner-loop/loop-contract.js';

function snapshot(entries: LoopContentSnapshotManifest['entries']): LoopContentSnapshotManifest {
  return {
    schema: 'owner.loop.content-snapshot.v1',
    origin: 'explicit',
    createdAt: '2026-07-17T00:00:00.000Z',
    complete: true,
    limits: {
      maxFiles: 10,
      maxFileBytes: 1024,
      maxTotalBytes: 4096,
      maxManifestBytes: 4096,
    },
    entries,
    omitted: [],
    omittedCount: 0,
  };
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value, null, 2) + '\n', 'utf8');
}

describe('Loop evidence storage', () => {
  let projectRoot: string;
  let paths: LoopProjectPaths;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-evidence-'));
    paths = await loopProjectPaths(projectRoot, '.');
    await createLoopChange({
      paths,
      name: 'secure-login',
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  function fixtures() {
    const contract = buildLoopContractSnapshot({
      briefMarkdown: '# Acceptance examples\n- Login succeeds.\n',
      specs: [],
    });
    const bundle = buildLoopImplementationScopeBundle({
      baseline: snapshot([]),
      current: snapshot([{ path: 'src/login.ts', hash: 'a'.repeat(64), size: 10, type: 'file' }]),
      contractHash: contract.contractHash,
      declaredArtifacts: [],
    });
    const { scope } = bundle;
    const trace = buildLoopAcceptanceEvidenceTrace(
      contract.acceptance,
      [
        {
          acceptance_id: contract.acceptance[0].id,
          status: 'passed',
          evidence_refs: [`runtime/evidence/receipts/${'a'.repeat(64)}.json`],
        },
      ],
      { loopRootRef: 'owner' },
    );
    return { bundle, contract, scope, trace };
  }

  it('round-trips content-addressed scope, allowance, and verification documents', async () => {
    const { bundle, contract, scope, trace } = fixtures();
    const scopeRef = await writeLoopImplementationScope({
      paths,
      name: 'secure-login',
      bundle,
    });
    const scopeIds = scope.unresolvedScopes.map((entry) => entry.id);
    const allowance = buildLoopPartialAllowance({
      change: 'secure-login',
      scopeBundle: bundle,
      allowedScopeIds: scopeIds,
      reason: 'Known fixture boundary',
      confirmedSummary: 'Accepted the exact partial boundary',
      sourceRevision: 2,
      now: new Date('2026-07-17T00:00:00.000Z'),
    });
    const allowanceRef = await writeLoopPartialAllowance({
      paths,
      name: 'secure-login',
      allowance,
    });
    const evidence = buildLoopVerificationEvidenceEnvelope({
      change: 'secure-login',
      sourceRevision: 3,
      result: 'pass',
      contractHash: contract.contractHash,
      acceptanceHash: contract.acceptanceHash,
      implementationScope: { ref: scopeRef, bundle },
      reportRef: 'verification.md',
      reportHash: createHash('sha256').update('Verification passed.').digest('hex'),
      acceptanceTrace: trace,
      requiredReceiptRefs: [`runtime/evidence/receipts/${'b'.repeat(64)}.json`],
      partialAllowance: { ref: allowanceRef, allowance },
      now: new Date('2026-07-17T00:00:00.000Z'),
    });
    await writeLoopVerificationReportSnapshot({
      paths,
      name: 'secure-login',
      hash: evidence.reportHash,
      text: 'Verification passed.',
    });
    const evidenceRef = await writeLoopVerificationEvidence({
      paths,
      name: 'secure-login',
      evidence,
    });

    expect(await readLoopImplementationScope(paths, 'secure-login', scopeRef)).toEqual(scope);
    expect(await readLoopPartialAllowance(paths, 'secure-login', allowanceRef)).toEqual(allowance);
    expect(await readLoopVerificationEvidence(paths, 'secure-login', evidenceRef)).toEqual(
      evidence,
    );
  });

  it('rejects tampering and a ref whose filename does not match the content hash', async () => {
    const { bundle } = fixtures();
    const ref = await writeLoopImplementationScope({
      paths,
      name: 'secure-login',
      bundle,
    });
    const file = loopRuntimeRefFile(loopChangeRuntimeDir(paths, 'secure-login'), ref);
    const value = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    value.complete = true;
    await fs.writeFile(file, JSON.stringify(value));

    await expect(readLoopImplementationScope(paths, 'secure-login', ref)).rejects.toThrow(
      /unresolved scopes|content hash mismatch/iu,
    );
    await expect(
      readLoopImplementationScope(
        paths,
        'secure-login',
        `runtime/evidence/scopes/${'f'.repeat(64)}.json`,
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a deeply invalid document even when its content address is refreshed', async () => {
    const { scope } = fixtures();
    const malformed = structuredClone(scope) as typeof scope & {
      changes: Array<(typeof scope.changes)[number] & { after: { trusted?: boolean } }>;
    };
    malformed.changes[0].after!.trusted = true;
    const content = { ...malformed } as Partial<typeof malformed>;
    delete content.scopeHash;
    malformed.scopeHash = canonicalHash(LOOP_IMPLEMENTATION_SCOPE_SCHEMA, content);
    const ref = `runtime/evidence/scopes/${malformed.scopeHash}.json`;
    const file = loopRuntimeRefFile(loopChangeRuntimeDir(paths, 'secure-login'), ref);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(malformed));

    await expect(readLoopImplementationScope(paths, 'secure-login', ref)).rejects.toThrow(
      'unknown field',
    );
  });

  it('rebuilds persisted snapshot omissions instead of trusting a self-rehashed scope', async () => {
    const { contract } = fixtures();
    const baseline = {
      ...snapshot([]),
      complete: false,
      omitted: [
        { path: 'secret.ts', size: 1, type: 'file' as const, reason: 'file-size' as const },
      ],
      omittedCount: 1,
    };
    const bundle = buildLoopImplementationScopeBundle({
      baseline,
      current: snapshot([]),
      contractHash: contract.contractHash,
      declaredArtifacts: [],
      noCodeReason: 'No visible content changed.',
    });
    await writeLoopImplementationScope({ paths, name: 'secure-login', bundle });

    const forged = structuredClone(bundle.scope);
    forged.complete = true;
    forged.unresolvedScopes = [];
    const content = { ...forged } as Partial<typeof forged>;
    delete content.scopeHash;
    forged.scopeHash = canonicalHash(LOOP_IMPLEMENTATION_SCOPE_SCHEMA, content);
    const ref = `runtime/evidence/scopes/${forged.scopeHash}.json`;
    const file = loopRuntimeRefFile(loopChangeRuntimeDir(paths, 'secure-login'), ref);
    await fs.writeFile(file, JSON.stringify(forged));

    await expect(readLoopImplementationScope(paths, 'secure-login', ref)).rejects.toThrow(
      'does not match its authoritative bundle',
    );
  });

  it('does not persist a caller-rewritten scope outside its build authority', async () => {
    const { bundle } = fixtures();
    const forged = structuredClone(bundle);
    const declaration = { path: 'src/login.ts', kind: 'file' as const };
    forged.scope.declaredArtifacts = [declaration];
    forged.scope.changes[0].attributedTo = [declaration];
    forged.scope.unattributed = [];
    forged.scope.unresolvedScopes = [];
    forged.scope.complete = true;
    const content = { ...forged.scope } as Partial<typeof forged.scope>;
    delete content.scopeHash;
    forged.scope.scopeHash = canonicalHash(LOOP_IMPLEMENTATION_SCOPE_SCHEMA, content);

    await expect(
      writeLoopImplementationScope({ paths, name: 'secure-login', bundle: forged }),
    ).rejects.toThrow('does not match its authoritative bundle');
    const file = loopRuntimeRefFile(
      loopChangeRuntimeDir(paths, 'secure-login'),
      `runtime/evidence/scopes/${forged.scope.scopeHash}.json`,
    );
    await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects snapshot projection content tampering and ref/hash rebinding', async () => {
    const { bundle } = fixtures();
    await writeLoopImplementationScope({ paths, name: 'secure-login', bundle });
    const baselineFile = loopRuntimeRefFile(
      loopChangeRuntimeDir(paths, 'secure-login'),
      bundle.scope.baselineProjectionRef,
    );
    await fs.writeFile(baselineFile, JSON.stringify(bundle.current));
    await expect(
      readLoopImplementationScope(
        paths,
        'secure-login',
        `runtime/evidence/scopes/${bundle.scope.scopeHash}.json`,
      ),
    ).rejects.toThrow('content hash mismatch');

    await fs.writeFile(baselineFile, JSON.stringify(bundle.baseline));
    const rebound = structuredClone(bundle.scope);
    rebound.baselineProjectionRef = rebound.currentProjectionRef;
    rebound.baselineProjectionHash = rebound.currentProjectionHash;
    const reboundContent = { ...rebound } as Partial<typeof rebound>;
    delete reboundContent.scopeHash;
    rebound.scopeHash = canonicalHash(LOOP_IMPLEMENTATION_SCOPE_SCHEMA, reboundContent);
    const reboundRef = `runtime/evidence/scopes/${rebound.scopeHash}.json`;
    const reboundFile = loopRuntimeRefFile(loopChangeRuntimeDir(paths, 'secure-login'), reboundRef);
    await fs.writeFile(reboundFile, JSON.stringify(rebound));

    await expect(readLoopImplementationScope(paths, 'secure-login', reboundRef)).rejects.toThrow(
      'does not match its authoritative bundle',
    );
  });

  it('drops oversized Git-only advisory detail before returning a persistable scope', async () => {
    const { contract } = fixtures();
    const largeBundle = buildLoopImplementationScopeBundle({
      baseline: snapshot([]),
      current: snapshot([{ path: 'src/login.ts', hash: 'a'.repeat(64), size: 10, type: 'file' }]),
      contractHash: contract.contractHash,
      declaredArtifacts: [{ path: 'src/login.ts', kind: 'file' }],
      gitChangedPaths: Array.from(
        { length: 15_000 },
        (_, index) => `external/${String(index).padStart(5, '0')}-${'x'.repeat(32)}.ts`,
      ),
    });
    const { scope: largeScope } = largeBundle;
    expect(serializedBytes(largeScope)).toBeLessThanOrEqual(MAX_LOOP_EVIDENCE_DOCUMENT_BYTES);
    expect(largeScope.gitAdvisory).toBeUndefined();

    await expect(
      writeLoopImplementationScope({ paths, name: 'secure-login', bundle: largeBundle }),
    ).resolves.toMatch(/^runtime\/evidence\/scopes\//u);
    const file = loopRuntimeRefFile(
      loopChangeRuntimeDir(paths, 'secure-login'),
      `runtime/evidence/scopes/${largeScope.scopeHash}.json`,
    );
    await expect(fs.lstat(file)).resolves.toMatchObject({ isFile: expect.any(Function) });
  });

  it('persists a scope whose oversized derived change set is represented by bounded overflow evidence', async () => {
    const { contract } = fixtures();
    const entries = Array.from({ length: 2_000 }, (_, index) => ({
      path: `generated/${String(index).padStart(5, '0')}-${'x'.repeat(80)}.ts`,
      hash: 'a'.repeat(64),
      size: 1,
      type: 'file' as const,
    }));
    const largeSnapshot: LoopContentSnapshotManifest = {
      ...snapshot([]),
      limits: {
        maxFiles: 3_000,
        maxFileBytes: 1_024,
        maxTotalBytes: 10_000,
        maxManifestBytes: MAX_LOOP_EVIDENCE_DOCUMENT_BYTES,
      },
      entries,
    };
    const bundle = buildLoopImplementationScopeBundle({
      baseline: snapshot([]),
      current: largeSnapshot,
      contractHash: contract.contractHash,
      declaredArtifacts: [],
    });

    expect(bundle.scope.unresolvedScopes).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'scope-detail-overflow' })]),
    );
    const ref = await writeLoopImplementationScope({
      paths,
      name: 'secure-login',
      bundle,
    });
    await expect(readLoopImplementationScope(paths, 'secure-login', ref)).resolves.toEqual(
      bundle.scope,
    );
  });

  it('retains snapshot incompleteness when the source projection cannot retain ten thousand files', async () => {
    const { contract } = fixtures();
    const segments = Array.from({ length: 128 }, () => 'a');
    const artifactPaths = segments.map((_, index) => segments.slice(0, index + 1).join('/'));
    const generatedRoot = artifactPaths.at(-1)!;
    const entries = Array.from({ length: 10_000 }, (_, index) => ({
      path: `${generatedRoot}/${String(index).padStart(5, '0')}.ts`,
      hash: 'a'.repeat(64),
      size: 1,
      type: 'file' as const,
    }));
    const current: LoopContentSnapshotManifest = {
      ...snapshot([]),
      limits: {
        maxFiles: 10_000,
        maxFileBytes: 1_024,
        maxTotalBytes: 20_000,
        maxManifestBytes: 8 * 1024 * 1024,
      },
      entries,
    };
    const bundle = buildLoopImplementationScopeBundle({
      baseline: snapshot([]),
      current,
      contractHash: contract.contractHash,
      declaredArtifacts: artifactPaths.map((artifactPath) => ({
        path: artifactPath,
        kind: 'directory' as const,
      })),
    });

    expect(bundle.scope.changes.length).toBeGreaterThan(0);
    expect(bundle.scope.changes.length).toBeLessThan(128);
    expect(bundle.scope.changes[0]?.attributedTo).toHaveLength(128);
    expect(bundle.scope.unresolvedScopes).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'snapshot-incomplete' })]),
    );
    expect(
      [bundle.baseline, bundle.current, bundle.scope].every(
        (document) => serializedBytes(document) <= MAX_LOOP_EVIDENCE_DOCUMENT_BYTES,
      ),
    ).toBe(true);

    const ref = await writeLoopImplementationScope({ paths, name: 'secure-login', bundle });
    await expect(readLoopImplementationScope(paths, 'secure-login', ref)).resolves.toEqual(
      bundle.scope,
    );
  });

  it('persists one huge unattributed change entirely as scope overflow', async () => {
    const { contract } = fixtures();
    const hugePath = `generated/${'x'.repeat(400_000)}.ts`;
    const current: LoopContentSnapshotManifest = {
      ...snapshot([]),
      limits: {
        maxFiles: 10,
        maxFileBytes: 1_024,
        maxTotalBytes: 10_000,
        maxManifestBytes: 8 * 1024 * 1024,
      },
      entries: [{ path: hugePath, hash: 'a'.repeat(64), size: 1, type: 'file' }],
    };
    const bundle = buildLoopImplementationScopeBundle({
      baseline: snapshot([]),
      current,
      contractHash: contract.contractHash,
      declaredArtifacts: [],
    });

    expect(bundle.scope.changes).toEqual([]);
    expect(bundle.scope.unattributed).toEqual([]);
    expect(bundle.scope.unresolvedScopes).toEqual([
      expect.objectContaining({
        kind: 'scope-detail-overflow',
        reason: expect.stringContaining('1 additional change details'),
      }),
    ]);
    expect(serializedBytes(bundle.scope)).toBeLessThanOrEqual(MAX_LOOP_EVIDENCE_DOCUMENT_BYTES);

    const ref = await writeLoopImplementationScope({ paths, name: 'secure-login', bundle });
    await expect(readLoopImplementationScope(paths, 'secure-login', ref)).resolves.toEqual(
      bundle.scope,
    );
  });

  it('fits each snapshot projection to one megabyte before writing', async () => {
    const { contract } = fixtures();
    const entries = Array.from({ length: 6_500 }, (_, index) => ({
      path: `src/generated/${String(index).padStart(5, '0')}-${'x'.repeat(32)}.ts`,
      hash: 'a'.repeat(64),
      size: 1,
      type: 'file' as const,
    }));
    const largeSnapshot: LoopContentSnapshotManifest = {
      ...snapshot([]),
      limits: {
        maxFiles: 7_000,
        maxFileBytes: 1_024,
        maxTotalBytes: 10_000,
        maxManifestBytes: 4 * 1024 * 1024,
      },
      entries,
    };
    const bundle = buildLoopImplementationScopeBundle({
      baseline: largeSnapshot,
      current: { ...largeSnapshot, createdAt: '2026-07-18T00:00:00.000Z' },
      contractHash: contract.contractHash,
      declaredArtifacts: [],
      noCodeReason: 'Generated tree is unchanged.',
    });
    expect(serializedBytes(bundle.baseline)).toBeLessThanOrEqual(MAX_LOOP_EVIDENCE_DOCUMENT_BYTES);
    expect(bundle.baseline.omissionOverflow).toEqual(
      expect.objectContaining({
        count: expect.any(Number),
        hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    );

    const ref = await writeLoopImplementationScope({
      paths,
      name: 'secure-login',
      bundle,
    });
    await expect(readLoopImplementationScope(paths, 'secure-login', ref)).resolves.toEqual(
      bundle.scope,
    );
    const file = loopRuntimeRefFile(
      loopChangeRuntimeDir(paths, 'secure-login'),
      bundle.scope.baselineProjectionRef,
    );
    await expect(fs.lstat(file)).resolves.toMatchObject({ isFile: expect.any(Function) });
  });

  it('persists bounded documents even when the transient authority bundle exceeds three megabytes', async () => {
    const { contract } = fixtures();
    const entries = Array.from({ length: 4_000 }, (_, index) => ({
      path: `src/generated/${String(index).padStart(5, '0')}-${'x'.repeat(36)}.ts`,
      hash: 'a'.repeat(64),
      size: 1,
      type: 'file' as const,
    }));
    const denseSnapshot: LoopContentSnapshotManifest = {
      ...snapshot(entries),
      limits: {
        maxFiles: 10_000,
        maxFileBytes: 1_024,
        maxTotalBytes: 16 * 1024 * 1024,
        maxManifestBytes: MAX_LOOP_EVIDENCE_DOCUMENT_BYTES,
      },
    };
    const bundle = buildLoopImplementationScopeBundle({
      baseline: denseSnapshot,
      current: { ...denseSnapshot, createdAt: '2026-07-18T00:00:00.000Z' },
      contractHash: contract.contractHash,
      declaredArtifacts: [],
      noCodeReason: 'Generated tree is unchanged.',
      gitChangedPaths: Array.from(
        { length: 7_700 },
        (_, index) => `outside/${String(index).padStart(5, '0')}-${'y'.repeat(40)}.ts`,
      ),
    });
    const documentSizes = [bundle.baseline, bundle.current, bundle.scope].map(serializedBytes);
    expect(
      documentSizes.every((size) => size <= MAX_LOOP_EVIDENCE_DOCUMENT_BYTES),
      `document sizes: ${documentSizes.join(', ')}`,
    ).toBe(true);
    expect(serializedBytes(bundle)).toBeGreaterThan(3 * MAX_LOOP_EVIDENCE_DOCUMENT_BYTES);

    const ref = await writeLoopImplementationScope({ paths, name: 'secure-login', bundle });
    await expect(readLoopImplementationScope(paths, 'secure-login', ref)).resolves.toEqual(
      bundle.scope,
    );
  });

  it('detects replacement of an evidence parent after its identity is captured', async () => {
    const { bundle } = fixtures();
    const ref = await writeLoopImplementationScope({
      paths,
      name: 'secure-login',
      bundle,
    });
    const file = loopRuntimeRefFile(loopChangeRuntimeDir(paths, 'secure-login'), ref);
    const parent = path.dirname(file);
    const displaced = `${parent}-displaced`;
    const original = await fs.readFile(file, 'utf8');

    await expect(
      readLoopImplementationScope(paths, 'secure-login', ref, {
        afterParentChainCaptured: async () => {
          await fs.rename(parent, displaced);
          await fs.mkdir(parent);
          await fs.writeFile(path.join(parent, path.basename(file)), original);
        },
      }),
    ).rejects.toThrow('parent changed');
  });

  it.runIf(process.platform === 'win32')(
    'rejects a junction in the evidence parent chain',
    async () => {
      const { bundle } = fixtures();
      const evidenceRoot = path.join(loopChangeRuntimeDir(paths, 'secure-login'), 'evidence');
      const redirected = path.join(paths.specsDir, 'redirected-evidence');
      await fs.mkdir(redirected, { recursive: true });
      await fs.mkdir(path.dirname(evidenceRoot), { recursive: true });
      await fs.symlink(redirected, evidenceRoot, 'junction');

      await expect(
        writeLoopImplementationScope({ paths, name: 'secure-login', bundle }),
      ).rejects.toThrow(/outside|real directory|symlink/iu);
      await expect(fs.readdir(redirected)).resolves.toEqual([]);
    },
  );

  it.runIf(process.platform === 'win32')(
    'does not trust an idempotent write through a replacement junction',
    async () => {
      const { bundle } = fixtures();
      const ref = await writeLoopImplementationScope({
        paths,
        name: 'secure-login',
        bundle,
      });
      const runtimeRoot = loopChangeRuntimeDir(paths, 'secure-login');
      const evidenceRoot = path.join(runtimeRoot, 'evidence');
      const displaced = path.join(runtimeRoot, 'evidence-displaced');
      const redirected = path.join(paths.specsDir, 'redirected-existing-evidence');
      await fs.rename(evidenceRoot, displaced);
      await fs.mkdir(redirected, { recursive: true });
      const redirectedFile = path.join(redirected, ...ref.split('/').slice(2));
      await fs.mkdir(path.dirname(redirectedFile), { recursive: true });
      await fs.copyFile(path.join(displaced, ...ref.split('/').slice(2)), redirectedFile);
      await fs.symlink(redirected, evidenceRoot, 'junction');

      await expect(
        writeLoopImplementationScope({ paths, name: 'secure-login', bundle }),
      ).rejects.toThrow(/outside|symlink|real directory/iu);
    },
  );

  it('round-trips report snapshots and bounds their content-addressed refs', async () => {
    const text = 'Verification passed.';
    const hash = createHash('sha256').update(text).digest('hex');
    await expect(
      writeLoopVerificationReportSnapshot({ paths, name: 'secure-login', hash, text }),
    ).resolves.toBe(loopEvidenceRef('reports', hash));
    await expect(readLoopVerificationReportSnapshot(paths, 'secure-login', hash)).resolves.toBe(
      text,
    );
    await expect(
      writeLoopVerificationReportSnapshot({
        paths,
        name: 'secure-login',
        hash: 'f'.repeat(64),
        text,
      }),
    ).rejects.toThrow(/hash or size/u);
    await expect(
      writeLoopVerificationReportSnapshot({
        paths,
        name: 'secure-login',
        hash: createHash('sha256')
          .update('x'.repeat(MAX_LOOP_EVIDENCE_DOCUMENT_BYTES + 1))
          .digest('hex'),
        text: 'x'.repeat(MAX_LOOP_EVIDENCE_DOCUMENT_BYTES + 1),
      }),
    ).rejects.toThrow(/hash or size/u);
    await expect(readLoopVerificationReportSnapshot(paths, 'secure-login', 'bad')).rejects.toThrow(
      /hash is invalid/u,
    );
  });

  it('lists only valid typed receipt filenames and returns an empty missing directory', async () => {
    expect(await listLoopVerificationReceiptRefs(paths, 'secure-login')).toEqual([]);
    const directory = path.join(
      loopChangeRuntimeDir(paths, 'secure-login'),
      'evidence',
      'receipts',
    );
    await fs.mkdir(directory, { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(directory, `${'b'.repeat(64)}.json`), '{}'),
      fs.writeFile(path.join(directory, `${'a'.repeat(64)}.json`), '{}'),
      fs.writeFile(path.join(directory, 'not-a-receipt.txt'), '{}'),
      fs.mkdir(path.join(directory, `${'c'.repeat(64)}.json`)),
    ]);
    await expect(listLoopVerificationReceiptRefs(paths, 'secure-login')).resolves.toEqual([
      loopEvidenceRef('receipts', 'a'.repeat(64)),
      loopEvidenceRef('receipts', 'b'.repeat(64)),
    ]);
  });

  it('reads legacy archived acceptance counters and validates their envelope', async () => {
    const hash = 'a'.repeat(64);
    const archiveDir = path.join(paths.archiveDir, '2026-08-12-secure-login');
    const file = path.join(archiveDir, 'runtime', 'evidence', 'verifications', `${hash}.json`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({
        schema: 'owner.loop.verification-evidence.v1',
        change: 'secure-login',
        envelopeHash: hash,
        acceptanceTrace: {
          schema: 'owner.loop.acceptance-trace.v1',
          total: 3,
          evidenced: 2,
          skipped: 1,
        },
      }),
    );
    await expect(
      readArchivedLoopVerificationAcceptanceCounts(
        paths,
        'secure-login',
        `runtime/evidence/verifications/${hash}.json`,
        archiveDir,
      ),
    ).resolves.toEqual({ total: 3, evidenced: 2, skipped: 1 });

    await fs.writeFile(
      file,
      JSON.stringify({
        schema: 'owner.loop.verification-evidence.v1',
        change: 'other-change',
        envelopeHash: hash,
        acceptanceTrace: {
          schema: 'owner.loop.acceptance-trace.v1',
          total: 1,
          evidenced: 1,
          skipped: 0,
        },
      }),
    );
    await expect(
      readArchivedLoopVerificationAcceptanceCounts(
        paths,
        'secure-login',
        `runtime/evidence/verifications/${hash}.json`,
        archiveDir,
      ),
    ).rejects.toThrow(/change mismatch/u);
  });
});
