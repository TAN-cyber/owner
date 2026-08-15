import { describe, expect, it } from 'vitest';

import {
  buildLoopArchivePreflight,
  type LoopArchivePreflightInput,
} from '../../../domains/owner-loop/loop-archive-preflight.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const D = 'd'.repeat(64);
const E = 'e'.repeat(64);

function input(): LoopArchivePreflightInput {
  return {
    change: 'secure-login',
    archiveConfirmation: 'automatic',
    stateSchema: 'owner.loop.v3',
    revision: 5,
    phase: 'archive',
    archived: false,
    pendingJournal: false,
    targetRef: 'archive/2026-07-17-secure-login',
    targetExists: false,
    specs: [
      {
        capability: 'authentication',
        operation: 'replace',
        expectedBaseHash: A,
        actualBaseHash: A,
        proposedHash: B,
      },
    ],
    evidence: {
      result: 'pass',
      freshness: 'complete',
      contractHash: A,
      acceptanceHash: B,
      implementationScopeHash: C,
      reportHash: D,
      envelopeHash: E,
      partialAllowanceHash: null,
      skippedAcceptanceCount: 0,
    },
  };
}

describe('Loop Archive preflight', () => {
  it('is deterministic across spec order and previews the exact content-bound operations', () => {
    const original = input();
    original.specs = [
      ...original.specs,
      {
        capability: 'sessions',
        operation: 'create',
        expectedBaseHash: null,
        actualBaseHash: null,
        proposedHash: C,
      },
    ];
    const first = buildLoopArchivePreflight(original);
    const reordered = buildLoopArchivePreflight({
      ...original,
      specs: [...original.specs].reverse(),
    });

    expect(reordered).toEqual(first);
    expect(first).toMatchObject({ ready: true, operationCount: 2, findingCodes: [] });
    expect(first.operations.map(({ capability }) => capability)).toEqual([
      'authentication',
      'sessions',
    ]);
    expect(first.preflightHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each([
    ['revision', (value: LoopArchivePreflightInput) => (value.revision += 1)],
    [
      'archive confirmation',
      (value: LoopArchivePreflightInput) => (value.archiveConfirmation = 'required'),
    ],
    ['target', (value: LoopArchivePreflightInput) => (value.targetRef += '-next')],
    ['target existence', (value: LoopArchivePreflightInput) => (value.targetExists = true)],
    ['base', (value: LoopArchivePreflightInput) => (value.specs[0].actualBaseHash = C)],
    ['proposal', (value: LoopArchivePreflightInput) => (value.specs[0].proposedHash = C)],
    ['contract', (value: LoopArchivePreflightInput) => (value.evidence.contractHash = C)],
    ['scope', (value: LoopArchivePreflightInput) => (value.evidence.implementationScopeHash = D)],
    ['report', (value: LoopArchivePreflightInput) => (value.evidence.reportHash = E)],
    ['envelope', (value: LoopArchivePreflightInput) => (value.evidence.envelopeHash = A)],
    [
      'workspace finish',
      (value: LoopArchivePreflightInput) => {
        value.workspace = {
          schema: 'owner.loop.workspace.v3',
          isolation: 'branch',
          changeBranch: 'owner/secure-login',
          targetBranch: 'main',
          finish: 'merge',
        };
      },
    ],
  ])('changes the preflight hash when %s changes', (_label, mutate) => {
    const baseline = buildLoopArchivePreflight(input());
    const changed = input();
    mutate(changed);
    expect(buildLoopArchivePreflight(changed).preflightHash).not.toBe(baseline.preflightHash);
  });

  it('blocks stale evidence, canonical drift, a pending journal, or an existing target', () => {
    const changed = input();
    changed.pendingJournal = true;
    changed.targetExists = true;
    changed.specs[0].actualBaseHash = C;
    changed.evidence.freshness = 'stale';
    const result = buildLoopArchivePreflight(changed);

    expect(result.ready).toBe(false);
    expect(result.findingCodes).toEqual([
      'archive-target-exists',
      'pending-journal',
      'spec-base-conflict',
      'verification-evidence-stale',
    ]);
  });

  it('accepts partial evidence only when it binds an exact allowance hash', () => {
    const partial = input();
    partial.evidence.freshness = 'partial';
    partial.evidence.partialAllowanceHash = A;
    expect(buildLoopArchivePreflight(partial)).toMatchObject({
      ready: true,
      evidenceFreshness: 'partial',
    });

    partial.evidence.partialAllowanceHash = null;
    expect(() => buildLoopArchivePreflight(partial)).toThrow('allowance state');
  });

  it('blocks Archive when the accepted evidence still contains a skipped criterion', () => {
    const skipped = input();
    skipped.evidence.skippedAcceptanceCount = 1;

    expect(buildLoopArchivePreflight(skipped)).toMatchObject({
      ready: false,
      findingCodes: ['verification-acceptance-skipped'],
    });
  });

  it('rejects unsafe target refs and malformed operation/base combinations', () => {
    expect(() => buildLoopArchivePreflight({ ...input(), targetRef: 'C:/archive/escape' })).toThrow(
      'Loop-relative',
    );
    const invalid = input();
    invalid.specs[0] = {
      capability: 'authentication',
      operation: 'create',
      expectedBaseHash: A,
      actualBaseHash: null,
      proposedHash: B,
    };
    expect(() => buildLoopArchivePreflight(invalid)).toThrow('expect no canonical base');
  });
});
