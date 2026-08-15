import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import type { PipelineCommandHandler, PipelineCommandResult } from './pipeline-cli.js';
import { executePipelineOpenSpec } from './pipeline-openspec-command.js';
import {
  findPipelineArchiveChangeDirectory,
  inspectPipelineActiveChangeDirectory,
  openSpecChangeNameError,
} from './pipeline-paths.js';
import { ensurePipelineRuntimeRun, transitionPipelineRuntimeRun } from './pipeline-runtime-run.js';
import { appendPipelineStateEvent } from './pipeline-state-events.js';
import { readPipelineState, writePipelineState } from './pipeline-store.js';
import { applyPipelineTransition } from './pipeline-transitions.js';
import { clearCurrentChangeIf } from './pipeline-current-change.js';
import {
  appendTrajectory,
  clearPendingAction,
  readArtifacts,
  readContext,
  readPendingAction,
  readTrajectory,
  writeArtifacts,
  writeCheckpoint,
  writePendingAction,
} from '../../domains/engine/run-store.js';
import type { Checkpoint, EngineAction, RunState } from '../../domains/engine/types.js';
import {
  assertPipelineLayoutWritable,
  pipelineProjectRelative,
  discoverPipelineProject,
} from './pipeline-layout.js';
import {
  pipelineProjectTargetExists,
  ensurePipelineProjectDirectory,
  inspectPipelineProjectTarget,
  readPipelineProjectFile,
  writePipelineProjectText,
} from './pipeline-protected-path.js';

const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const YELLOW = '\u001b[33m';
const RESET = '\u001b[0m';

function green(message: string): string {
  return `${GREEN}${message}${RESET}`;
}

function red(message: string): string {
  return `${RED}${message}${RESET}`;
}

function yellow(message: string): string {
  return `${YELLOW}${message}${RESET}`;
}

class ArchiveFailure extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

class ArchiveOutput {
  readonly stderr: string[] = [];
  readonly openSpecStdout: string[] = [];
  readonly openSpecStderr: string[] = [];
  stepsOk = 0;
  stepsTotal = 0;

  captureOpenSpec(result: PipelineCommandResult): void {
    if (result.stdout) this.openSpecStdout.push(result.stdout);
    if (result.stderr) this.openSpecStderr.push(result.stderr);
  }

  toResult(exitCode = 0): PipelineCommandResult {
    const diagnostics = this.stderr.length > 0 ? this.stderr.join('\n') + '\n' : '';
    const openSpecStderr = this.openSpecStderr.join('');
    const separator = openSpecStderr && diagnostics && !openSpecStderr.endsWith('\n') ? '\n' : '';
    return {
      exitCode,
      ...(this.openSpecStdout.length > 0 ? { stdout: this.openSpecStdout.join('') } : {}),
      ...(openSpecStderr || diagnostics
        ? { stderr: `${openSpecStderr}${separator}${diagnostics}` }
        : {}),
    };
  }
}

function validateChangeName(name: string): void {
  const error = openSpecChangeNameError(name);
  if (error) throw new ArchiveFailure(red(`FATAL: ${error}`));
}

function hashText(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function artifactsHash(artifacts: Record<string, string>): string {
  return hashText(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(artifacts).sort(([left], [right]) => left.localeCompare(right)),
      ),
    ),
  );
}

function isPathInside(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return (
    relative !== '' &&
    !path.isAbsolute(relative) &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`)
  );
}

function archivedPointer(
  projectRoot: string,
  activeDir: string,
  archiveDir: string,
  pointer: string | null,
): string | null {
  if (!pointer) return pointer;
  const absolute = path.resolve(projectRoot, pointer);
  if (!isPathInside(activeDir, absolute)) return pointer;
  return pipelineProjectRelative(
    projectRoot,
    path.join(archiveDir, path.relative(activeDir, absolute)),
  );
}

function archivedArtifacts(
  projectRoot: string,
  activeDir: string,
  archiveDir: string,
  artifacts: Record<string, string>,
): Record<string, string> {
  const rewritten = { ...artifacts };
  for (const field of ['handoff_context', 'handoff_markdown'] as const) {
    const value = rewritten[field];
    if (!value) continue;
    rewritten[field] = archivedPointer(projectRoot, activeDir, archiveDir, value) ?? value;
  }
  return rewritten;
}

async function verifyFinalArchiveIntegrity(projectRoot: string, archiveDir: string): Promise<void> {
  const projection = await readPipelineState(archiveDir);
  if (!projection.pipeline || !projection.run || !projection.pipeline.archived) {
    throw new ArchiveFailure(red('  [FAIL] Final archived state is incomplete'));
  }
  const statePointers = [
    ['design_doc', projection.pipeline.designDoc],
    ['plan', projection.pipeline.plan],
    ['verification_report', projection.pipeline.verificationReport],
    ['handoff_context', projection.pipeline.handoffContext],
  ] as const;
  const artifacts = await readArtifacts(archiveDir, projection.run.artifactsRef);
  const artifactPointers = [
    ['artifacts.handoff_context', artifacts.handoff_context],
    ['artifacts.handoff_markdown', artifacts.handoff_markdown],
  ] as const;
  for (const [field, pointer] of [...statePointers, ...artifactPointers]) {
    if (!pointer) continue;
    if (
      !(await pipelineProjectTargetExists(projectRoot, path.resolve(projectRoot, pointer), {
        label: `Pipeline archived ${field}`,
        expected: 'file',
      }))
    ) {
      throw new ArchiveFailure(red(`  [FAIL] Final archived ${field} does not exist: ${pointer}`));
    }
  }
}

function exactlyOneFinalNewline(markdown: string): string {
  return `${markdown.replace(/\n+$/u, '')}\n`;
}

export function annotatedMarkdown(
  original: string,
  archiveName: string,
  extraFields: string,
): string {
  const normalized = original.replace(/\r\n/gu, '\n');
  const lines = normalized.split('\n');
  const closingDelimiter = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
  const extraFieldName = extraFields.match(/^([^:\n]+):/u)?.[1]?.trim();

  if (closingDelimiter !== -1) {
    const frontmatter = lines.slice(1, closingDelimiter).filter((line) => {
      const fieldName = line.match(/^([^:\n]+):/u)?.[1]?.trim();
      if (fieldName === undefined) return true;
      return fieldName !== 'archived-with' && fieldName !== extraFieldName;
    });
    frontmatter.push(`archived-with: ${archiveName}`);
    if (extraFields) frontmatter.push(extraFields);
    return exactlyOneFinalNewline(
      ['---', ...frontmatter, '---', ...lines.slice(closingDelimiter + 1)].join('\n'),
    );
  }

  const header = ['---', `archived-with: ${archiveName}`];
  if (extraFields) header.push(extraFields);
  if (extraFieldName !== 'status') header.push('status: final');
  header.push('---');
  return exactlyOneFinalNewline([...header, normalized].join('\n'));
}

async function appendRecoveryEvent(
  changeDir: string,
  run: RunState,
  actionId: string,
): Promise<void> {
  const trajectory = await readTrajectory(changeDir, run.trajectoryRef);
  if (
    trajectory.some(
      (event) =>
        event.type === 'recovery_reconciled' &&
        event.data.kind === 'pipeline-archive' &&
        event.data.actionId === actionId,
    )
  ) {
    return;
  }
  await appendTrajectory(changeDir, run.trajectoryRef, {
    sequence: trajectory.length + 1,
    timestamp: new Date().toISOString(),
    type: 'recovery_reconciled',
    runId: run.runId,
    data: {
      kind: 'pipeline-archive',
      actionId,
    },
  });
}

async function annotateFrontmatter(
  output: ArchiveOutput,
  projectRoot: string,
  file: string,
  archiveName: string,
  extraFields: string,
  dryRun: boolean,
): Promise<void> {
  if (
    !(await pipelineProjectTargetExists(projectRoot, file, {
      label: 'Pipeline archive annotation target',
      expected: 'file',
    }))
  ) {
    return;
  }
  if (dryRun) {
    output.stderr.push(yellow(`  [DRY-RUN] Would annotate: ${file}`));
    output.stepsOk += 1;
    output.stepsTotal += 1;
    return;
  }
  const original = await readPipelineProjectFile(projectRoot, file, {
    label: 'Pipeline archive annotation target',
  });
  const updated = annotatedMarkdown(original, archiveName, extraFields);
  await writePipelineProjectText(projectRoot, file, updated, {
    label: 'Pipeline archive annotation target',
  });
  output.stderr.push(green(`  [OK] Annotated: ${file}`));
  output.stepsOk += 1;
  output.stepsTotal += 1;
}

async function verifyMainSpecsClean(projectRoot: string, specsRoot: string): Promise<void> {
  const rootInspection = await inspectPipelineProjectTarget(projectRoot, specsRoot, {
    label: 'Pipeline main specs directory',
    expected: 'directory',
  });
  if (!rootInspection.exists) return;
  let found = false;
  const entries = await fs.readdir(specsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const specFile = `${specsRoot}/${entry.name}/spec.md`;
    const content = await (async () => {
      if (
        !(await pipelineProjectTargetExists(projectRoot, specFile, {
          label: `Pipeline main spec ${entry.name}`,
          expected: 'file',
        }))
      ) {
        return null;
      }
      return readPipelineProjectFile(projectRoot, specFile, {
        label: `Pipeline main spec ${entry.name}`,
      });
    })();
    if (content === null) continue;
    const matches = content
      .split(/\r?\n/u)
      .map((line, index) => ({ line, number: index + 1 }))
      .filter((item) => /^## (ADDED|MODIFIED|REMOVED|RENAMED) Requirements$/u.test(item.line));
    if (matches.length > 0) {
      found = true;
      process.stderr.write(
        red(`FATAL: delta-only section heading leaked into main spec: ${specFile}`) + '\n',
      );
      for (const match of matches) process.stderr.write(`${match.number}:${match.line}\n`);
    }
  }
  if (found) throw new ArchiveFailure('');
}

export const pipelineArchiveCommand: PipelineCommandHandler = async (args) => {
  const output = new ArchiveOutput();
  const change = args[0];
  const dryRun = args[1] === '--dry-run';
  try {
    validateChangeName(change);
    const projectRoot = await discoverPipelineProject(process.cwd());
    const layout = await assertPipelineLayoutWritable(projectRoot);
    const active = await inspectPipelineActiveChangeDirectory(change, layout.projectRoot);
    const activeDir = active.directory;
    const activeRef = pipelineProjectRelative(layout.projectRoot, activeDir);
    const today = new Date().toISOString().slice(0, 10);
    let archiveName = `${today}-${change}`;
    let archiveDir = path.join(layout.archiveDir, archiveName);

    output.stderr.push(`=== Owner Archive: ${change} ===`);

    const activeExists = active.stateExists;
    const recoveredArchive = activeExists
      ? null
      : await findPipelineArchiveChangeDirectory(change, layout.projectRoot);
    const changeDir = activeExists ? activeDir : recoveredArchive?.directory;
    if (
      !changeDir ||
      !(await pipelineProjectTargetExists(layout.projectRoot, `${changeDir}/.owner.yaml`, {
        label: `Pipeline change ${change} state`,
        expected: 'file',
      }))
    ) {
      throw new ArchiveFailure(red(`FATAL: .owner.yaml not found in ${activeRef}/`));
    }
    if (recoveredArchive) {
      archiveDir = recoveredArchive.directory;
      archiveName = path.basename(recoveredArchive.directory);
    }
    const projection = await readPipelineState(changeDir);
    if (!projection.pipeline) {
      throw new ArchiveFailure(red('FATAL: archive requires Pipeline state'));
    }
    const pipeline = projection.pipeline;
    const designDoc = pipeline.designDoc;
    const planPath = pipeline.plan;

    if (pipeline.phase !== 'archive') {
      throw new ArchiveFailure(red(`FATAL: phase is '${pipeline.phase}', expected 'archive'`));
    }
    if (pipeline.verifyResult !== 'pass') {
      throw new ArchiveFailure(
        red(
          `FATAL: verify_result is '${pipeline.verifyResult}', expected 'pass'. Run owner-verify first.`,
        ),
      );
    }
    output.stderr.push(green('  [OK] Entry state verified'));
    output.stepsOk += 1;
    output.stepsTotal += 1;

    const archiveTarget = await inspectPipelineProjectTarget(layout.projectRoot, archiveDir, {
      label: `Pipeline archive target ${archiveName}`,
      expected: 'directory',
    });
    if (activeExists && archiveTarget.exists) {
      throw new ArchiveFailure(red(`FATAL: archive target already exists: ${archiveDir}`));
    }
    output.stderr.push(green('  [OK] Archive target available'));
    output.stepsOk += 1;
    output.stepsTotal += 1;

    if (dryRun) {
      output.stderr.push(yellow(`  [DRY-RUN] Would run OpenSpec archive: ${change}`));
      output.stepsOk += 1;
      output.stepsTotal += 1;
    } else if (!pipeline.archived || projection.run?.pending) {
      await ensurePipelineProjectDirectory(
        layout.projectRoot,
        `${changeDir}/.owner`,
        'Pipeline change runtime directory',
      );
      const runtime = await ensurePipelineRuntimeRun(changeDir);
      const actionId = `pipeline-archive:${change}`;
      const pendingAction = await readPendingAction(changeDir, runtime.run.pendingRef);
      const recovering =
        Boolean(recoveredArchive) ||
        (pendingAction?.id === actionId &&
          pendingAction.type === 'checkpoint' &&
          pendingAction.ref === change);
      if (runtime.run.pending && runtime.run.pending !== actionId) {
        throw new ArchiveFailure(red(`FATAL: another action is pending: ${runtime.run.pending}`));
      }
      if (!recovering && !pipeline.archived && pipeline.archiveConfirmation !== 'confirmed') {
        throw new ArchiveFailure(
          red(
            `FATAL: archive_confirmation is '${pipeline.archiveConfirmation ?? 'null'}', expected 'confirmed'. Run final archive confirmation first.`,
          ),
        );
      }

      if (!recovering) {
        const action: EngineAction = {
          id: actionId,
          stepId: runtime.run.currentStep,
          type: 'checkpoint',
          ref: change,
        };
        await writePendingAction(changeDir, runtime.run.pendingRef, action);
        await writePipelineState(changeDir, {
          pipeline: runtime.pipeline,
          run: {
            ...runtime.run,
            pending: actionId,
            status: 'waiting',
          },
          unknownKeys: (await readPipelineState(changeDir)).unknownKeys,
        });
      }

      if (!recoveredArchive) {
        const archiveRun = await executePipelineOpenSpec(
          ['archive', change, '--yes'],
          layout.projectRoot,
        );
        output.captureOpenSpec(archiveRun);
        if (archiveRun.exitCode !== 0) {
          throw new ArchiveFailure('', archiveRun.exitCode);
        }
      }

      let resolvedArchive = await findPipelineArchiveChangeDirectory(change, layout.projectRoot, {
        preferredArchiveName: archiveName,
      });
      if (!resolvedArchive && !recoveredArchive) {
        resolvedArchive = await findPipelineArchiveChangeDirectory(change, layout.projectRoot, {
          skipExactCompatibility: true,
        });
      }
      if (!resolvedArchive) {
        output.stderr.push(red('  [FAIL] OpenSpec archive output not found'));
        output.stepsTotal += 1;
        output.stderr.push('');
        output.stderr.push(
          green(`Archive complete. ${output.stepsOk}/${output.stepsTotal} steps succeeded.`),
        );
        return output.toResult(1);
      }
      archiveDir = resolvedArchive.directory;
      archiveName = path.basename(resolvedArchive.directory);
      output.stderr.push(green(`  [OK] OpenSpec archive completed: ${archiveDir}`));
      output.stepsOk += 1;
      output.stepsTotal += 1;

      await verifyMainSpecsClean(layout.projectRoot, layout.specsDir);
      output.stderr.push(green('  [OK] Main specs verified clean'));
      output.stepsOk += 1;
      output.stepsTotal += 1;

      if (designDoc) {
        await annotateFrontmatter(
          output,
          layout.projectRoot,
          designDoc,
          archiveName,
          'status: final',
          false,
        );
      }
      if (planPath) {
        await annotateFrontmatter(output, layout.projectRoot, planPath, archiveName, '', false);
      }

      const archivedProjection = await readPipelineState(archiveDir);
      if (!archivedProjection.pipeline || !archivedProjection.run) {
        throw new ArchiveFailure(red('  [FAIL] archived state projection is incomplete'));
      }
      const artifacts = {
        ...archivedArtifacts(
          layout.projectRoot,
          activeDir,
          archiveDir,
          await readArtifacts(archiveDir, archivedProjection.run.artifactsRef),
        ),
        archive_directory: pipelineProjectRelative(layout.projectRoot, archiveDir),
      };
      await writeArtifacts(archiveDir, archivedProjection.run.artifactsRef, artifacts);

      const archiveTransition = applyPipelineTransition(
        recovering && archivedProjection.pipeline.archiveConfirmation !== 'confirmed'
          ? { ...archivedProjection.pipeline, archiveConfirmation: 'confirmed' }
          : archivedProjection.pipeline,
        'archived',
      );
      const archivedPipeline = {
        ...archiveTransition.pipeline,
        designDoc: archivedPointer(
          layout.projectRoot,
          activeDir,
          archiveDir,
          archiveTransition.pipeline.designDoc,
        ),
        plan: archivedPointer(
          layout.projectRoot,
          activeDir,
          archiveDir,
          archiveTransition.pipeline.plan,
        ),
        verificationReport: archivedPointer(
          layout.projectRoot,
          activeDir,
          archiveDir,
          archiveTransition.pipeline.verificationReport,
        ),
        handoffContext: archivedPointer(
          layout.projectRoot,
          activeDir,
          archiveDir,
          archiveTransition.pipeline.handoffContext,
        ),
      };
      let transitionedRun = archivedProjection.run;
      if (
        archivedProjection.run.currentStep !== 'completed' ||
        archivedProjection.run.status !== 'completed'
      ) {
        transitionedRun = await transitionPipelineRuntimeRun(
          archiveDir,
          archivedPipeline,
          archivedProjection.run,
          {
            actionId,
            archiveDirectory: pipelineProjectRelative(layout.projectRoot, archiveDir),
            event: 'archived',
            source: 'owner-archive',
          },
        );
      }
      if (recovering) {
        await appendRecoveryEvent(archiveDir, transitionedRun, actionId);
      }
      const trajectory = await readTrajectory(archiveDir, transitionedRun.trajectoryRef);
      const context = await readContext(archiveDir, transitionedRun.contextRef);
      const checkpoint: Checkpoint = {
        runId: transitionedRun.runId,
        stateVersion: transitionedRun.iteration,
        trajectoryOffset: trajectory.length,
        contextHash: context === null ? null : hashText(context),
        artifactsHash: artifactsHash(artifacts),
        createdAt: new Date().toISOString(),
      };
      await writeCheckpoint(archiveDir, transitionedRun.checkpointRef, checkpoint);
      const completedRun: RunState = {
        ...transitionedRun,
        pending: null,
        status: 'completed',
      };
      await writePipelineState(archiveDir, {
        pipeline: archivedPipeline,
        run: completedRun,
        unknownKeys: archivedProjection.unknownKeys,
      });
      await appendPipelineStateEvent(archiveDir, {
        change: archiveName,
        event: 'archived',
        source: 'owner-archive',
        from: archivedProjection.pipeline,
        to: archivedPipeline,
        effects: archiveTransition.effects,
      });
      await clearPendingAction(archiveDir, completedRun.pendingRef);
      output.stderr.push(green('  [OK] archived: true'));
      output.stepsOk += 1;
      output.stepsTotal += 1;
    } else {
      if (!projection.run) {
        throw new ArchiveFailure(
          red('FATAL: archived Pipeline state is missing its Run projection'),
        );
      }
      output.stderr.push(green(`  [OK] OpenSpec archive completed: ${archiveDir}`));
      output.stepsOk += 1;
      output.stepsTotal += 1;
      output.stderr.push(green('  [OK] Main specs verified clean'));
      output.stepsOk += 1;
      output.stepsTotal += 1;
      output.stderr.push(green('  [OK] archived: true'));
      output.stepsOk += 1;
      output.stepsTotal += 1;
    }

    if (dryRun) {
      if (designDoc) {
        await annotateFrontmatter(
          output,
          layout.projectRoot,
          designDoc,
          archiveName,
          'status: final',
          true,
        );
      }
      if (planPath) {
        await annotateFrontmatter(output, layout.projectRoot, planPath, archiveName, '', true);
      }
      output.stderr.push(
        yellow(`  [DRY-RUN] Would set archived: true in ${archiveDir}/.owner.yaml`),
      );
      output.stepsOk += 1;
      output.stepsTotal += 1;
      output.stderr.push(yellow('  [DRY-RUN] Would verify final archive integrity'));
      output.stepsOk += 1;
      output.stepsTotal += 1;
    } else {
      await verifyFinalArchiveIntegrity(layout.projectRoot, archiveDir);
      output.stderr.push(green('  [OK] Final archive integrity verified'));
      output.stepsOk += 1;
      output.stepsTotal += 1;
    }

    if (!dryRun) await clearCurrentChangeIf(layout.projectRoot, change);

    output.stderr.push('');
    output.stderr.push(
      dryRun
        ? yellow(`Dry run complete. ${output.stepsOk}/${output.stepsTotal} steps would succeed.`)
        : green(`Archive complete. ${output.stepsOk}/${output.stepsTotal} steps succeeded.`),
    );
    return output.toResult(output.stepsOk < output.stepsTotal ? 1 : 0);
  } catch (error) {
    if (error instanceof ArchiveFailure) {
      if (error.message) {
        for (const line of error.message.split('\n')) output.stderr.push(line);
      }
      return output.toResult(error.exitCode);
    }
    throw error;
  }
};
