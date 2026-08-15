import { promises as fs } from 'node:fs';
import path from 'node:path';

import { doctorLoopProject } from './loop-doctor.js';
import { inspectLoopChildren } from './loop-children.js';
import { archiveLoopPortableChange } from './loop-portable-archive.js';
import { loopPortableContinuation } from './loop-portable-continuation.js';
import {
  hasIncompleteLoopPortableMigration,
  migrateLoopLegacyChangeToPortable,
} from './loop-portable-migration-runtime.js';
import { recoverLoopPortableChange } from './loop-portable-recovery.js';
import { isLoopPortableChange } from './loop-portable-runtime.js';
import type { LoopPortableState } from './loop-portable-types.js';
import { inspectLoopPortableStatus, listLoopPortableChangeNames } from './loop-portable-status.js';
import {
  describeLoopPortableTransactionEntry,
  listLoopPortableTransactionEntryNames,
  readLoopPortableTransactionEntry,
  type LoopPortableTransaction,
} from './loop-portable-transactions.js';
import {
  assertNoArguments,
  doctorPaths,
  LoopUsageError,
  success,
  takeFlag,
  takeOption,
  type DispatchResult,
} from './loop-cli-shared.js';
import type { LoopDoctorFinding, LoopProjectPaths } from './loop-types.js';

async function portableContinuation(paths: LoopProjectPaths, state: LoopPortableState) {
  const children = await inspectLoopChildren({ paths, state });
  return loopPortableContinuation(state, children);
}

async function listActiveChangeNames(paths: LoopProjectPaths): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(paths.changesDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, 'en'));
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

async function activeArchiveConflictFinding(
  paths: LoopProjectPaths,
  name: string,
): Promise<LoopDoctorFinding | null> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(paths.archiveDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const expected = new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${escapeRegularExpression(name)}$`, 'u');
  const archived = entries.find(
    (entry) => entry.isDirectory() && !entry.isSymbolicLink() && expected.test(entry.name),
  );
  if (!archived) return null;
  return {
    severity: 'error',
    code: 'portable-active-archive-conflict',
    message: `Loop change ${name} exists in both active and Archive storage`,
    path: path.join(paths.archiveDir, archived.name),
  };
}

function uniqueFindings(findings: readonly LoopDoctorFinding[]): LoopDoctorFinding[] {
  const unique = new Map<string, LoopDoctorFinding>();
  for (const finding of findings) {
    const key = [finding.severity, finding.code, finding.message, finding.path ?? ''].join('\0');
    unique.set(key, finding);
  }
  return [...unique.values()];
}

function unhealthyDoctor(data: Record<string, unknown>): DispatchResult {
  return {
    command: 'doctor',
    exitCode: 65,
    data,
    error: { code: 'invalid-data', message: 'Loop project needs attention' },
  };
}

function incompleteMigrationFinding(paths: LoopProjectPaths, name: string): LoopDoctorFinding {
  return {
    severity: 'error',
    code: 'portable-migration-incomplete',
    message: `Loop portable migration is incomplete for ${name}`,
    path: path.join(paths.changesDir, name, 'owner-state.yaml'),
    repair: 'migrate',
  };
}

async function inspectPortableTransactions(
  paths: LoopProjectPaths,
  name?: string,
): Promise<{
  transactions: LoopPortableTransaction[];
  findings: LoopDoctorFinding[];
}> {
  const transactions: LoopPortableTransaction[] = [];
  const findings: LoopDoctorFinding[] = [];
  for (const entryName of await listLoopPortableTransactionEntryNames(paths)) {
    const ref = describeLoopPortableTransactionEntry(entryName)!;
    if (name && ref.change !== name) continue;
    const file = path.join(paths.transactionsDir, entryName);
    try {
      const transaction = await readLoopPortableTransactionEntry(paths, entryName);
      if (!transaction) continue;
      transactions.push(transaction);
      findings.push(
        transaction.kind === 'archive'
          ? {
              severity: 'error',
              code: 'portable-archive-transaction-incomplete',
              message: `Loop portable Archive transaction ${transaction.journal.id} is incomplete for ${transaction.change}`,
              path: transaction.file,
              repair: 'continue',
            }
          : {
              severity: 'error',
              code: 'portable-migration-incomplete',
              message:
                transaction.journal.status === 'committed'
                  ? `Loop portable migration cleanup is incomplete for ${transaction.change}`
                  : `Loop portable migration transaction ${transaction.journal.id} is incomplete for ${transaction.change}`,
              path: transaction.file,
              repair: 'migrate',
            },
      );
    } catch (error) {
      findings.push({
        severity: 'error',
        code: 'portable-transaction-invalid',
        message: `Loop portable transaction ${entryName} is invalid: ${(error as Error).message}`,
        path: file,
      });
    }
  }
  return { transactions, findings };
}

export async function loopDoctorCommand(
  args: string[],
  projectRoot: string,
): Promise<DispatchResult> {
  const repair = takeFlag(args, '--repair');
  const recoveryStrategy = takeOption(args, '--strategy');
  if (
    recoveryStrategy !== undefined &&
    recoveryStrategy !== 'continue' &&
    recoveryStrategy !== 'rollback'
  ) {
    throw new LoopUsageError('--strategy must be continue or rollback');
  }
  const name = args[0]?.startsWith('--') ? undefined : args.shift();
  assertNoArguments(args);
  const paths = await doctorPaths(projectRoot);
  const portableTransactions = await inspectPortableTransactions(paths, name);
  if (name && portableTransactions.findings.length > 0) {
    if (recoveryStrategy) {
      throw new LoopUsageError('--strategy is only available to the legacy transaction doctor');
    }
    const portable = await isLoopPortableChange(paths, name);
    const result = portable
      ? await inspectLoopPortableStatus({ paths, name, details: true })
      : undefined;
    if (
      repair &&
      portableTransactions.transactions.length === 1 &&
      portableTransactions.findings.length === 1
    ) {
      const transaction = portableTransactions.transactions[0];
      if (transaction.kind === 'archive') {
        const archived = await archiveLoopPortableChange({ paths, name });
        return success('doctor', {
          healthy: true,
          workflow: 'loop-portable',
          change: name,
          repaired: true,
          archive: { recovered: true, transactionId: archived.transactionId },
          state: archived.state,
          continuation: await portableContinuation(paths, archived.state),
        });
      }
      const state = await migrateLoopLegacyChangeToPortable({ paths, name });
      return success('doctor', {
        healthy: true,
        workflow: 'loop-portable',
        change: name,
        repaired: true,
        migration: { recovered: true, to: state.schema, stateVersion: state.state_version },
        state,
        continuation: await portableContinuation(paths, state),
      });
    }
    return unhealthyDoctor({
      healthy: false,
      workflow: 'loop-portable',
      change: name,
      repaired: false,
      ...(result ? { result, continuation: result.continuation } : {}),
      findings: portableTransactions.findings,
    });
  }
  if (name && (await isLoopPortableChange(paths, name))) {
    if (recoveryStrategy) {
      throw new LoopUsageError('--strategy is only available to the legacy transaction doctor');
    }
    const [conflict, migrationIncomplete] = await Promise.all([
      activeArchiveConflictFinding(paths, name),
      hasIncompleteLoopPortableMigration(paths, name),
    ]);
    if (conflict) {
      const result = await inspectLoopPortableStatus({ paths, name, details: true });
      return unhealthyDoctor({
        healthy: false,
        workflow: 'loop-portable',
        change: name,
        repaired: false,
        result,
        findings: [conflict],
        continuation: result.continuation,
      });
    }
    if (migrationIncomplete && !repair) {
      const result = await inspectLoopPortableStatus({ paths, name, details: true });
      return unhealthyDoctor({
        healthy: false,
        workflow: 'loop-portable',
        change: name,
        repaired: false,
        result,
        findings: [incompleteMigrationFinding(paths, name)],
        continuation: result.continuation,
      });
    }
    if (repair) {
      if (migrationIncomplete) {
        const state = await migrateLoopLegacyChangeToPortable({ paths, name });
        return success('doctor', {
          healthy: true,
          workflow: 'loop-portable',
          change: name,
          repaired: true,
          migration: { recovered: true, to: state.schema, stateVersion: state.state_version },
          state,
          continuation: await portableContinuation(paths, state),
        });
      }
      const result = await recoverLoopPortableChange({ paths, name });
      return success('doctor', {
        healthy: true,
        workflow: 'loop-portable',
        change: name,
        repaired: true,
        result,
        continuation: await portableContinuation(paths, result.state),
      });
    }
    const result = await inspectLoopPortableStatus({ paths, name, details: true });
    return success('doctor', {
      healthy: true,
      workflow: 'loop-portable',
      change: name,
      repaired: false,
      result,
      continuation: result.continuation,
    });
  }
  if (name) {
    if (repair) {
      const state = await migrateLoopLegacyChangeToPortable({ paths, name });
      return success('doctor', {
        healthy: true,
        workflow: 'loop-portable',
        change: name,
        repaired: true,
        migration: { from: 'legacy', to: state.schema, stateVersion: state.state_version },
        state,
        continuation: await portableContinuation(paths, state),
      });
    }
    return {
      command: 'doctor',
      exitCode: 65,
      data: {
        healthy: false,
        change: name,
        migrationRequired: true,
        repairCommand: `owner loop doctor ${name} --repair`,
      },
      error: {
        code: 'invalid-data',
        message: `Loop active change ${name} requires migration to portable Runtime`,
      },
    };
  }
  const portableNames = await listLoopPortableChangeNames(paths);
  const projectPortableTransactions = portableTransactions;
  if (portableNames.length > 0 || projectPortableTransactions.findings.length > 0) {
    if (recoveryStrategy) {
      throw new LoopUsageError('--strategy is only available to the legacy transaction doctor');
    }
    if (repair) {
      const projectRepair = await doctorLoopProject({ paths, repair: true, projectOnly: true });
      const repairedPortableTransactions: Array<{
        kind: LoopPortableTransaction['kind'];
        change: string;
        transactionId: string;
      }> = [];
      for (const transaction of projectPortableTransactions.transactions) {
        if (transaction.kind === 'archive') {
          await archiveLoopPortableChange({ paths, name: transaction.change });
        } else {
          await migrateLoopLegacyChangeToPortable({ paths, name: transaction.change });
        }
        repairedPortableTransactions.push({
          kind: transaction.kind,
          change: transaction.change,
          transactionId: transaction.journal.id,
        });
      }
      const inspected = await loopDoctorCommand([], projectRoot);
      const inspectedData =
        inspected.data && typeof inspected.data === 'object' && !Array.isArray(inspected.data)
          ? (inspected.data as Record<string, unknown>)
          : {};
      return {
        ...inspected,
        data: {
          ...inspectedData,
          repaired: true,
          repairedPortableTransactions,
          repairFindings: projectRepair.findings,
        },
      };
    }
    const activeNames = await listActiveChangeNames(paths);
    const portableSet = new Set(portableNames);
    const migrationTransactionNames = new Set(
      projectPortableTransactions.transactions
        .filter((transaction) => transaction.kind === 'migration')
        .map(({ change }) => change),
    );
    const legacyNames = activeNames.filter((change) => !portableSet.has(change));
    const [changes, conflicts, incompleteMigrations, legacyResults, projectResult] =
      await Promise.all([
        Promise.all(
          portableNames.map((change) => inspectLoopPortableStatus({ paths, name: change })),
        ),
        Promise.all(portableNames.map((change) => activeArchiveConflictFinding(paths, change))),
        Promise.all(
          portableNames.map((change) => hasIncompleteLoopPortableMigration(paths, change)),
        ),
        Promise.all(legacyNames.map((change) => doctorLoopProject({ paths, name: change }))),
        doctorLoopProject({ paths, projectOnly: true }),
      ]);
    const findings = uniqueFindings([
      ...conflicts.filter((finding): finding is LoopDoctorFinding => finding !== null),
      ...portableNames.flatMap((change, index) =>
        incompleteMigrations[index] && !migrationTransactionNames.has(change)
          ? [incompleteMigrationFinding(paths, change)]
          : [],
      ),
      ...projectPortableTransactions.findings,
      ...legacyNames.map<LoopDoctorFinding>((change) => ({
        severity: 'error',
        code: 'portable-migration-required',
        message: `Loop active change ${change} requires migration to portable Runtime`,
        path: path.join(paths.changesDir, change, 'owner-state.yaml'),
        repair: 'migrate',
      })),
      ...legacyResults.flatMap(({ findings: resultFindings }) => resultFindings),
      ...projectResult.findings,
    ]);
    const data = {
      healthy: findings.every((finding) => finding.severity === 'info'),
      workflow: legacyNames.length > 0 ? 'loop-mixed' : 'loop-portable',
      changes,
      legacyChanges: legacyNames,
      findings,
    };
    return data.healthy ? success('doctor', data) : unhealthyDoctor(data);
  }
  const result = await doctorLoopProject({
    paths,
    ...(name ? { name } : {}),
    repair,
    ...(recoveryStrategy ? { recoveryStrategy } : {}),
  });
  return result.healthy
    ? success('doctor', result)
    : {
        command: 'doctor',
        exitCode: 65,
        data: result,
        error: { code: 'invalid-data', message: 'Loop project needs attention' },
      };
}
