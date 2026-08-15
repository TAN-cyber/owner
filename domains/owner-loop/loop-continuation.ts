import type {
  LoopArchiveConfirmation,
  LoopChangeState,
  LoopClarificationMode,
  LoopContinuation,
  LoopContinuationAction,
  LoopContinuationDisposition,
  LoopContinuationInputOption,
  LoopStructuredFinding,
} from './loop-types.js';
import { isLoopWorkspaceAdvisoryCode } from './loop-workspace.js';

const REPAIR_CODES =
  /^(?:run-|trajectory-|checkpoint-(?:missing|mismatch|invalid|progress-invalid)|transition-(?:incomplete|invalid))/u;

interface ContinuationFields {
  disposition: LoopContinuationDisposition;
  action: LoopContinuationAction;
  commandArgs?: string[] | null;
  command?: string | null;
  requiresUserDecision?: boolean;
  requiredInputs?: string[];
  inputOptions?: LoopContinuationInputOption[];
}

function displayArg(value: string): string {
  return /^[A-Za-z0-9_./:=+@-]+$/u.test(value) ? value : JSON.stringify(value);
}

function displayCommand(commandArgs: readonly string[] | null): string | null {
  return commandArgs ? commandArgs.map(displayArg).join(' ') : null;
}

function commandArgsFromDisplay(command: string | null): string[] | null {
  if (command === null) return null;
  const values = command.match(/"(?:[^"\\]|\\.)*"|'[^']*'|\S+/gu);
  if (!values || values[0] !== 'owner') return null;
  return values.map((value) => {
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        return JSON.parse(value) as string;
      } catch {
        return value.slice(1, -1);
      }
    }
    if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
    return value;
  });
}

function inputOption(
  input: string,
  flags: string[],
  placeholder: string | null,
  options: Partial<
    Pick<LoopContinuationInputOption, 'required' | 'choices' | 'repeatable' | 'alterloopGroup'>
  > = {},
): LoopContinuationInputOption {
  return {
    input,
    flags,
    required: options.required ?? true,
    placeholder,
    ...(options.choices ? { choices: options.choices } : {}),
    ...(options.repeatable ? { repeatable: true } : {}),
    ...(options.alterloopGroup ? { alterloopGroup: options.alterloopGroup } : {}),
  };
}

function optionsForInputs(inputs: readonly string[]): LoopContinuationInputOption[] {
  return inputs.map((input) => inputOption(input, [], null));
}

function phaseCommand(state: LoopChangeState): {
  commandArgs: string[];
  requiredInputs: string[];
  inputOptions: LoopContinuationInputOption[];
} {
  const commandArgs = ['owner', 'loop', 'next', state.name, '--summary', '<summary>'];
  const inputOptions = [inputOption('summary', ['--summary'], '<summary>')];
  if (state.phase === 'shape') {
    commandArgs.push('--confirmed');
    inputOptions.push(inputOption('shared-understanding-confirmation', ['--confirmed'], null));
    return {
      commandArgs,
      requiredInputs: ['summary', 'shared-understanding-confirmation'],
      inputOptions,
    };
  }
  if (state.phase === 'build') {
    commandArgs.push('--artifact', '<project-relative-path>');
    inputOptions.push(
      inputOption('artifact-or-no-code-reason', ['--artifact'], '<project-relative-path>', {
        repeatable: true,
        alterloopGroup: 'build-evidence',
      }),
      inputOption('artifact-or-no-code-reason', ['--no-code-reason'], '<reason>', {
        alterloopGroup: 'build-evidence',
      }),
    );
    const requiredInputs = ['summary', 'artifact-or-no-code-reason'];
    if (state.approval !== 'confirmed') {
      commandArgs.push('--confirmed');
      requiredInputs.push('shared-understanding-confirmation');
      inputOptions.push(inputOption('shared-understanding-confirmation', ['--confirmed'], null));
    }
    return { commandArgs, requiredInputs, inputOptions };
  }
  if (state.phase === 'verify') {
    commandArgs.push('--result', '<pass|fail>', '--report', '<change-relative-path>');
    inputOptions.push(
      inputOption('verification-result', ['--result'], '<pass|fail>', {
        choices: ['pass', 'fail'],
      }),
      inputOption('verification-report', ['--report'], '<change-relative-path>'),
    );
    return {
      commandArgs,
      requiredInputs: ['summary', 'verification-result', 'verification-report'],
      inputOptions,
    };
  }
  return { commandArgs, requiredInputs: [], inputOptions: [] };
}

function buildContinuation(state: LoopChangeState, fields: ContinuationFields): LoopContinuation {
  const commandArgs =
    fields.commandArgs === undefined
      ? commandArgsFromDisplay(fields.command ?? null)
      : fields.commandArgs;
  return {
    schema: 'owner.loop.continuation.v1',
    skill: 'owner-loop',
    change: state.name,
    phase: state.phase,
    revision: state.revision,
    disposition: fields.disposition,
    action: fields.action,
    command: fields.command === undefined ? displayCommand(commandArgs ?? null) : fields.command,
    commandArgs: commandArgs ?? null,
    requiresUserDecision: fields.requiresUserDecision ?? false,
    requiredInputs: fields.requiredInputs ?? [],
    inputOptions: fields.inputOptions ?? optionsForInputs(fields.requiredInputs ?? []),
  };
}

export function loopContinuation(options: {
  state: LoopChangeState;
  findings?: readonly LoopStructuredFinding[];
  archiveReady?: boolean;
  evidenceRetreat?: boolean;
  done?: boolean;
  clarificationMode?: LoopClarificationMode;
  archiveConfirmation?: LoopArchiveConfirmation;
  archivePreflightHash?: string;
}): LoopContinuation {
  const findings = options.findings ?? [];
  const actionableFindings = findings.filter(
    (finding) => !isLoopWorkspaceAdvisoryCode(finding.code),
  );
  const decision = actionableFindings.find((finding) => finding.requiresUserDecision);
  const repair = actionableFindings.find(
    (finding) => finding.repairCommand !== null || REPAIR_CODES.test(finding.code),
  );
  const repairDecision = actionableFindings.find(
    (finding) =>
      finding.code === 'repair-iteration-limit' || finding.code === 'repair-override-exhausted',
  );
  const stagnationStop = actionableFindings.find(
    (finding) => finding.code === 'repair-stagnation-stop',
  );
  const workspaceBindingFailure = actionableFindings.find(
    (finding) =>
      finding.requiredAction === 'return-to-bound-working-directory' ||
      finding.requiredAction === 'repair-workspace-binding',
  );
  const runtimeMissing = actionableFindings.find((finding) => finding.code === 'runtime-missing');
  const requiredInputs = [
    ...new Set(actionableFindings.map((finding) => finding.requiredAction)),
  ].sort();

  if (options.done) {
    return buildContinuation(options.state, {
      disposition: 'done',
      action: 'none',
      commandArgs: null,
    });
  }
  if (repairDecision) {
    return buildContinuation(options.state, {
      disposition: 'await-user',
      action: 'work-phase',
      commandArgs: null,
      requiresUserDecision: true,
      requiredInputs: ['repair-continuation-decision'],
      inputOptions: [
        inputOption('repair-continuation-decision', [], null, {
          choices: ['continue', 'change-contract', 'stop'],
        }),
      ],
    });
  }
  if (decision) {
    return buildContinuation(options.state, {
      disposition: 'await-user',
      action: 'work-phase',
      commandArgs: null,
      requiresUserDecision: true,
      requiredInputs,
    });
  }
  if (stagnationStop) {
    return buildContinuation(options.state, {
      disposition: 'blocked',
      action: 'repair',
      commandArgs: null,
      requiredInputs: ['new-repair-hypothesis'],
    });
  }
  if (workspaceBindingFailure) {
    return buildContinuation(options.state, {
      disposition: 'blocked',
      action: 'none',
      commandArgs: null,
      requiredInputs,
    });
  }
  if (runtimeMissing) {
    return buildContinuation(options.state, {
      disposition: 'continue',
      action: 'advance-phase',
      commandArgs: ['owner', 'loop', 'next', options.state.name, '--summary', '<summary>'],
      requiredInputs: ['summary'],
      inputOptions: [inputOption('summary', ['--summary'], '<summary>')],
    });
  }
  if (repair) {
    return buildContinuation(options.state, {
      disposition: 'blocked',
      action: 'repair',
      command: repair.repairCommand,
      requiredInputs,
    });
  }
  if (options.evidenceRetreat) {
    const commandArgs = ['owner', 'loop', 'next', options.state.name, '--summary', '<summary>'];
    return buildContinuation(options.state, {
      disposition: 'continue',
      action: 'advance-phase',
      commandArgs,
      requiredInputs: ['summary'],
      inputOptions: [inputOption('summary', ['--summary'], '<summary>')],
    });
  }
  if (options.state.phase === 'build' && options.state.verification_result === 'fail') {
    return buildContinuation(options.state, {
      disposition: 'continue',
      action: 'work-phase',
      commandArgs: null,
      requiredInputs: ['repair-verification-gaps'],
    });
  }
  if (actionableFindings.length > 0) {
    if (options.state.phase === 'archive') {
      return buildContinuation(options.state, {
        disposition: 'blocked',
        action: 'none',
        commandArgs: null,
        requiredInputs,
      });
    }
    if (requiredInputs.includes('refresh-verification-receipts')) {
      return buildContinuation(options.state, {
        disposition: 'continue',
        action: 'work-phase',
        commandArgs: ['owner', 'loop', 'receipt', 'refresh', options.state.name, '--apply'],
        requiredInputs,
      });
    }
    return buildContinuation(options.state, {
      disposition: 'continue',
      action: 'work-phase',
      commandArgs: null,
      requiredInputs,
    });
  }
  if (options.state.phase === 'archive') {
    if (options.archiveReady && options.archivePreflightHash) {
      if (!/^[a-f0-9]{64}$/u.test(options.archivePreflightHash)) {
        throw new Error('Loop Archive continuation preflight must be a SHA-256 hash');
      }
      const commandArgs = [
        'owner',
        'loop',
        'archive',
        options.state.name,
        '--expect-preflight',
        options.archivePreflightHash,
      ];
      if (options.archiveConfirmation === 'required') {
        commandArgs.push('--confirmed');
        return buildContinuation(options.state, {
          disposition: 'await-user',
          action: 'archive',
          commandArgs,
          command: null,
          requiresUserDecision: true,
          requiredInputs: ['archive-confirmation'],
          inputOptions: [
            inputOption('archive-confirmation', ['--confirmed'], null, {
              choices: ['confirm', 'keep-active'],
            }),
          ],
        });
      }
      return buildContinuation(options.state, {
        disposition: 'continue',
        action: 'archive',
        commandArgs,
      });
    }
    return buildContinuation(options.state, {
      disposition: options.archiveReady ? 'continue' : 'blocked',
      action: options.archiveReady ? 'archive' : 'none',
      commandArgs: options.archiveReady
        ? ['owner', 'loop', 'archive', options.state.name, '--dry-run']
        : null,
      requiredInputs: options.archiveReady ? [] : ['archive-readiness'],
    });
  }
  const phase = phaseCommand(options.state);
  return buildContinuation(options.state, {
    disposition: 'continue',
    action: 'advance-phase',
    commandArgs: phase.commandArgs,
    requiredInputs: phase.requiredInputs,
    inputOptions: phase.inputOptions,
  });
}
