import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { inspectGitWorktree } from '../../platform/paths/git-worktree.js';

import { atomicWriteJson } from './loop-atomic-file.js';
import { readLoopBoundedTextFile } from './loop-bounded-file.js';
import { inspectLoopChangeStateDocument, loopChangeDir } from './loop-change.js';
import { withLoopMutationLock } from './loop-mutation-lock.js';
import {
  migrateLoopLegacyStateToPortable,
  LOOP_PORTABLE_MIGRATION_TRANSACTION_SCHEMA,
  nextLoopPortableMigrationStep,
  type LoopPortableMigrationTransaction,
} from './loop-portable-migration.js';
import {
  loopPortableTransactionFile,
  readLoopPortableTransaction,
} from './loop-portable-transactions.js';
import {
  buildLoopPortableAcceptance,
  type LoopPortableAcceptanceCriterion,
} from './loop-portable-acceptance.js';
import {
  isLoopPortableChange,
  loopLocalExecutionFile,
  loopPortableStateFile,
} from './loop-portable-runtime.js';
import { readLoopPortableState, writeLoopPortableState } from './loop-portable-state.js';
import { rebuildLoopLocalExecution, writeLoopLocalExecution } from './loop-local-execution.js';
import { loopLegacyChangeRuntimeDir, loopPreferredChangeRuntimeDir } from './loop-paths.js';
import type { LoopPortableState, LoopPortableWorkspace } from './loop-portable-types.js';
import type { LoopProjectPaths, LoopReadableChangeState } from './loop-types.js';
import { readLoopWorkspaceIdentity } from './loop-workspace.js';

const LEGACY_PROJECTION_FILES = [
  'evidence.md',
  'verification.md',
  'repair.md',
  'archive.md',
  'checkpoint.md',
] as const;

async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function hasIncompleteLoopPortableMigration(
  paths: LoopProjectPaths,
  name: string,
): Promise<boolean> {
  const changeDir = loopChangeDir(paths, name);
  const artifacts = [
    loopPortableTransactionFile(paths, { kind: 'migration', change: name }),
    loopLegacyChangeRuntimeDir(paths, name),
    ...LEGACY_PROJECTION_FILES.map((file) => path.join(changeDir, file)),
  ];
  return (await Promise.all(artifacts.map(exists))).some(Boolean);
}

async function readTransaction(
  paths: LoopProjectPaths,
  name: string,
): Promise<LoopPortableMigrationTransaction | null> {
  const transaction = await readLoopPortableTransaction(paths, {
    kind: 'migration',
    change: name,
  });
  return transaction?.kind === 'migration' ? transaction.journal : null;
}

async function writeTransaction(
  paths: LoopProjectPaths,
  transaction: LoopPortableMigrationTransaction,
): Promise<void> {
  await fs.mkdir(paths.transactionsDir, { recursive: true });
  await atomicWriteJson(
    loopPortableTransactionFile(paths, { kind: 'migration', change: transaction.change }),
    transaction,
    { containedRoot: paths.runtimeDir },
  );
}

async function cleanupLegacyMigrationArtifacts(
  paths: LoopProjectPaths,
  name: string,
): Promise<void> {
  await Promise.all([
    fs.rm(loopPreferredChangeRuntimeDir(paths, name), {
      recursive: true,
      force: true,
    }),
    fs.rm(loopLegacyChangeRuntimeDir(paths, name), {
      recursive: true,
      force: true,
    }),
    ...LEGACY_PROJECTION_FILES.map((file) =>
      fs.rm(path.join(loopChangeDir(paths, name), file), { force: true }),
    ),
  ]);
}

async function rebuildLocalExecution(
  paths: LoopProjectPaths,
  portable: LoopPortableState,
): Promise<void> {
  await writeLoopLocalExecution(
    loopLocalExecutionFile(paths, portable.name),
    rebuildLoopLocalExecution({
      portableState: portable,
      projectRoot: paths.projectRoot,
    }),
    { containedRoot: paths.runtimeDir },
  );
}

async function legacyWorkspace(
  paths: LoopProjectPaths,
  name: string,
): Promise<LoopPortableWorkspace> {
  try {
    const workspace = await readLoopWorkspaceIdentity(paths, name);
    if (workspace?.schema === 'owner.loop.workspace.v3') {
      return {
        isolation: workspace.isolation,
        change_branch: workspace.changeBranch,
        target_branch: workspace.targetBranch,
        finish: workspace.finish,
      };
    }
  } catch {
    // Legacy Runtime is optional migration input. Missing or malformed local
    // identity cannot block deterministic portable recovery.
  }
  return { isolation: 'current', change_branch: null, target_branch: null, finish: null };
}

function assertMigrationWorkspaceCurrent(
  paths: LoopProjectPaths,
  workspace: LoopPortableWorkspace,
): void {
  if (workspace.isolation === 'current' && workspace.change_branch === null) return;
  const inspection = inspectGitWorktree(paths.projectRoot);
  if (!inspection.isGitWorktree) {
    throw new Error('Loop legacy migration requires its bound Git branch or worktree');
  }
  if (inspection.currentBranch !== workspace.change_branch) {
    throw new Error(
      `Loop legacy migration expected branch ${workspace.change_branch ?? '(missing)'}, current branch is ${inspection.currentBranch ?? '(detached)'}`,
    );
  }
  if (workspace.isolation === 'worktree' && !inspection.isSecondaryWorktree) {
    throw new Error('Loop legacy migration requires its bound linked worktree');
  }
}

async function migrationAcceptance(options: {
  paths: LoopProjectPaths;
  state: LoopReadableChangeState;
}): Promise<LoopPortableAcceptanceCriterion[]> {
  const changeDir = loopChangeDir(options.paths, options.state.name);
  const brief = await readLoopBoundedTextFile({
    root: changeDir,
    ref: options.state.brief,
    maxBytes: null,
    includeHash: false,
  });
  const specs = [];
  for (const change of options.state.spec_changes) {
    if (change.operation === 'remove' || !change.source) continue;
    const source = await readLoopBoundedTextFile({
      root: changeDir,
      ref: change.source,
      maxBytes: null,
      includeHash: false,
    });
    specs.push({ capability: change.capability, source: source.ref, markdown: source.text });
  }
  try {
    return buildLoopPortableAcceptance({ briefMarkdown: brief.text, specs });
  } catch (error) {
    if (
      options.state.phase === 'shape' &&
      (error as Error).message.includes('at least one acceptance')
    ) {
      return [];
    }
    throw error;
  }
}

async function inspectLegacyState(
  paths: LoopProjectPaths,
  name: string,
): Promise<LoopReadableChangeState> {
  const inspection = await inspectLoopChangeStateDocument(paths, name);
  if (!inspection.state) throw new Error(`Loop legacy change ${name} is unreadable`);
  return inspection.state;
}

export async function migrateLoopLegacyChangeToPortable(options: {
  paths: LoopProjectPaths;
  name: string;
  now?: Date;
}): Promise<LoopPortableState> {
  return withLoopMutationLock(
    options.paths,
    `migrate ${options.name} to portable Loop`,
    async () => {
      let transaction = await readTransaction(options.paths, options.name);
      let portable = (await isLoopPortableChange(options.paths, options.name))
        ? await readLoopPortableState(loopPortableStateFile(options.paths, options.name))
        : null;
      if (!transaction && portable) {
        // The portable YAML is the durable migration boundary. If its journal was
        // lost after that write, finish the deterministic cleanup and recreate the
        // disposable local overlay instead of mistaking the migration for complete.
        await cleanupLegacyMigrationArtifacts(options.paths, options.name);
        await rebuildLocalExecution(options.paths, portable);
        return portable;
      }

      let legacy: LoopReadableChangeState | null = null;
      let workspace: LoopPortableWorkspace | null = null;
      if (!transaction) {
        legacy = await inspectLegacyState(options.paths, options.name);
        workspace = await legacyWorkspace(options.paths, options.name);
        assertMigrationWorkspaceCurrent(options.paths, workspace);
        transaction = {
          schema: LOOP_PORTABLE_MIGRATION_TRANSACTION_SCHEMA,
          id: randomUUID(),
          change: legacy.name,
          fromSchema: legacy.schema,
          status: 'prepared',
          createdAt: (options.now ?? new Date()).toISOString(),
        };
        await writeTransaction(options.paths, transaction);
      }

      for (;;) {
        const step = nextLoopPortableMigrationStep(transaction);
        if (step.action === 'done') break;
        if (step.action === 'commit-portable-yaml') {
          if (!portable) {
            legacy ??= await inspectLegacyState(options.paths, options.name);
            workspace ??= await legacyWorkspace(options.paths, options.name);
            assertMigrationWorkspaceCurrent(options.paths, workspace);
            portable = migrateLoopLegacyStateToPortable({
              state: legacy,
              acceptance: await migrationAcceptance({ paths: options.paths, state: legacy }),
              workspace,
              migratedAt: options.now,
            });
            await writeLoopPortableState(
              loopPortableStateFile(options.paths, options.name),
              portable,
              {
                containedRoot: options.paths.loopRoot,
              },
            );
          }
        } else if (step.action === 'cleanup-legacy-runtime') {
          await cleanupLegacyMigrationArtifacts(options.paths, options.name);
        } else if (step.action === 'commit-transaction') {
          portable ??= await readLoopPortableState(
            loopPortableStateFile(options.paths, options.name),
          );
          await rebuildLocalExecution(options.paths, portable);
        }
        transaction = {
          ...transaction,
          status: step.nextStatus!,
        };
        await writeTransaction(options.paths, transaction);
      }

      await fs.rm(
        loopPortableTransactionFile(options.paths, {
          kind: 'migration',
          change: options.name,
        }),
        { force: true },
      );
      return portable ?? readLoopPortableState(loopPortableStateFile(options.paths, options.name));
    },
    { allowedPortableTransaction: { kind: 'migration', change: options.name } },
  );
}
