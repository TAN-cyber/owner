import { promises as fs, type Dirent } from 'fs';
import path from 'path';

import { recoverArchiveTransaction } from './loop-archive.js';
import { inspectLoopChange, LOOP_CHANGE_STATE_FILE, readLoopChange } from './loop-change.js';
import { readProjectConfig } from './loop-config.js';
import { inspectLoopStatus, listLoopStatus } from './loop-diagnostics.js';
import { inspectLoopEvidenceRetention } from './loop-evidence-retention.js';
import { diagnoseLoopLock, takeOverLoopStaleLock, withLoopLockRecovery } from './loop-lock.js';
import {
  loopChangeRuntimeDir,
  loopLegacyChangeRuntimeDir,
  loopPreferredChangeRuntimeDir,
  loopProjectPaths,
  loopStorageRoot,
  inspectLoopRuntimeStorage,
  resolveContainedLoopPath,
} from './loop-paths.js';
import {
  captureLoopProtectedDirectoryGuard,
  readLoopProtectedDirectory,
} from './loop-protected-file.js';
import { recoverLoopRootMove } from './loop-root-move.js';
import { continueLoopCheckpoint } from './loop-checkpoint-journal.js';
import { loopCheckpointJournalFile, readLoopCheckpointJournal } from './loop-checkpoint-storage.js';
import { loopSelectionFile, readLoopSelectionRecord } from './loop-selection.js';
import { isLoopPortableChange } from './loop-portable-runtime.js';
import {
  inspectPendingLoopSchemaMigration,
  migrateLoopChange,
  loopSchemaMigrationJournalFile,
} from './loop-schema-migration.js';
import { readLoopTransaction } from './loop-transaction.js';
import {
  continueLoopTransition,
  inspectPendingLoopTransition,
  LoopTransitionMigrationRequiredError,
  loopTransitionJournalFile,
} from './loop-transition-journal.js';
import { inspectLoopTrajectoryTail, repairLoopTrajectoryTail } from './loop-trajectory-recovery.js';
import {
  migrateLegacyLoopWorkspaceIdentity,
  loopWorkspaceIdentityNeedsMigration,
  loopWorkspaceFile,
} from './loop-workspace.js';
import type { LoopDoctorFinding, LoopProjectPaths, LoopTransactionJournal } from './loop-types.js';

const LOOP_DOCTOR_MAX_CHANGE_ENTRIES = 4_096;
const LOOP_DOCTOR_MAX_TRANSACTION_ENTRIES = 4_096;
const LOOP_DOCTOR_MAX_LOCK_ENTRIES = 1_024;

async function directoryEntries(
  paths: LoopProjectPaths,
  directory: string,
  maxEntries: number,
): Promise<Dirent[]> {
  try {
    const protectedDirectory = await readLoopProtectedDirectory({
      root: loopStorageRoot(paths, directory),
      directory,
      label: 'Loop doctor directory',
      maxEntries,
    });
    await protectedDirectory.verify();
    return protectedDirectory.entries;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function clearStaleRecoveryLocks(
  targets: Array<{ paths: LoopProjectPaths; file: string }>,
  findings: LoopDoctorFinding[],
): Promise<boolean> {
  const unique = new Map(
    targets.map((target) => [
      path.resolve(target.file),
      { ...target, file: path.resolve(target.file) },
    ]),
  );
  for (const { paths, file } of unique.values()) {
    let diagnosis;
    try {
      diagnosis = await diagnoseLoopLock(file);
    } catch (error) {
      findings.push({
        severity: 'error',
        code: 'lock-invalid',
        message: `Loop recovery lock is invalid: ${(error as Error).message}`,
        path: file,
      });
      return false;
    }
    if (diagnosis.status === 'missing') continue;
    if (diagnosis.status === 'stale') {
      const takeover = await takeOverLoopStaleLock(paths, file, diagnosis);
      if (takeover.status === 'removed') {
        findings.push({
          severity: 'info',
          code: 'stale-recovery-lock-removed',
          message: `Removed stale lock before explicit transaction recovery`,
          path: file,
        });
        continue;
      }
      if (takeover.status === 'missing') continue;
      diagnosis = takeover.diagnosis;
    }
    if (diagnosis.status === 'stale') {
      findings.push({
        severity: 'error',
        code: 'lock-takeover-raced',
        message: 'Loop recovery lock changed while doctor was preparing stale takeover',
        path: file,
      });
      return false;
    }
    findings.push({
      severity: 'error',
      code: diagnosis.status === 'active' ? 'lock-active' : 'lock-owner-unknown',
      message:
        diagnosis.status === 'active'
          ? `Loop recovery lock is still owned by a live process`
          : `Loop recovery lock owner cannot be proven stale`,
      path: file,
    });
    return false;
  }
  return true;
}

async function inspectSelection(
  paths: LoopProjectPaths,
  repair: boolean,
): Promise<LoopDoctorFinding[]> {
  const file = loopSelectionFile(paths);
  let value: { schema?: unknown; workflow?: unknown; change?: unknown };
  try {
    await resolveContainedLoopPath(paths.projectRoot, file);
    const selection = await readLoopSelectionRecord(paths);
    if (!selection) return [];
    value = selection;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return [
      {
        severity: 'error',
        code: 'selection-invalid',
        message: `Loop selection is invalid: ${(error as Error).message}`,
        path: file,
      },
    ];
  }
  if (
    value.schema !== 'owner.selection.v2' ||
    value.workflow !== 'loop' ||
    typeof value.change !== 'string'
  ) {
    return [
      {
        severity: 'error',
        code: 'selection-invalid',
        message: 'Loop selection has an invalid schema or change name',
        path: file,
      },
    ];
  }
  try {
    if (await isLoopPortableChange(paths, value.change)) return [];
    await readLoopChange(paths, value.change);
    return [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return [
        {
          severity: 'error',
          code: 'selection-target-invalid',
          message: `Selected Loop change is invalid: ${(error as Error).message}`,
          path: file,
        },
      ];
    }
  }
  if (repair) {
    await fs.rm(file, { force: true });
    return [
      {
        severity: 'info',
        code: 'selection-cleared',
        message: `Cleared stale Loop selection ${value.change}`,
        path: file,
      },
    ];
  }
  return [
    {
      severity: 'warning',
      code: 'selection-stale',
      message: `Selected Loop change does not exist: ${value.change}`,
      path: file,
    },
  ];
}

async function inspectManagedPaths(paths: LoopProjectPaths): Promise<LoopDoctorFinding[]> {
  const findings: LoopDoctorFinding[] = [];
  for (const managedPath of [
    paths.specsDir,
    paths.changesDir,
    paths.archiveDir,
    paths.runtimeDir,
    paths.locksDir,
    paths.transactionsDir,
  ]) {
    try {
      await resolveContainedLoopPath(loopStorageRoot(paths, managedPath), managedPath);
    } catch (error) {
      findings.push({
        severity: 'error',
        code: 'loop-path-unsafe',
        message: `Managed Loop path is unsafe: ${(error as Error).message}`,
        path: managedPath,
      });
    }
  }
  return findings;
}

async function inspectTransactions(
  paths: LoopProjectPaths,
  options: {
    name?: string;
    repair: boolean;
    recoveryStrategy?: 'continue' | 'rollback';
  },
): Promise<{ findings: LoopDoctorFinding[]; unfinished: LoopTransactionJournal[] }> {
  const findings: LoopDoctorFinding[] = [];
  const unfinished: LoopTransactionJournal[] = [];
  for (const entry of await directoryEntries(
    paths,
    paths.transactionsDir,
    LOOP_DOCTOR_MAX_TRANSACTION_ENTRIES,
  )) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    let journal: LoopTransactionJournal;
    try {
      journal = await readLoopTransaction(paths, entry.name);
    } catch (error) {
      findings.push({
        severity: 'error',
        code: 'transaction-invalid',
        message: `Loop transaction ${entry.name} is invalid: ${(error as Error).message}`,
        path: path.join(paths.transactionsDir, entry.name),
      });
      continue;
    }
    if (journal.status === 'committed' || journal.status === 'rolled-back') continue;
    if (options.name && journal.change && journal.change !== options.name) continue;
    if (journal.kind !== 'archive') {
      unfinished.push(journal);
      findings.push({
        severity: 'error',
        code: 'root-move-transaction-orphaned',
        message: `Root-move transaction ${journal.id} is incomplete but project config has no matching pending move`,
      });
      continue;
    }
    if (options.repair && options.recoveryStrategy) {
      try {
        const locksReady = await withLoopLockRecovery(
          [paths],
          `doctor archive recovery ${journal.id}`,
          async () => {
            const ready = await clearStaleRecoveryLocks(
              [
                { paths, file: path.join(paths.locksDir, 'root-move.lock') },
                { paths, file: path.join(paths.locksDir, 'archive.lock') },
              ],
              findings,
            );
            if (!ready) return false;
            await recoverArchiveTransaction({
              paths,
              transactionId: journal.id,
              strategy: options.recoveryStrategy!,
            });
            return true;
          },
        );
        if (!locksReady) {
          unfinished.push(journal);
          continue;
        }
        findings.push({
          severity: 'info',
          code: 'archive-transaction-recovered',
          message: `${options.recoveryStrategy === 'continue' ? 'Continued' : 'Rolled back'} archive transaction ${journal.id}`,
        });
      } catch (error) {
        unfinished.push(journal);
        findings.push({
          severity: 'error',
          code: 'archive-recovery-failed',
          message: `Archive recovery failed: ${(error as Error).message}`,
        });
      }
    } else {
      unfinished.push(journal);
      findings.push({
        severity: 'error',
        code: 'archive-transaction-incomplete',
        message: options.repair
          ? `Archive transaction ${journal.id} needs an explicit recovery strategy`
          : `Archive transaction ${journal.id} is incomplete`,
        repair: options.recoveryStrategy ?? 'continue',
      });
    }
  }
  return { findings, unfinished };
}

async function inspectLocks(
  paths: LoopProjectPaths,
  repair: boolean,
  unfinished: LoopTransactionJournal[],
): Promise<LoopDoctorFinding[]> {
  const findings: LoopDoctorFinding[] = [];
  for (const entry of await directoryEntries(paths, paths.locksDir, LOOP_DOCTOR_MAX_LOCK_ENTRIES)) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.lock')) continue;
    const file = path.join(paths.locksDir, entry.name);
    try {
      const diagnosis = await diagnoseLoopLock(file);
      if (diagnosis.status === 'active') {
        findings.push({
          severity: 'warning',
          code: 'lock-active',
          message: `Loop lock is active for ${diagnosis.owner?.operation ?? 'an operation'}`,
          path: file,
        });
      } else if (diagnosis.status === 'unknown') {
        findings.push({
          severity: 'warning',
          code: 'lock-owner-unknown',
          message: 'Loop lock owner cannot be proven stale',
          path: file,
        });
      } else if (diagnosis.status === 'stale') {
        if (repair && unfinished.length === 0) {
          const takeover = await takeOverLoopStaleLock(paths, file, diagnosis);
          if (takeover.status === 'removed') {
            findings.push({
              severity: 'info',
              code: 'stale-lock-removed',
              message: 'Removed a Loop lock whose local owner process is absent',
              path: file,
            });
          } else if (takeover.status === 'changed') {
            findings.push({
              severity: takeover.diagnosis.status === 'active' ? 'warning' : 'error',
              code: 'lock-takeover-raced',
              message: 'Loop lock changed while doctor was preparing stale takeover',
              path: file,
            });
          }
        } else {
          findings.push({
            severity: unfinished.length > 0 ? 'error' : 'warning',
            code: 'lock-stale',
            message:
              unfinished.length > 0
                ? 'Loop lock is stale but an unfinished transaction still requires recovery'
                : 'Loop lock owner process is absent',
            path: file,
          });
        }
      }
    } catch (error) {
      findings.push({
        severity: 'error',
        code: 'lock-invalid',
        message: `Loop lock metadata is invalid: ${(error as Error).message}`,
        path: file,
      });
    }
  }
  return findings;
}

async function inspectChanges(
  paths: LoopProjectPaths,
  name?: string,
  maxVerifyFailures = 5,
): Promise<LoopDoctorFinding[]> {
  const findings: LoopDoctorFinding[] = [];
  const statuses = name
    ? await listLoopStatus(paths, { maxVerifyFailures }).then((all) =>
        all.filter((status) => status.name === name),
      )
    : await listLoopStatus(paths, { maxVerifyFailures });
  if (name && statuses.length === 0) {
    return [
      {
        severity: 'error',
        code: 'change-missing',
        message: `Loop change does not exist: ${name}`,
      },
    ];
  }
  for (const status of statuses) {
    if (status.migrationRequired) continue;
    if (status.phase === 'invalid') {
      findings.push({
        severity: 'error',
        code: 'change-invalid',
        message: status.error ?? `Loop change ${status.name} is invalid`,
        path: path.join(paths.changesDir, status.name, LOOP_CHANGE_STATE_FILE),
      });
      continue;
    }
    const detailed = await inspectLoopStatus(paths, status.name, {
      details: true,
      maxVerifyFailures,
    });
    for (const artifact of detailed.findings ?? []) {
      if (
        artifact.code === 'trajectory-tail-incomplete' ||
        artifact.code === 'checkpoint-progress-incomplete'
      ) {
        continue;
      }
      findings.push({
        severity: artifact.severity,
        code: artifact.code,
        message: `${status.name}: ${artifact.message}`,
        ...(artifact.path ? { path: path.join(paths.projectRoot, artifact.path) } : {}),
      });
    }
  }
  return findings;
}

async function inspectTrajectoryTailRepairs(
  paths: LoopProjectPaths,
  options: { name?: string; repair: boolean },
): Promise<LoopDoctorFinding[]> {
  const findings: LoopDoctorFinding[] = [];
  const names = options.name
    ? [options.name]
    : (await directoryEntries(paths, paths.changesDir, LOOP_DOCTOR_MAX_CHANGE_ENTRIES))
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .map((entry) => entry.name)
        .sort();
  for (const name of names) {
    try {
      const inspection = await inspectLoopTrajectoryTail(paths, name);
      if (inspection.status !== 'repairable') continue;
      if (!options.repair) {
        findings.push({
          severity: 'error',
          code: 'trajectory-tail-incomplete',
          message: `Loop trajectory for ${name} has an incomplete final line ${inspection.line}; ${inspection.discardedBytes} byte(s) are outside the last complete event`,
          path: inspection.file,
          repair: 'truncate-tail',
        });
        continue;
      }
      const repaired = await repairLoopTrajectoryTail(paths, name);
      if (repaired) {
        findings.push({
          severity: 'info',
          code: 'trajectory-tail-repaired',
          message: `Removed the incomplete Loop trajectory tail for ${name} and preserved all complete events`,
          path: repaired.file,
        });
      }
    } catch (error) {
      findings.push({
        severity: 'error',
        code: 'trajectory-tail-repair-failed',
        message: `Loop trajectory tail repair failed for ${name}: ${(error as Error).message}`,
        path: path.join(loopChangeRuntimeDir(paths, name), 'trajectory.jsonl'),
      });
    }
  }
  return findings;
}

async function inspectRuntimeLayoutMigrations(
  paths: LoopProjectPaths,
  options: { name?: string; repair: boolean },
): Promise<LoopDoctorFinding[]> {
  const findings: LoopDoctorFinding[] = [];
  const names = options.name
    ? [options.name]
    : (await directoryEntries(paths, paths.changesDir, LOOP_DOCTOR_MAX_CHANGE_ENTRIES))
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .map((entry) => entry.name)
        .sort();
  for (const name of names) {
    const inspection = await inspectLoopRuntimeStorage(paths, name);
    if (inspection.status === 'missing') {
      findings.push({
        severity: 'warning',
        code: 'runtime-missing',
        message: `Loop Runtime for ${name} is missing; continue the change to rebuild it`,
        path: inspection.path,
      });
      continue;
    }
    if (inspection.status === 'invalid') {
      findings.push({
        severity: 'error',
        code: 'runtime-storage-invalid',
        message: inspection.message ?? `Loop Runtime storage for ${name} is invalid`,
        path: inspection.path,
      });
      continue;
    }
    if (inspection.layout !== 'legacy') continue;
    const legacy = loopLegacyChangeRuntimeDir(paths, name);
    const preferred = loopPreferredChangeRuntimeDir(paths, name);
    if (!options.repair) {
      findings.push({
        severity: 'warning',
        code: 'runtime-layout-legacy',
        message: `Loop Runtime for ${name} still uses the legacy change-local layout`,
        path: legacy,
        repair: 'migrate',
      });
      continue;
    }
    try {
      await withLoopLockRecovery([paths], `migrate Runtime layout for ${name}`, async () => {
        const guard = await captureLoopProtectedDirectoryGuard({
          root: paths.loopRoot,
          directory: legacy,
          label: `Legacy Loop Runtime ${name}`,
        });
        await resolveContainedLoopPath(paths.runtimeDir, preferred);
        await fs.mkdir(paths.changesRuntimeDir, { recursive: true });
        const targetParentGuard = await captureLoopProtectedDirectoryGuard({
          root: paths.runtimeDir,
          directory: paths.changesRuntimeDir,
          label: `Loop Runtime migration target parent ${name}`,
        });
        try {
          await fs.lstat(preferred);
          throw new Error(`Target Loop Runtime already exists: ${preferred}`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await guard.verify();
        await targetParentGuard.verify();
        await fs.rename(legacy, preferred);
      });
      findings.push({
        severity: 'info',
        code: 'runtime-layout-migrated',
        message: `Moved Loop Runtime for ${name} to project-local .owner storage`,
        path: preferred,
      });
    } catch (error) {
      findings.push({
        severity: 'error',
        code: 'runtime-layout-migration-failed',
        message: `Loop Runtime layout migration failed for ${name}: ${(error as Error).message}`,
        path: legacy,
      });
    }
  }
  return findings;
}

async function inspectWorkspaceIdentityMigrations(
  paths: LoopProjectPaths,
  options: { name?: string; repair: boolean },
): Promise<LoopDoctorFinding[]> {
  const findings: LoopDoctorFinding[] = [];
  const names = options.name
    ? [options.name]
    : (await directoryEntries(paths, paths.changesDir, LOOP_DOCTOR_MAX_CHANGE_ENTRIES))
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .map((entry) => entry.name)
        .sort();
  for (const name of names) {
    try {
      if (!(await loopWorkspaceIdentityNeedsMigration(paths, name))) {
        continue;
      }
      if (!options.repair) {
        findings.push({
          severity: 'warning',
          code: 'workspace-identity-migration-required',
          message: `Loop workspace identity for ${name} uses legacy external-probe or hash-only metadata`,
          path: loopWorkspaceFile(paths, name),
          repair: 'migrate',
        });
        continue;
      }
      const state = await readLoopChange(paths, name);
      const migrated = await migrateLegacyLoopWorkspaceIdentity({
        paths,
        name,
        revision: state.revision,
      });
      if (migrated) {
        findings.push({
          severity: 'info',
          code: 'workspace-identity-migrated',
          message: `Replaced legacy workspace metadata for ${name} with process-free root identities`,
          path: loopWorkspaceFile(paths, name),
        });
      }
    } catch (error) {
      findings.push({
        severity: 'error',
        code: 'workspace-identity-migration-failed',
        message: `Loop workspace identity migration failed for ${name}: ${(error as Error).message}`,
        path: loopWorkspaceFile(paths, name),
      });
    }
  }
  return findings;
}

async function inspectSchemaMigrations(
  paths: LoopProjectPaths,
  options: { name?: string; repair: boolean },
): Promise<LoopDoctorFinding[]> {
  const findings: LoopDoctorFinding[] = [];
  const names = options.name
    ? [options.name]
    : (await directoryEntries(paths, paths.changesDir, LOOP_DOCTOR_MAX_CHANGE_ENTRIES))
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .map((entry) => entry.name)
        .sort();
  for (const name of names) {
    const file = loopSchemaMigrationJournalFile(paths, name);
    try {
      const pending = await inspectPendingLoopSchemaMigration(paths, name);
      const inspection = await inspectLoopChange(paths, name);
      if (!pending && inspection.status === 'current') continue;
      if (inspection.status === 'runtime-incompatible') {
        findings.push({
          severity: 'error',
          code: 'change-runtime-incompatible',
          message: inspection.message ?? `Loop change ${name} requires a newer runtime`,
          path: path.join(paths.changesDir, name, LOOP_CHANGE_STATE_FILE),
        });
        continue;
      }
      if (!options.repair) {
        findings.push({
          severity: 'error',
          code: pending ? 'schema-migration-incomplete' : 'schema-migration-required',
          message: pending
            ? `Loop schema migration ${pending.id} is incomplete for ${name}`
            : `Loop change ${name} requires migration to the current schema`,
          path: pending ? file : path.join(paths.changesDir, name, LOOP_CHANGE_STATE_FILE),
          repair: 'migrate',
        });
        continue;
      }
      await migrateLoopChange({ paths, name });
      findings.push({
        severity: 'info',
        code: pending ? 'schema-migration-recovered' : 'schema-migrated',
        message: `Migrated Loop change ${name} to the current schema`,
        path: path.join(paths.changesDir, name, LOOP_CHANGE_STATE_FILE),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      findings.push({
        severity: 'error',
        code: 'schema-migration-failed',
        message: `Loop schema migration failed for ${name}: ${(error as Error).message}`,
        path: file,
      });
    }
  }
  return findings;
}

async function inspectTransitionJournals(
  paths: LoopProjectPaths,
  options: {
    name?: string;
    repair: boolean;
    recoveryStrategy?: 'continue' | 'rollback';
  },
): Promise<LoopDoctorFinding[]> {
  const findings: LoopDoctorFinding[] = [];
  const names = options.name
    ? [options.name]
    : (await directoryEntries(paths, paths.changesDir, LOOP_DOCTOR_MAX_CHANGE_ENTRIES))
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .map((entry) => entry.name)
        .sort();
  for (const name of names) {
    let journal;
    try {
      journal = await inspectPendingLoopTransition(paths, name);
    } catch (error) {
      if (error instanceof LoopTransitionMigrationRequiredError) continue;
      findings.push({
        severity: 'error',
        code: 'transition-invalid',
        message: `Loop transition journal is invalid: ${(error as Error).message}`,
        path: loopTransitionJournalFile(paths, name),
      });
      continue;
    }
    if (!journal) continue;
    if (options.repair && options.recoveryStrategy === 'continue') {
      try {
        const recovered = await withLoopLockRecovery(
          [paths],
          `doctor transition recovery ${name}`,
          async () => {
            const locksReady = await clearStaleRecoveryLocks(
              [
                { paths, file: path.join(paths.locksDir, 'root-move.lock') },
                { paths, file: path.join(paths.locksDir, `transition-${name}.lock`) },
              ],
              findings,
            );
            if (!locksReady) return false;
            await continueLoopTransition(paths, name);
            return true;
          },
        );
        if (!recovered) continue;
        findings.push({
          severity: 'info',
          code: 'transition-recovered',
          message: `Continued Loop phase transition ${journal.id} for ${name}`,
          path: loopTransitionJournalFile(paths, name),
        });
      } catch (error) {
        findings.push({
          severity: 'error',
          code: 'transition-recovery-failed',
          message: `Loop transition recovery failed: ${(error as Error).message}`,
          path: loopTransitionJournalFile(paths, name),
        });
      }
      continue;
    }
    findings.push({
      severity: 'error',
      code: 'transition-incomplete',
      message:
        options.repair && options.recoveryStrategy === 'rollback'
          ? `Loop phase transition ${journal.id} only supports deterministic continue recovery`
          : `Loop phase transition ${journal.id} is incomplete for ${name}`,
      path: loopTransitionJournalFile(paths, name),
      repair: 'continue',
    });
  }
  return findings;
}

async function inspectCheckpointJournals(
  paths: LoopProjectPaths,
  options: { name?: string; repair: boolean },
): Promise<LoopDoctorFinding[]> {
  const findings: LoopDoctorFinding[] = [];
  const names = options.name
    ? [options.name]
    : (await directoryEntries(paths, paths.changesDir, LOOP_DOCTOR_MAX_CHANGE_ENTRIES))
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .map((entry) => entry.name)
        .sort();
  for (const name of names) {
    const file = loopCheckpointJournalFile(paths, name);
    let journal;
    try {
      journal = await readLoopCheckpointJournal(paths, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      findings.push({
        severity: 'error',
        code: 'checkpoint-progress-invalid',
        message: `Loop progress checkpoint journal is invalid: ${(error as Error).message}`,
        path: file,
      });
      continue;
    }
    if (!journal) continue;
    if (!options.repair) {
      findings.push({
        severity: 'error',
        code: 'checkpoint-progress-incomplete',
        message: `Loop progress checkpoint ${journal.id} is incomplete for ${name}`,
        path: file,
      });
      continue;
    }
    try {
      const recovered = await withLoopLockRecovery(
        [paths],
        `doctor checkpoint recovery ${name}`,
        async () => {
          const locksReady = await clearStaleRecoveryLocks(
            [
              { paths, file: path.join(paths.locksDir, 'root-move.lock') },
              { paths, file: path.join(paths.locksDir, `transition-${name}.lock`) },
            ],
            findings,
          );
          if (!locksReady) return false;
          await continueLoopCheckpoint(paths, name);
          return true;
        },
      );
      if (!recovered) continue;
      findings.push({
        severity: 'info',
        code: 'checkpoint-progress-recovered',
        message: `Continued Loop progress checkpoint ${journal.id} for ${name}`,
        path: file,
      });
    } catch (error) {
      findings.push({
        severity: 'error',
        code: 'checkpoint-progress-recovery-failed',
        message: `Loop progress checkpoint recovery failed: ${(error as Error).message}`,
        path: file,
      });
    }
  }
  return findings;
}

export async function doctorLoopProject(options: {
  paths: LoopProjectPaths;
  name?: string;
  repair?: boolean;
  recoveryStrategy?: 'continue' | 'rollback';
  projectOnly?: boolean;
  now?: Date;
}): Promise<{ healthy: boolean; findings: LoopDoctorFinding[] }> {
  const repair = options.repair ?? false;
  const findings: LoopDoctorFinding[] = [];
  let paths = options.paths;
  let config;
  try {
    config = await readProjectConfig(paths.projectRoot);
  } catch (error) {
    const result = {
      healthy: false,
      findings: [
        {
          severity: 'error' as const,
          code: 'config-invalid',
          message: `Owner project config is invalid: ${(error as Error).message}`,
          path: paths.configFile,
        },
      ],
    };
    return result;
  }
  let relocationRecoveryPending = Boolean(config?.loop.pending_root_move);
  if (config?.loop.pending_root_move) {
    const pending = config.loop.pending_root_move;
    const [fromPaths, toPaths] = await Promise.all([
      loopProjectPaths(paths.projectRoot, pending.fromArtifactRoot),
      loopProjectPaths(paths.projectRoot, pending.toArtifactRoot),
    ]);
    if (repair && options.recoveryStrategy) {
      try {
        const locksReady = await clearStaleRecoveryLocks(
          [
            { paths: fromPaths, file: path.join(fromPaths.locksDir, 'root-move.lock') },
            { paths: toPaths, file: path.join(toPaths.locksDir, 'root-move.lock') },
          ],
          findings,
        );
        if (!locksReady) return { healthy: false, findings };
        const recovered = await recoverLoopRootMove({
          projectRoot: paths.projectRoot,
          strategy: options.recoveryStrategy,
        });
        paths = await loopProjectPaths(paths.projectRoot, recovered.config.loop.artifact_root);
        relocationRecoveryPending = false;
        findings.push({
          severity: 'info',
          code: 'root-move-recovered',
          message: `${options.recoveryStrategy === 'continue' ? 'Continued' : 'Rolled back'} Loop root move ${pending.id}`,
        });
      } catch (error) {
        findings.push({
          severity: 'error',
          code: 'root-move-recovery-failed',
          message: `Loop root recovery failed: ${(error as Error).message}`,
        });
        return { healthy: false, findings };
      }
    } else {
      findings.push({
        severity: 'error',
        code: 'root-move-incomplete',
        message: `Loop root move ${pending.id} is ${pending.stage}; inspect ${fromPaths.loopRoot} and ${toPaths.loopRoot}`,
        repair: options.recoveryStrategy ?? 'continue',
      });
    }
  }

  const managedPathFindings = await inspectManagedPaths(paths);
  findings.push(...managedPathFindings);
  if (managedPathFindings.length > 0) return { healthy: false, findings };

  const transactions = await inspectTransactions(paths, {
    name: options.name,
    repair,
    recoveryStrategy: options.recoveryStrategy,
  });
  findings.push(...transactions.findings);
  if (!options.projectOnly) {
    findings.push(...(await inspectRuntimeLayoutMigrations(paths, { name: options.name, repair })));
    findings.push(...(await inspectSchemaMigrations(paths, { name: options.name, repair })));
    findings.push(
      ...(await inspectWorkspaceIdentityMigrations(paths, { name: options.name, repair })),
    );
    findings.push(...(await inspectTrajectoryTailRepairs(paths, { name: options.name, repair })));
    findings.push(
      ...(await inspectTransitionJournals(paths, {
        name: options.name,
        repair,
        recoveryStrategy: options.recoveryStrategy,
      })),
    );
    findings.push(...(await inspectCheckpointJournals(paths, { name: options.name, repair })));
    findings.push(
      ...(await inspectLoopEvidenceRetention({
        paths,
        name: options.name,
        repair,
        now: options.now,
        deferAll: relocationRecoveryPending || transactions.unfinished.length > 0,
      })),
    );
  }
  findings.push(...(await inspectLocks(paths, repair, transactions.unfinished)));
  findings.push(...(await inspectSelection(paths, repair)));
  if (!options.projectOnly) {
    findings.push(
      ...(await inspectChanges(paths, options.name, config?.loop.max_verify_failures ?? 5)),
    );
  }
  return {
    healthy: findings.every((finding) => finding.severity === 'info'),
    findings,
  };
}
