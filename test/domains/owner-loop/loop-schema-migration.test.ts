import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { stringify } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { archiveLoopChange } from '../../../domains/owner-loop/loop-archive.js';
import { inspectLoopArchivePreflight } from '../../../domains/owner-loop/loop-archive-inspection.js';
import {
  compareAndSwapLoopChange,
  createLoopChange,
  LoopRuntimeCompatibilityError,
  LoopSchemaMigrationRequiredError,
  loopChangeDir,
  readLoopChange,
  readLoopChangeFile,
} from '../../../domains/owner-loop/loop-change.js';
import { runLoopCli } from '../../../domains/owner-loop/loop-cli.js';
import {
  defaultProjectConfig,
  writeProjectConfig,
} from '../../../domains/owner-loop/loop-config.js';
import { inspectLoopStatus } from '../../../domains/owner-loop/loop-diagnostics.js';
import { doctorLoopProject } from '../../../domains/owner-loop/loop-doctor.js';
import { loopChangeRuntimeDir, loopProjectPaths } from '../../../domains/owner-loop/loop-paths.js';
import {
  readLoopCheckpoint as readCheckpoint,
  readLoopRunState as readRunStateAt,
  readLoopTrajectory as readTrajectory,
} from '../../../domains/owner-loop/loop-run-store.js';
import {
  inspectPendingLoopSchemaMigration,
  migrateLoopChange,
  loopSchemaMigrationJournalFile,
} from '../../../domains/owner-loop/loop-schema-migration.js';
import {
  loopBaselineManifestFile,
  readLoopBaselineManifest,
} from '../../../domains/owner-loop/loop-snapshot.js';
import {
  LOOP_CHANGE_SCHEMA,
  LOOP_LEGACY_CHANGE_SCHEMA,
  LOOP_RUNTIME_PROTOCOL_VERSION,
  LOOP_V2_CHANGE_SCHEMA,
  type LoopChangeState,
  type LoopPhase,
  type LoopProjectPaths,
  type LoopSchemaMigrationHooks,
} from '../../../domains/owner-loop/loop-types.js';
import { advanceLoopChange } from '../../helpers/loop-confirmed-transition.js';
import { loopVerificationFixtureReport } from '../../helpers/loop-verification.js';

function legacyDocument(state: LoopChangeState): Record<string, unknown> {
  const fields: Record<string, unknown> = { ...state };
  delete fields.verification_protocol;
  delete fields.minimum_runtime_version;
  delete fields.revision;
  delete fields.approved_contract_hash;
  delete fields.implementation_scope;
  delete fields.verification_evidence;
  delete fields.partial_allowance;
  return { ...fields, schema: LOOP_LEGACY_CHANGE_SCHEMA };
}

function v2Document(state: LoopChangeState): Record<string, unknown> {
  const fields: Record<string, unknown> = { ...state };
  delete fields.verification_protocol;
  delete fields.approved_contract_hash;
  delete fields.implementation_scope;
  delete fields.verification_evidence;
  delete fields.partial_allowance;
  return {
    ...fields,
    schema: LOOP_V2_CHANGE_SCHEMA,
    minimum_runtime_version: 2,
  };
}

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

describe('Loop schema compatibility and journalized migration', () => {
  let projectRoot: string;
  let paths: LoopProjectPaths;

  function runtimeDir(changeDir: string): string {
    return loopChangeRuntimeDir(paths, path.basename(changeDir));
  }

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-schema-'));
    paths = await loopProjectPaths(projectRoot, '.');
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  async function seedLegacyChange(name: string): Promise<string> {
    const state = await createLoopChange({
      paths,
      name,
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });
    const file = path.join(loopChangeDir(paths, name), 'owner-state.yaml');
    await fs.writeFile(file, stringify(legacyDocument(state)));
    await fs.rm(loopBaselineManifestFile(paths, name), { force: true });
    return file;
  }

  async function seedCurrentPhase(
    name: string,
    phase: LoopPhase,
  ): Promise<{ changeDir: string; state: LoopChangeState }> {
    const created = await createLoopChange({
      paths,
      name,
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });
    const changeDir = loopChangeDir(paths, created.name);
    await fs.writeFile(path.join(changeDir, 'brief.md'), brief);
    if (phase !== 'shape') {
      await advanceLoopChange({
        paths,
        name,
        evidence: { summary: 'shape is ready' },
        runId: () => `${name}-run`,
        now: new Date('2026-07-17T00:00:00.000Z'),
      });
    }
    if (phase === 'verify' || phase === 'archive') {
      await fs.writeFile(path.join(projectRoot, `${name}.ts`), 'export const ready = true;\n');
      await advanceLoopChange({
        paths,
        name,
        evidence: { summary: 'build is ready', artifacts: [`${name}.ts`] },
        now: new Date('2026-07-17T00:01:00.000Z'),
      });
    }
    if (phase === 'archive') {
      await fs.writeFile(
        path.join(changeDir, 'verification.md'),
        await loopVerificationFixtureReport({ paths, name, evidenceRefs: [`${name}.ts`] }),
      );
      await advanceLoopChange({
        paths,
        name,
        evidence: {
          summary: 'verification passed',
          verificationResult: 'pass',
          verificationReport: 'verification.md',
        },
        now: new Date('2026-07-17T00:02:00.000Z'),
      });
    }
    return { changeDir, state: await readLoopChange(paths, name) };
  }

  async function downgradeToV2(state: LoopChangeState): Promise<string> {
    const file = path.join(loopChangeDir(paths, state.name), 'owner-state.yaml');
    await fs.writeFile(file, stringify(v2Document(state)));
    return file;
  }

  it('projects a legacy change read-only and migrates it only during explicit doctor repair', async () => {
    const file = await seedLegacyChange('legacy-change');
    await writeProjectConfig(projectRoot, defaultProjectConfig('.'));
    const before = await fs.readFile(file, 'utf8');

    await expect(readLoopChange(paths, 'legacy-change')).rejects.toBeInstanceOf(
      LoopSchemaMigrationRequiredError,
    );
    expect(await inspectLoopStatus(paths, 'legacy-change')).toMatchObject({
      name: 'legacy-change',
      phase: 'shape',
      schema: LOOP_LEGACY_CHANGE_SCHEMA,
      migrationRequired: true,
      minimumRuntimeVersion: 1,
      nextCommand: null,
    });
    const shown = await runLoopCli([
      'show',
      'legacy-change',
      '--json',
      '--project-root',
      projectRoot,
    ]);
    expect(shown.exitCode).toBe(0);
    expect(JSON.parse(shown.stdout!)).toMatchObject({
      command: 'show',
      data: {
        name: 'legacy-change',
        schema: LOOP_LEGACY_CHANGE_SCHEMA,
        migrationRequired: true,
        minimumRuntimeVersion: 1,
      },
    });
    const inspected = await doctorLoopProject({ paths, name: 'legacy-change' });
    expect(inspected.findings).toContainEqual(
      expect.objectContaining({
        code: 'schema-migration-required',
        severity: 'error',
        repair: 'migrate',
      }),
    );
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect(await readLoopBaselineManifest(paths, 'legacy-change')).toBeNull();

    const repaired = await doctorLoopProject({
      paths,
      name: 'legacy-change',
      repair: true,
    });
    expect(repaired.findings).toContainEqual(
      expect.objectContaining({ code: 'schema-migrated', severity: 'info' }),
    );
    expect(await readLoopChange(paths, 'legacy-change')).toMatchObject({
      schema: LOOP_CHANGE_SCHEMA,
      minimum_runtime_version: LOOP_RUNTIME_PROTOCOL_VERSION,
      revision: 1,
    });
    expect(await readLoopBaselineManifest(paths, 'legacy-change')).toMatchObject({
      origin: 'legacy-migration',
    });
  });

  it('rejects an incomplete migration baseline before changing legacy state', async () => {
    const file = await seedLegacyChange('incomplete-migration-baseline');
    const originalState = await fs.readFile(file, 'utf8');
    await fs.writeFile(
      path.join(projectRoot, 'oversized-migration.bin'),
      Buffer.alloc(5 * 1024 * 1024 + 1, 0x61),
    );

    await expect(
      migrateLoopChange({ paths, name: 'incomplete-migration-baseline' }),
    ).rejects.toMatchObject({
      name: 'LoopBaselineIncompleteError',
      code: 'loop-baseline-incomplete',
      omittedCount: 1,
      samplePaths: ['oversized-migration.bin'],
    });
    await expect(fs.readFile(file, 'utf8')).resolves.toBe(originalState);
    await expect(
      readLoopBaselineManifest(paths, 'incomplete-migration-baseline'),
    ).resolves.toBeNull();
    await expect(
      inspectPendingLoopSchemaMigration(paths, 'incomplete-migration-baseline'),
    ).resolves.toMatchObject({ fromSchema: LOOP_LEGACY_CHANGE_SCHEMA });
  });

  it('projects a v2 change as migration-required in status and show without rewriting it', async () => {
    const { state } = await seedCurrentPhase('v2-visible', 'shape');
    const file = await downgradeToV2(state);
    await writeProjectConfig(projectRoot, defaultProjectConfig('.'));
    const before = await fs.readFile(file, 'utf8');

    await expect(readLoopChange(paths, state.name)).rejects.toBeInstanceOf(
      LoopSchemaMigrationRequiredError,
    );
    expect(await inspectLoopStatus(paths, state.name)).toMatchObject({
      name: state.name,
      phase: 'shape',
      revision: state.revision,
      schema: LOOP_V2_CHANGE_SCHEMA,
      migrationRequired: true,
      minimumRuntimeVersion: 2,
      nextCommand: null,
    });
    const shown = await runLoopCli(['show', state.name, '--json', '--project-root', projectRoot]);
    expect(shown.exitCode).toBe(0);
    expect(JSON.parse(shown.stdout!)).toMatchObject({
      data: {
        name: state.name,
        schema: LOOP_V2_CHANGE_SCHEMA,
        migrationRequired: true,
        minimumRuntimeVersion: 2,
      },
    });
    expect(await fs.readFile(file, 'utf8')).toBe(before);
  });

  it.each<LoopPhase>(['shape', 'build'])(
    'migrates a stable v2 %s state to v3 without changing its phase or revision',
    async (phase) => {
      const name = `v2-${phase}`;
      const { changeDir, state } = await seedCurrentPhase(name, phase);
      await downgradeToV2(state);

      const migrated = await migrateLoopChange({
        paths,
        name,
        now: new Date('2026-07-17T01:00:00.000Z'),
        id: () => `migration-${phase}`,
      });
      expect(migrated).toMatchObject({
        schema: LOOP_CHANGE_SCHEMA,
        minimum_runtime_version: LOOP_RUNTIME_PROTOCOL_VERSION,
        phase,
        revision: state.revision,
        implementation_scope: null,
        verification_evidence: null,
        partial_allowance: null,
      });
      if (phase !== 'shape') {
        expect(await readRunStateAt(runtimeDir(changeDir))).toMatchObject({
          runId: state.run_id,
          currentStep: phase,
        });
      }
      const status = await inspectLoopStatus(paths, name, { details: true });
      expect(status.phase).toBe(phase);
      expect((status.findings ?? []).map((finding) => finding.code)).not.toContain(
        'run-phase-mismatch',
      );
    },
  );

  it.each<LoopPhase>(['build', 'verify', 'archive'])(
    'migrates a stable v1 %s state through v2 without leaving Run/state phase drift',
    async (phase) => {
      const name = `v1-${phase}`;
      const { changeDir, state } = await seedCurrentPhase(name, phase);
      const file = path.join(changeDir, 'owner-state.yaml');
      await fs.writeFile(file, stringify(legacyDocument(state)));

      const migrated = await migrateLoopChange({
        paths,
        name,
        now: new Date('2026-07-17T01:30:00.000Z'),
        id: () => `migration-v1-${phase}`,
      });
      const evidencePhase = phase === 'verify' || phase === 'archive';
      expect(migrated).toMatchObject({
        schema: LOOP_CHANGE_SCHEMA,
        phase: evidencePhase ? 'build' : phase,
        revision: evidencePhase ? 2 : 1,
        implementation_scope: null,
        verification_evidence: null,
        partial_allowance: null,
      });
      if (evidencePhase) {
        expect(migrated).toMatchObject({
          verification_result: 'pending',
          verification_report: null,
        });
      }
      expect(await readRunStateAt(runtimeDir(changeDir))).toMatchObject({
        runId: state.run_id,
        currentStep: evidencePhase ? 'build' : phase,
      });
      const status = await inspectLoopStatus(paths, name, { details: true });
      expect((status.findings ?? []).map((finding) => finding.code)).not.toEqual(
        expect.arrayContaining(['run-phase-mismatch', 'checkpoint-mismatch']),
      );
    },
  );

  it('retreats a stable v2 Archive state to Build and synchronizes Run history exactly once', async () => {
    const name = 'v2-archive';
    const { changeDir, state } = await seedCurrentPhase(name, 'archive');
    await downgradeToV2(state);

    const migrated = await migrateLoopChange({
      paths,
      name,
      now: new Date('2026-07-17T02:00:00.000Z'),
      id: () => 'migration-archive',
    });
    expect(migrated).toMatchObject({
      schema: LOOP_CHANGE_SCHEMA,
      phase: 'build',
      revision: state.revision + 1,
      verification_result: 'pending',
      verification_report: null,
      implementation_scope: null,
      verification_evidence: null,
      partial_allowance: null,
      archived: false,
    });
    const run = (await readRunStateAt(runtimeDir(changeDir)))!;
    expect(run).toMatchObject({
      runId: state.run_id,
      currentStep: 'build',
      pending: null,
      status: 'running',
    });
    const trajectory = await readTrajectory(runtimeDir(changeDir), run.trajectoryRef);
    expect(
      trajectory.filter(
        (event) =>
          event.type === 'state_migrated' && event.data.migrationId === 'migration-archive',
      ),
    ).toHaveLength(1);
    expect(await readCheckpoint(runtimeDir(changeDir), run.checkpointRef)).toMatchObject({
      runId: run.runId,
      stateVersion: run.iteration,
      trajectoryOffset: trajectory.length,
    });

    const status = await inspectLoopStatus(paths, name, { details: true });
    expect(status).toMatchObject({ phase: 'build', archiveReady: false });
    expect((status.findings ?? []).map((finding) => finding.code)).not.toEqual(
      expect.arrayContaining(['run-phase-mismatch', 'checkpoint-mismatch', 'trajectory-invalid']),
    );
    await migrateLoopChange({ paths, name });
    expect(await readTrajectory(runtimeDir(changeDir), run.trajectoryRef)).toEqual(trajectory);
  });

  it.each<LoopPhase>(['verify', 'archive'])(
    'retreats a stable v2 %s change to Build and lets the current runtime complete a fresh verified archive',
    async (phase) => {
      const name = `v2-${phase}-full-lifecycle`;
      const { state } = await seedCurrentPhase(name, phase);
      await downgradeToV2(state);

      const migrated = await migrateLoopChange({
        paths,
        name,
        now: new Date('2026-07-17T02:30:00.000Z'),
        id: () => `migration-${phase}-full-lifecycle`,
      });
      expect(migrated).toMatchObject({
        phase: 'build',
        revision: state.revision + 1,
        verification_result: 'pending',
        verification_report: null,
        implementation_scope: null,
        verification_evidence: null,
        archived: false,
      });

      const rebuilt = await advanceLoopChange({
        paths,
        name,
        evidence: {
          summary: 'implementation scope was re-established under the current runtime',
          artifacts: [`${name}.ts`],
          confirmed: true,
        },
        now: new Date('2026-07-17T02:31:00.000Z'),
      });
      expect(rebuilt.change).toMatchObject({
        phase: 'verify',
        approved_contract_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        implementation_scope: expect.stringMatching(
          /^runtime\/evidence\/scopes\/[a-f0-9]{64}\.json$/u,
        ),
      });

      await fs.writeFile(
        path.join(loopChangeDir(paths, name), 'verification.md'),
        await loopVerificationFixtureReport({ paths, name, evidenceRefs: [`${name}.ts`] }),
      );
      const verified = await advanceLoopChange({
        paths,
        name,
        evidence: {
          summary: 'fresh verification passed under the current runtime',
          verificationResult: 'pass',
          verificationReport: 'verification.md',
        },
        now: new Date('2026-07-17T02:32:00.000Z'),
      });
      expect(verified.change).toMatchObject({
        phase: 'archive',
        verification_result: 'pass',
        verification_evidence: expect.stringMatching(
          /^runtime\/evidence\/verifications\/[a-f0-9]{64}\.json$/u,
        ),
      });

      const preflight = await inspectLoopArchivePreflight({
        paths,
        name,
        now: new Date('2026-07-17T02:33:00.000Z'),
      });
      expect(preflight).toMatchObject({ ready: true, findingCodes: [] });
      const archived = await archiveLoopChange({
        paths,
        name,
        expectedPreflightHash: preflight.preflightHash,
        now: new Date('2026-07-17T02:33:00.000Z'),
      });
      expect(
        await readLoopChangeFile(path.join(archived.archiveDir, 'owner-state.yaml')),
      ).toMatchObject({
        phase: 'archive',
        archived: true,
      });
      expect(archived.archiveDir).toContain(name);
    },
  );

  it.each<{
    label: string;
    slug: string;
    hook: keyof LoopSchemaMigrationHooks;
  }>([
    { label: 'state write', slug: 'state', hook: 'afterStateWritten' },
    { label: 'Run state write', slug: 'run', hook: 'afterRunStateWritten' },
    { label: 'trajectory write', slug: 'trajectory', hook: 'afterTrajectoryWritten' },
    { label: 'checkpoint write', slug: 'checkpoint', hook: 'afterCheckpointWritten' },
  ])(
    'recovers a v2 Archive retreat interrupted after $label without duplicate migration events',
    async ({ slug, hook }) => {
      const name = `v2-archive-${slug}`;
      const { changeDir, state } = await seedCurrentPhase(name, 'archive');
      await downgradeToV2(state);
      const hooks = {
        [hook]: () => {
          throw new Error(`interrupt after ${slug}`);
        },
      } as LoopSchemaMigrationHooks;

      await expect(
        migrateLoopChange({
          paths,
          name,
          now: new Date('2026-07-17T03:00:00.000Z'),
          id: () => `migration-${slug}`,
          hooks,
        }),
      ).rejects.toThrow(`interrupt after ${slug}`);
      expect(await inspectPendingLoopSchemaMigration(paths, name)).not.toBeNull();

      const recovered = await migrateLoopChange({ paths, name });
      expect(recovered).toMatchObject({
        phase: 'build',
        verification_result: 'pending',
        verification_report: null,
        verification_evidence: null,
      });
      const run = (await readRunStateAt(runtimeDir(changeDir)))!;
      const trajectory = await readTrajectory(runtimeDir(changeDir), run.trajectoryRef);
      expect(
        trajectory.filter(
          (event) =>
            event.type === 'state_migrated' && event.data.migrationId === `migration-${slug}`,
        ),
      ).toHaveLength(1);
      expect(await readCheckpoint(runtimeDir(changeDir), run.checkpointRef)).toMatchObject({
        runId: run.runId,
        stateVersion: run.iteration,
        trajectoryOffset: trajectory.length,
      });
      expect((await inspectLoopStatus(paths, name, { details: true })).findings).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'run-phase-mismatch' }),
          expect.objectContaining({ code: 'checkpoint-mismatch' }),
        ]),
      );
    },
  );

  it('fails closed when a prepared migration target is changed without its content hash', async () => {
    const { state } = await seedCurrentPhase('tampered-migration', 'shape');
    const changeFile = await downgradeToV2(state);
    const source = await fs.readFile(changeFile, 'utf8');
    await expect(
      migrateLoopChange({
        paths,
        name: state.name,
        id: () => 'migration-tampered',
        hooks: {
          afterPrepared: () => {
            throw new Error('interrupt after prepared migration');
          },
        },
      }),
    ).rejects.toThrow('interrupt after prepared migration');
    const journalFile = loopSchemaMigrationJournalFile(paths, state.name);
    const journal = JSON.parse(await fs.readFile(journalFile, 'utf8')) as {
      nextState: Record<string, unknown>;
    };
    journal.nextState.approval = 'implicit';
    await fs.writeFile(journalFile, JSON.stringify(journal, null, 2) + '\n');

    await expect(inspectPendingLoopSchemaMigration(paths, state.name)).rejects.toThrow(
      'target hash does not match',
    );
    await expect(migrateLoopChange({ paths, name: state.name })).rejects.toThrow(
      'target hash does not match',
    );
    expect(await fs.readFile(changeFile, 'utf8')).toBe(source);
  });

  it('does not continue a prepared schema migration over a pending v2 checkpoint journal', async () => {
    const { changeDir, state } = await seedCurrentPhase('checkpoint-before-migration', 'shape');
    const changeFile = await downgradeToV2(state);
    const source = await fs.readFile(changeFile, 'utf8');
    await expect(
      migrateLoopChange({
        paths,
        name: state.name,
        id: () => 'migration-before-checkpoint',
        hooks: {
          afterPrepared: () => {
            throw new Error('interrupt before checkpoint appeared');
          },
        },
      }),
    ).rejects.toThrow('interrupt before checkpoint appeared');
    await fs.writeFile(path.join(runtimeDir(changeDir), 'checkpoint-journal.json'), '{}\n');

    await expect(migrateLoopChange({ paths, name: state.name })).rejects.toThrow(
      'pending progress checkpoint',
    );
    expect(await fs.readFile(changeFile, 'utf8')).toBe(source);
    expect(await inspectPendingLoopSchemaMigration(paths, state.name)).not.toBeNull();
  });

  it('recovers a migration journal when the state write completed before interruption', async () => {
    await seedLegacyChange('interrupted-migration');
    await writeProjectConfig(projectRoot, defaultProjectConfig('.'));
    await expect(
      migrateLoopChange({
        paths,
        name: 'interrupted-migration',
        now: new Date('2026-07-17T01:00:00.000Z'),
        id: () => 'migration-1',
        hooks: {
          afterStateWritten: () => {
            throw new Error('interrupt after migration state write');
          },
        },
      }),
    ).rejects.toThrow('interrupt after migration state write');
    const stateFile = path.join(loopChangeDir(paths, 'interrupted-migration'), 'owner-state.yaml');
    const stateBeforeRecovery = await fs.readFile(stateFile, 'utf8');
    await expect(readLoopChange(paths, 'interrupted-migration')).rejects.toBeInstanceOf(
      LoopSchemaMigrationRequiredError,
    );
    expect(await inspectLoopStatus(paths, 'interrupted-migration')).toMatchObject({
      schema: LOOP_V2_CHANGE_SCHEMA,
      migrationRequired: true,
      nextCommand: null,
    });
    const shown = await runLoopCli([
      'show',
      'interrupted-migration',
      '--json',
      '--project-root',
      projectRoot,
    ]);
    expect(shown.exitCode).toBe(0);
    expect(JSON.parse(shown.stdout!)).toMatchObject({
      data: { schema: LOOP_V2_CHANGE_SCHEMA, migrationRequired: true },
    });
    expect(
      await fs.stat(loopSchemaMigrationJournalFile(paths, 'interrupted-migration')),
    ).toBeDefined();
    expect(await readLoopBaselineManifest(paths, 'interrupted-migration')).toMatchObject({
      origin: 'legacy-migration',
      complete: true,
    });
    const pending = (await inspectPendingLoopSchemaMigration(paths, 'interrupted-migration'))!;
    await expect(
      compareAndSwapLoopChange(
        paths,
        { ...pending.nextState, approval: 'implicit' },
        pending.nextState.revision,
      ),
    ).rejects.toBeInstanceOf(LoopSchemaMigrationRequiredError);
    expect(await fs.readFile(stateFile, 'utf8')).toBe(stateBeforeRecovery);

    const inspected = await doctorLoopProject({ paths, name: 'interrupted-migration' });
    expect(inspected.findings).toContainEqual(
      expect.objectContaining({ code: 'schema-migration-incomplete', repair: 'migrate' }),
    );
    const repaired = await doctorLoopProject({
      paths,
      name: 'interrupted-migration',
      repair: true,
    });
    expect(repaired.findings).toContainEqual(
      expect.objectContaining({ code: 'schema-migration-recovered', severity: 'info' }),
    );
    await expect(
      fs.access(loopSchemaMigrationJournalFile(paths, 'interrupted-migration')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readLoopBaselineManifest(paths, 'interrupted-migration')).toMatchObject({
      origin: 'legacy-migration',
      createdAt: '2026-07-17T01:00:00.000Z',
    });
    expect(await readLoopChange(paths, 'interrupted-migration')).toMatchObject({
      schema: LOOP_CHANGE_SCHEMA,
      revision: 1,
    });
    await doctorLoopProject({ paths, name: 'interrupted-migration', repair: true });
    expect((await readLoopChange(paths, 'interrupted-migration')).revision).toBe(1);
  });

  it('fails closed on a schema that requires a newer runtime without rewriting it', async () => {
    const state = await createLoopChange({
      paths,
      name: 'future-change',
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });
    const file = path.join(loopChangeDir(paths, state.name), 'owner-state.yaml');
    const source = stringify({
      ...state,
      schema: 'owner.loop.v4',
      minimum_runtime_version: LOOP_RUNTIME_PROTOCOL_VERSION + 1,
    });
    await fs.writeFile(file, source);

    await expect(readLoopChange(paths, state.name)).rejects.toBeInstanceOf(
      LoopRuntimeCompatibilityError,
    );
    expect(await inspectLoopStatus(paths, state.name)).toMatchObject({
      phase: 'invalid',
      schema: 'owner.loop.v4',
      minimumRuntimeVersion: LOOP_RUNTIME_PROTOCOL_VERSION + 1,
      nextCommand: null,
    });
    const result = await doctorLoopProject({ paths, name: state.name, repair: true });
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: 'change-runtime-incompatible', severity: 'error' }),
    );
    expect(await fs.readFile(file, 'utf8')).toBe(source);
  });

  it('fails closed on an unsupported older schema without inventing a migration route', async () => {
    const state = await createLoopChange({
      paths,
      name: 'ancient-change',
      language: 'en',
      verificationProtocol: 'legacy-v1',
    });
    const file = path.join(loopChangeDir(paths, state.name), 'owner-state.yaml');
    const source = stringify({
      ...state,
      schema: 'owner.loop.v0',
      minimum_runtime_version: 1,
    });
    await fs.writeFile(file, source);

    await expect(readLoopChange(paths, state.name)).rejects.toBeInstanceOf(
      LoopRuntimeCompatibilityError,
    );
    expect(await inspectLoopStatus(paths, state.name)).toMatchObject({
      phase: 'invalid',
      schema: 'owner.loop.v0',
      minimumRuntimeVersion: 1,
      nextCommand: null,
    });
    const result = await doctorLoopProject({ paths, name: state.name, repair: true });
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: 'change-runtime-incompatible', severity: 'error' }),
    );
    expect(await fs.readFile(file, 'utf8')).toBe(source);
  });
});
