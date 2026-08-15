import path from 'path';
import { inspectOwnerProjectStatus } from '../../domains/owner-entry/project-status.js';
import type { ChangeStatus, OwnerProjectStatus } from '../../domains/owner-entry/types.js';
import { requiresBranchBinding } from '../../domains/owner-classic/classic-branch-binding.js';
import type { RecordedCommandCheck } from '../../domains/owner-classic/classic-command-checks.js';
import type { NativeStatusProjection } from '../../domains/owner-native/native-types.js';

function formatMissingEvidence(missingEvidence: readonly string[]): string {
  return missingEvidence.join(', ');
}

function formatRuntimeCheckRecovery(
  nextCommand: string | null,
  missingEvidence: readonly string[],
): string {
  const missing = formatMissingEvidence(missingEvidence);
  if (nextCommand) {
    return `run ${nextCommand} or restore missing evidence (${missing}), then rerun owner doctor`;
  }
  return `restore missing evidence (${missing}) and rerun owner doctor`;
}

function formatCommandCheck(check: RecordedCommandCheck): string {
  const result = check.exitCode === 0 ? 'pass' : `fail exit=${check.exitCode}`;
  return `${result} (${check.command}; cwd: ${check.cwd}; recorded: ${check.timestamp})`;
}

function displayChangeSection(title: string, changes: ChangeStatus[]): void {
  console.log(`${title}:\n`);
  if (changes.length === 0) {
    console.log('  No active changes.\n');
    return;
  }

  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    const taskStr = c.tasksTotal > 0 ? ` [${c.tasksCompleted}/${c.tasksTotal} tasks]` : '';
    const classification = c.ownerManaged ? 'Owner' : 'OpenSpec';
    const phase = c.phase ? `phase: ${c.phase}` : 'plain change';
    console.log(`  ${i + 1}. ${c.name} [${classification}] [${phase}${taskStr}]`);
    if (c.error) {
      console.log(`     error: ${c.error}`);
      console.log('     next: inspect .owner.yaml and rerun owner doctor');
      console.log();
      continue;
    }
    if (!c.ownerManaged) {
      if (c.archiveReady) console.log(`     recommended archive: ${c.recommendedArchiveCommand}`);
      console.log();
      continue;
    }
    console.log(`     workflow: ${c.workflow} | build_mode: ${c.buildMode}`);
    if (c.isolation) {
      const branchSuffix =
        requiresBranchBinding(c.isolation) && c.boundBranch ? ` (bound: ${c.boundBranch})` : '';
      console.log(`     isolation: ${c.isolation}${branchSuffix}`);
    }
    if (c.currentStep) console.log(`     run_step: ${c.currentStep}`);
    console.log(`     runtime_mode: ${c.runtimeMode}`);
    if (c.runtimeEval) {
      const suffix = c.runtimeEval.passed
        ? `(${c.runtimeEval.stepId})`
        : `(${c.runtimeEval.stepId}; missing: ${formatMissingEvidence(c.runtimeEval.missingEvidence)})`;
      console.log(`     runtime_check: ${c.runtimeEval.passed ? 'pass' : 'fail'} ${suffix}`);
    }
    if (c.commandChecks?.build) {
      console.log(`     build_check: ${formatCommandCheck(c.commandChecks.build)}`);
    }
    if (c.commandChecks?.verify) {
      console.log(`     verify_check: ${formatCommandCheck(c.commandChecks.verify)}`);
    }
    if (c.designDoc) console.log(`     design: ${c.designDoc}`);
    if (c.plan) console.log(`     plan:   ${c.plan}`);
    if (c.phase === 'verify') console.log(`     verify_result: ${c.verifyResult}`);
    if (c.runtimeEval && !c.runtimeEval.passed) {
      console.log(
        `     next: ${formatRuntimeCheckRecovery(c.nextCommand, c.runtimeEval.missingEvidence)}`,
      );
    } else if (c.nextCommand) {
      console.log(`     next: ${c.nextCommand}`);
    }
    if (c.archiveReady) console.log(`     recommended archive: ${c.recommendedArchiveCommand}`);
    console.log();
  }
}

function displayNativeChanges(section: OwnerProjectStatus['workflows']['native']): void {
  console.log('Native Changes:\n');
  if (section.error) {
    console.log(`  error: ${section.error}\n`);
    return;
  }
  if (section.changes.length === 0) {
    console.log('  No active changes.\n');
    return;
  }
  for (let index = 0; index < section.changes.length; index++) {
    const change: NativeStatusProjection = section.changes[index];
    console.log(`  ${index + 1}. ${change.name} [Native] [phase: ${change.phase}]`);
    console.log(
      `     approval: ${change.approval ?? 'pending'} | verification: ${change.verificationResult} | spec_changes: ${change.specChanges}`,
    );
    if (change.selected) console.log('     selected: true');
    if (change.error) console.log(`     error: ${change.error}`);
    if (change.nextCommand) console.log(`     next: ${change.nextCommand}`);
    console.log();
  }
}

function displayDefaultEntry(defaultEntry: OwnerProjectStatus['defaultEntry']): void {
  if ('error' in defaultEntry) {
    console.log(`Default Entry: error (${defaultEntry.error})\n`);
    return;
  }
  console.log(
    `Default Entry: ${defaultEntry.workflow} -> /${defaultEntry.skill} [${defaultEntry.source}]\n`,
  );
}

function displayStatus(status: OwnerProjectStatus): void {
  displayDefaultEntry(status.defaultEntry);
  displayNativeChanges(status.workflows.native);
  displayChangeSection('Classic Changes', status.workflows.classic.changes);
  displayChangeSection('Unmanaged OpenSpec Changes', status.unmanagedOpenSpec);
}

interface StatusOptions {
  json?: boolean;
}

export async function statusCommand(
  targetPath: string,
  options: StatusOptions = {},
): Promise<void> {
  const projectPath = path.resolve(targetPath);
  const status = await inspectOwnerProjectStatus(projectPath);
  const changes = [...status.workflows.classic.changes, ...status.unmanagedOpenSpec].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  if (options.json) {
    console.log(JSON.stringify({ ...status, changes }, null, 2));
    return;
  }

  displayStatus(status);
}
