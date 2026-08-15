import { Command, Option } from 'commander';
import { getCurrentVersion } from '../../platform/version/version.js';
import { OWNER_TAGLINE } from './owner-banner.js';

// Command handlers are imported lazily so CLI startup stays proportional to
// the Loop or Pipeline operation being run.

const PUBLIC_PIPELINE_COMMANDS = ['state', 'guard', 'handoff', 'archive'] as const;
type PublicPipelineCommand = (typeof PUBLIC_PIPELINE_COMMANDS)[number];

const program = new Command();

program
  .name('owner')
  .description(OWNER_TAGLINE)
  .version(getCurrentVersion(), '-v, --version', 'output the current version');

program
  .command('init [path]')
  .description('Initialize Owner workflow in your project')
  .option('--yes', 'Auto-install missing components, skip existing')
  .option('--skip-existing', 'Never overwrite existing components')
  .option('--overwrite', 'Overwrite manifest-managed files')
  .option('--json', 'Output as JSON')
  .addOption(
    new Option('--platform <platform>', 'Platform target to initialize').choices([
      'claude',
      'codex',
    ]),
  )
  .addOption(new Option('--scope <scope>', 'Install scope').choices(['global', 'project']))
  .addOption(new Option('--language <lang>', 'Language for skills').choices(['en', 'zh']))
  .addOption(
    new Option('--workflow <workflow>', 'Workflows to initialize').choices([
      'loop',
      'pipeline',
      'both',
    ]),
  )
  .option('--root <artifact-root>', 'Loop artifact root relative to the project')
  .action(async (targetPath = '.', options) => {
    const { initCommand } = await import('../commands/init.js');
    const { exitCodeForCommandResult } = await import('../commands/command-result.js');
    const result = await initCommand(targetPath, { ...options, artifactRoot: options.root });
    process.exitCode = exitCodeForCommandResult(result);
  });

program
  .command('status [path]')
  .description('Show active changes and workflow status')
  .option('--json', 'Output as JSON')
  .action(async (targetPath = '.', options) => {
    const { statusCommand } = await import('../commands/status.js');
    await statusCommand(targetPath, options);
  });

const workflow = program.command('workflow').description('Resolve the configured Owner workflow');

workflow
  .command('resolve [path]')
  .description('Resolve /owner to its permanent Loop or Pipeline entry')
  .option('--activate', 'Create project configuration from global defaults when missing')
  .option('--json', 'Output as JSON')
  .action(async (targetPath = '.', options) => {
    const { workflowResolveCommand } = await import('../commands/workflow.js');
    await workflowResolveCommand(targetPath, options);
  });

program
  .command('resume-probe [path]')
  .description('Probe whether an active Owner workflow should resume')
  .option('--utterance <text>', 'User request to classify', '')
  .option('--stdin', 'Read the user request from stdin')
  .option('--json', 'Output as JSON')
  .option('--no-workflow-work', 'Treat the request as informational instead of workflow work')
  .option(
    '--already-in-owner-flow',
    'Report out_of_scope when the current turn is already inside Owner',
  )
  .action(async (targetPath = '.', options) => {
    const { resumeProbeCommand } = await import('../commands/resume-probe.js');
    await resumeProbeCommand(targetPath, options);
  });

program
  .command('doctor [path]')
  .description('Diagnose Owner installation health')
  .option('--json', 'Output as JSON')
  .option('--repair', 'Repair managed Hook, Rule, and deterministic selection state')
  .addOption(
    new Option('--strategy <strategy>', 'Pipeline root move recovery strategy').choices([
      'continue',
      'rollback',
    ]),
  )
  .addOption(
    new Option('--scope <scope>', 'Install scope to diagnose').choices([
      'auto',
      'global',
      'project',
    ]),
  )
  .action(async (targetPath = '.', options) => {
    const { doctorCommand } = await import('../commands/doctor.js');
    await doctorCommand(targetPath, options);
  });

program
  .command('update [path]')
  .description('Update Owner workflow files to the latest version')
  .option('--json', 'Output as JSON')
  .addOption(
    new Option('--platform <platform>', 'Platform target to update').choices(['claude', 'codex']),
  )
  .addOption(new Option('--language <lang>', 'Language for skills').choices(['en', 'zh']))
  .addOption(
    new Option(
      '--pipeline-layout <layout>',
      'Pipeline root to record when both roots exist',
    ).choices(['legacy', 'docs']),
  )
  .addOption(new Option('--scope <scope>', 'Install scope').choices(['global', 'project']))
  .option('--all-projects', 'Update all indexed project-scope Owner installs')
  .option('--current-project', 'Update only the current project')
  .option(
    '--self-update',
    'Update the Owner npm package and installed Pipeline dependencies before refreshing project assets',
  )
  .option('--skip-self-update', 'Skip the Owner npm package self-update')
  .addOption(new Option('--skip-npm', 'Deprecated alias for --skip-self-update').hideHelp())
  .action(async (targetPath = '.', options) => {
    const { updateCommand } = await import('../commands/update.js');
    const { exitCodeForCommandResult } = await import('../commands/command-result.js');
    const result = await updateCommand(targetPath, options);
    process.exitCode = exitCodeForCommandResult(result);
  });

program
  .command('uninstall [path]')
  .description('Remove Owner skills, rules, and hooks from your project or global scope')
  .option('--json', 'Output as JSON')
  .addOption(new Option('--scope <scope>', 'Uninstall scope').choices(['global', 'project']))
  .option('--all-projects', 'Uninstall all indexed project-scope Owner installs')
  .option('--current-project', 'Uninstall only the current project')
  .option('--force', 'Skip confirmation prompts')
  .action(async (targetPath = '.', options) => {
    const { uninstallCommand } = await import('../commands/uninstall.js');
    try {
      await uninstallCommand(targetPath, options);
    } catch (error) {
      if (error instanceof Error && error.name === 'ExitPromptError') {
        console.log('\n  Cancelled.\n');
        process.exit(0);
      }
      throw error;
    }
  });

const pipelineDescriptions: Record<PublicPipelineCommand, string> = {
  state: 'Read and update Pipeline workflow state',
  guard: 'Check Pipeline workflow phase guards',
  handoff: 'Create and inspect Pipeline workflow handoffs',
  archive: 'Archive completed Pipeline workflow changes',
};

for (const command of PUBLIC_PIPELINE_COMMANDS) {
  program
    .command(`${command} [args...]`)
    .description(pipelineDescriptions[command])
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async (args: string[]) => {
      const { runPipelineFacade } = await import('../commands/pipeline.js');
      process.exitCode = await runPipelineFacade(command as PublicPipelineCommand, args);
    });
}

program
  .command('pipeline [args...]')
  .description('Manage the Owner Pipeline workflow and its configured artifact root')
  .allowUnknownOption()
  .allowExcessArguments()
  .helpOption(false)
  .action(async (args: string[]) => {
    const { runPipelineGroupFacade } = await import('../commands/pipeline.js');
    process.exitCode = await runPipelineGroupFacade(args);
  });

program
  .command('loop [args...]')
  .description('Manage the self-contained Owner Loop workflow')
  .allowUnknownOption()
  .allowExcessArguments()
  .helpOption(false)
  .action(async (args: string[]) => {
    const { runLoopFacade } = await import('../commands/loop.js');
    process.exitCode = await runLoopFacade(args);
  });

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pipelineGroupArgs(argv: readonly string[]): string[] | null {
  const args = argv.slice(2);
  const pipelineIndex = args[0] === '--' ? 1 : 0;
  return args[pipelineIndex] === 'pipeline' ? args.slice(pipelineIndex + 1) : null;
}

async function runCli(): Promise<void> {
  try {
    const pipelineArgs = pipelineGroupArgs(process.argv);
    if (pipelineArgs) {
      const { runPipelineGroupFacade } = await import('../commands/pipeline.js');
      process.exitCode = await runPipelineGroupFacade(pipelineArgs);
      return;
    }

    await program.parseAsync();
  } catch (error) {
    const cancelled = error instanceof Error && error.name === 'ExitPromptError';
    const message = cancelled ? 'Command cancelled by user' : errorMessage(error);
    if (process.argv.includes('--json')) {
      console.log(
        JSON.stringify(
          {
            status: cancelled ? 'cancelled' : 'failed',
            error: message,
          },
          null,
          2,
        ),
      );
      console.error(`${cancelled ? 'Cancelled' : 'Error'}: ${message}`);
    } else {
      console.error(`\n  ${cancelled ? 'Cancelled.' : `Error: ${message}`}\n`);
    }
    process.exitCode = cancelled ? 130 : 1;
  }
}

await runCli();
