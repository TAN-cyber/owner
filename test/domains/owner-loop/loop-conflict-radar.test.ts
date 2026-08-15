import { describe, expect, it } from 'vitest';

import {
  buildLoopConflictRadar,
  LOOP_CONFLICT_RADAR_LIMITS,
  type LoopConflictRadarChangeInput,
} from '../../../domains/owner-loop/loop-conflict-radar.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const W1 = '1'.repeat(64);
const W2 = '2'.repeat(64);

function change(
  name: string,
  options: Partial<Omit<LoopConflictRadarChangeInput, 'name'>> = {},
): LoopConflictRadarChangeInput {
  return {
    name,
    revision: options.revision ?? 1,
    specs: options.specs ?? [],
    declaredArtifacts: options.declaredArtifacts ?? [],
    ...(options.workspaceIdentityHash !== undefined
      ? { workspaceIdentityHash: options.workspaceIdentityHash }
      : {}),
  };
}

function replace(capability: string, baseHash = A) {
  return { capability, operation: 'replace' as const, baseHash };
}

describe('Loop multi-change conflict radar', () => {
  it('classifies a shared canonical base as definite and divergent bases as possible', () => {
    const definite = buildLoopConflictRadar([
      change('alpha', { specs: [replace('authentication')] }),
      change('beta', { specs: [replace('authentication')] }),
    ]);
    expect(definite.relationships[0]).toMatchObject({
      classification: 'definite-conflict',
      signals: [
        {
          kind: 'capability',
          certainty: 'definite-conflict',
          capability: 'authentication',
          leftBaseHash: A,
          rightBaseHash: A,
        },
      ],
    });

    const possible = buildLoopConflictRadar([
      change('alpha', { specs: [replace('authentication', A)] }),
      change('beta', { specs: [replace('authentication', B)] }),
    ]);
    expect(possible.relationships[0]).toMatchObject({
      classification: 'possible-overlap',
      signals: [{ kind: 'capability', certainty: 'possible-overlap' }],
    });
  });

  it('treats create collisions as definite even when the other change targets a canonical base', () => {
    const radar = buildLoopConflictRadar([
      change('creator', {
        specs: [{ capability: 'sessions', operation: 'create', baseHash: null }],
      }),
      change('replacer', { specs: [replace('sessions')] }),
    ]);

    expect(radar.relationships[0].classification).toBe('definite-conflict');
  });

  it('distinguishes exact file conflicts, broad directory overlap, and disjoint prefixes', () => {
    const exact = buildLoopConflictRadar([
      change('alpha', { declaredArtifacts: [{ path: 'src/auth.ts', kind: 'file' }] }),
      change('beta', { declaredArtifacts: [{ path: 'src/auth.ts', kind: 'file' }] }),
    ]);
    expect(exact.relationships[0]).toMatchObject({
      classification: 'definite-conflict',
      signals: [{ kind: 'artifact', certainty: 'definite-conflict' }],
    });

    const broad = buildLoopConflictRadar([
      change('alpha', { declaredArtifacts: [{ path: 'src', kind: 'directory' }] }),
      change('beta', { declaredArtifacts: [{ path: 'src/auth.ts', kind: 'file' }] }),
    ]);
    expect(broad.relationships[0]).toMatchObject({
      classification: 'possible-overlap',
      signals: [{ kind: 'artifact', certainty: 'possible-overlap' }],
    });

    const disjoint = buildLoopConflictRadar([
      change('alpha', { declaredArtifacts: [{ path: 'src', kind: 'directory' }] }),
      change('beta', { declaredArtifacts: [{ path: 'src-other/auth.ts', kind: 'file' }] }),
    ]);
    expect(disjoint.relationships[0]).toMatchObject({
      classification: 'disjoint',
      signalCount: 0,
      signals: [],
    });
  });

  it('normalizes ordering and produces the same full-fact hash for reordered inputs', () => {
    const first = buildLoopConflictRadar([
      change('zeta', {
        revision: 4,
        specs: [replace('zeta-capability'), replace('shared-capability')],
        declaredArtifacts: [
          { path: 'src/zeta.ts', kind: 'file' },
          { path: 'src/shared.ts', kind: 'file' },
        ],
      }),
      change('alpha', {
        revision: 2,
        specs: [replace('shared-capability'), replace('alpha-capability')],
        declaredArtifacts: [
          { path: 'src/shared.ts', kind: 'file' },
          { path: 'src/alpha.ts', kind: 'file' },
        ],
      }),
    ]);
    const reordered = buildLoopConflictRadar([
      change('alpha', {
        revision: 2,
        specs: [replace('alpha-capability'), replace('shared-capability')],
        declaredArtifacts: [
          { path: 'src/alpha.ts', kind: 'file' },
          { path: 'src/shared.ts', kind: 'file' },
        ],
      }),
      change('zeta', {
        revision: 4,
        specs: [replace('shared-capability'), replace('zeta-capability')],
        declaredArtifacts: [
          { path: 'src/shared.ts', kind: 'file' },
          { path: 'src/zeta.ts', kind: 'file' },
        ],
      }),
    ]);

    expect(reordered).toEqual(first);
    expect(first.radarHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.relationships[0].signals.map(({ kind }) => kind)).toEqual([
      'capability',
      'artifact',
    ]);
  });

  it('keeps workspace identity advisory and never exposes its hash', () => {
    const sameWorkspace = buildLoopConflictRadar([
      change('alpha', { specs: [replace('authentication')], workspaceIdentityHash: W1 }),
      change('beta', { specs: [replace('authentication')], workspaceIdentityHash: W1 }),
    ]);
    const differentWorkspace = buildLoopConflictRadar([
      change('alpha', { specs: [replace('authentication')], workspaceIdentityHash: W1 }),
      change('beta', { specs: [replace('authentication')], workspaceIdentityHash: W2 }),
    ]);

    expect(sameWorkspace.relationships[0].classification).toBe('definite-conflict');
    expect(differentWorkspace.relationships[0].classification).toBe('definite-conflict');
    expect(sameWorkspace.relationships[0].workspaceRelationship).toBe('same');
    expect(differentWorkspace.relationships[0].workspaceRelationship).toBe('different');
    expect(sameWorkspace.workspaceIdentityAdvisoryOnly).toBe(true);
    expect(JSON.stringify(sameWorkspace)).not.toContain(W1);
    expect(JSON.stringify(differentWorkspace)).not.toContain(W2);
  });

  it('caps relationship details and serialized output while hashing all pairs', () => {
    const changes = Array.from({ length: 24 }, (_, index) =>
      change(`change-${String(index).padStart(2, '0')}`),
    );
    const radar = buildLoopConflictRadar(changes);

    expect(radar.relationshipCount).toBe((24 * 23) / 2);
    expect(radar.relationships.length).toBeLessThanOrEqual(
      LOOP_CONFLICT_RADAR_LIMITS.maxRelationships,
    );
    expect(radar.relationshipsTruncated).toBe(true);
    expect(radar.omittedRelationshipCount).toBe(
      radar.relationshipCount - radar.relationships.length,
    );
    expect(Buffer.byteLength(JSON.stringify(radar), 'utf8')).toBeLessThanOrEqual(
      LOOP_CONFLICT_RADAR_LIMITS.maxSerializedBytes,
    );
  });

  it('caps per-pair evidence without losing the full signal count or hash', () => {
    const artifacts = Array.from({ length: 12 }, (_, index) => ({
      path: `src/shared-${String(index).padStart(2, '0')}.ts`,
      kind: 'file' as const,
    }));
    const radar = buildLoopConflictRadar([
      change('alpha', { declaredArtifacts: artifacts }),
      change('beta', { declaredArtifacts: [...artifacts].reverse() }),
    ]);
    const relation = radar.relationships[0];

    expect(relation.signalCount).toBe(12);
    expect(relation.signals).toHaveLength(LOOP_CONFLICT_RADAR_LIMITS.maxSignalsPerRelationship);
    expect(relation.signalsTruncated).toBe(true);
    expect(relation.signalHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each([
    '/absolute/file.ts',
    'C:/absolute/file.ts',
    '../outside.ts',
    'src/../outside.ts',
    'src\\windows.ts',
    '//server/share.ts',
    'src/trailing/',
  ])('rejects unsafe artifact path %s so output cannot contain absolute paths', (artifactPath) => {
    expect(() =>
      buildLoopConflictRadar([
        change('alpha', { declaredArtifacts: [{ path: artifactPath, kind: 'file' }] }),
      ]),
    ).toThrow('project-relative path');
  });

  it('fails closed on malformed hashes, operation/base pairs, duplicates, and input overflow', () => {
    expect(() =>
      buildLoopConflictRadar([
        change('alpha', {
          specs: [{ capability: 'authentication', operation: 'replace', baseHash: null }],
        }),
      ]),
    ).toThrow('requires a canonical base hash');
    expect(() =>
      buildLoopConflictRadar([
        change('alpha', {
          specs: [{ capability: 'authentication', operation: 'create', baseHash: A }],
        }),
      ]),
    ).toThrow('requires a null canonical base hash');
    expect(() =>
      buildLoopConflictRadar([change('alpha', { workspaceIdentityHash: 'not-a-hash' })]),
    ).toThrow('workspace identity hash');
    expect(() => buildLoopConflictRadar([change('alpha'), change('alpha')])).toThrow(
      'duplicate change names',
    );
    expect(() =>
      buildLoopConflictRadar([
        change('alpha', { specs: [replace('authentication'), replace('authentication')] }),
      ]),
    ).toThrow('duplicate capabilities');
    expect(() =>
      buildLoopConflictRadar([
        change('alpha', {
          declaredArtifacts: [
            { path: 'src/auth.ts', kind: 'file' },
            { path: 'src/auth.ts', kind: 'directory' },
          ],
        }),
      ]),
    ).toThrow('duplicate or conflicting artifact paths');
    expect(() =>
      buildLoopConflictRadar(
        Array.from({ length: LOOP_CONFLICT_RADAR_LIMITS.maxChanges + 1 }, (_, index) =>
          change(`overflow-${index}`),
        ),
      ),
    ).toThrow('change budget');
  });

  it.each([
    ['change', [{ ...change('alpha'), secret: 'must-not-be-ignored' }]],
    [
      'spec',
      [
        change('alpha', {
          specs: [{ ...replace('authentication'), secret: 'must-not-be-ignored' }],
        }),
      ],
    ],
    [
      'artifact',
      [
        change('alpha', {
          declaredArtifacts: [{ path: 'src/auth.ts', kind: 'file', secret: 'must-not-be-ignored' }],
        }),
      ],
    ],
  ])('rejects unknown %s fields instead of silently dropping untrusted input', (_label, input) => {
    expect(() => buildLoopConflictRadar(input as LoopConflictRadarChangeInput[])).toThrow(
      'unknown field',
    );
  });
});
