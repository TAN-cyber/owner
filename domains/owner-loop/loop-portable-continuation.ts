import type { LoopChildrenInspection } from './loop-children.js';
import type { LoopPortableState } from './loop-portable-types.js';

export interface LoopPortableRunnerAction {
  kind: 'builder-handoff' | 'dispatch-verifier' | 'await-verifier' | 'retry-verifier' | 'none';
  candidateId: string | null;
  iteration: number;
  attempt: number;
}

export interface LoopPortableContinuation {
  schema: 'owner.loop.continuation.v2';
  skill: 'owner-loop';
  change: string;
  phase: LoopPortableState['phase'];
  status: LoopPortableState['status'];
  stateVersion: number;
  disposition: 'continue' | 'await-user' | 'blocked' | 'done';
  action:
    | 'confirm-shape'
    | 'confirm-skill-coordinated-pass'
    | 'confirm-verifier-unavailable'
    | 'resolve-verifier-blocker'
    | 'resolve-loop-stop'
    | 'advance-children'
    | 'builder-handoff'
    | 'dispatch-verifier'
    | 'await-verifier'
    | 'repair'
    | 'retry-verifier'
    | 'archive'
    | 'none';
  commandArgs: string[] | null;
  requiredInputs: string[];
  inputOptions: Array<{
    name: string;
    flag: string;
    valueKind: 'text' | 'confirmation' | 'json-file';
    required: boolean;
    template: unknown | null;
  }>;
  runnerAction: LoopPortableRunnerAction;
}

export function loopPortableContinuation(
  state: LoopPortableState,
  children?: LoopChildrenInspection | null,
): LoopPortableContinuation {
  const base = {
    schema: 'owner.loop.continuation.v2' as const,
    skill: 'owner-loop' as const,
    change: state.name,
    phase: state.phase,
    status: state.status,
    stateVersion: state.state_version,
    inputOptions: [] as LoopPortableContinuation['inputOptions'],
  };
  const runner = (kind: LoopPortableRunnerAction['kind']): LoopPortableRunnerAction => ({
    kind,
    candidateId: state.builder_handoff?.candidate_id ?? null,
    iteration: state.loop.iteration,
    attempt: state.loop.attempt,
  });
  if (state.status === 'done') {
    return {
      ...base,
      disposition: 'done',
      action: 'none',
      commandArgs: null,
      requiredInputs: [],
      runnerAction: runner('none'),
    };
  }
  if (state.status === 'await-user') {
    if (
      state.phase === 'verify' &&
      state.verification_result === 'pass' &&
      state.loop.next_action === 'confirm-skill-coordinated-pass'
    ) {
      return {
        ...base,
        disposition: 'await-user',
        action: 'confirm-skill-coordinated-pass',
        commandArgs: ['owner', 'loop', 'next', state.name, '--summary', '<summary>', '--confirmed'],
        requiredInputs: ['summary', 'user-confirmation'],
        inputOptions: [
          {
            name: 'summary',
            flag: '--summary',
            valueKind: 'text',
            required: true,
            template: null,
          },
          {
            name: 'confirmed',
            flag: '--confirmed',
            valueKind: 'confirmation',
            required: true,
            template: null,
          },
        ],
        runnerAction: runner('none'),
      };
    }
    if (
      state.phase === 'verify' &&
      state.verification?.assurance === 'semantic-verification-unavailable' &&
      state.loop.next_action === 'confirm-verifier-unavailable'
    ) {
      return {
        ...base,
        disposition: 'await-user',
        action: 'confirm-verifier-unavailable',
        commandArgs: ['owner', 'loop', 'next', state.name, '--summary', '<summary>', '--confirmed'],
        requiredInputs: ['summary', 'user-confirmation'],
        inputOptions: [
          {
            name: 'summary',
            flag: '--summary',
            valueKind: 'text',
            required: true,
            template: null,
          },
          {
            name: 'confirmed',
            flag: '--confirmed',
            valueKind: 'confirmation',
            required: true,
            template: null,
          },
        ],
        runnerAction: runner('none'),
      };
    }
    if (state.phase === 'verify' && state.loop.next_action === 'resolve-verifier-blocker') {
      return {
        ...base,
        disposition: 'await-user',
        action: 'resolve-verifier-blocker',
        commandArgs: [
          'owner',
          'loop',
          'next',
          state.name,
          '--summary',
          '<summary>',
          '--resolve-verifier-blocker',
        ],
        requiredInputs: ['summary', 'user-resolution'],
        inputOptions: [
          {
            name: 'summary',
            flag: '--summary',
            valueKind: 'text',
            required: true,
            template: null,
          },
        ],
        runnerAction: runner('none'),
      };
    }
    if (state.phase === 'verify' && state.loop.next_action === 'await-user') {
      return {
        ...base,
        disposition: 'await-user',
        action: 'resolve-loop-stop',
        commandArgs: [
          'owner',
          'loop',
          'next',
          state.name,
          '--return-to-build',
          '--summary',
          '<summary>',
        ],
        requiredInputs: ['summary', 'user-decision'],
        inputOptions: [
          {
            name: 'summary',
            flag: '--summary',
            valueKind: 'text',
            required: true,
            template: null,
          },
        ],
        runnerAction: runner('none'),
      };
    }
    return {
      ...base,
      disposition: 'await-user',
      action: 'none',
      commandArgs: null,
      requiredInputs: ['resolve-blocker'],
      runnerAction: runner('none'),
    };
  }
  if (state.status === 'blocked') {
    const retry = state.blockers.some(
      ({ resolution_action }) => resolution_action === 'retry-verifier',
    );
    return {
      ...base,
      disposition: 'blocked',
      action: retry ? 'retry-verifier' : 'none',
      commandArgs: retry
        ? ['owner', 'loop', 'next', state.name, '--retry-verifier', '--summary', '<summary>']
        : null,
      requiredInputs: retry ? ['summary'] : ['repair-runtime'],
      inputOptions: retry
        ? [
            {
              name: 'summary',
              flag: '--summary',
              valueKind: 'text',
              required: true,
              template: null,
            },
          ]
        : [],
      runnerAction: runner(retry ? 'retry-verifier' : 'none'),
    };
  }
  if (state.phase === 'shape') {
    return {
      ...base,
      disposition: 'continue',
      action: 'confirm-shape',
      commandArgs: ['owner', 'loop', 'next', state.name, '--summary', '<summary>', '--confirmed'],
      requiredInputs: ['summary', 'shared-understanding-confirmation'],
      inputOptions: [
        {
          name: 'summary',
          flag: '--summary',
          valueKind: 'text',
          required: true,
          template: null,
        },
        {
          name: 'confirmed',
          flag: '--confirmed',
          valueKind: 'confirmation',
          required: true,
          template: null,
        },
      ],
      runnerAction: runner('none'),
    };
  }
  if (state.phase === 'build') {
    if (children) {
      if (!children.confirmed) {
        return {
          ...base,
          disposition: 'continue',
          action: 'advance-children',
          commandArgs: ['owner', 'loop', 'next', state.name, '--summary', '<summary>'],
          requiredInputs: ['summary'],
          inputOptions: [
            {
              name: 'summary',
              flag: '--summary',
              valueKind: 'text',
              required: true,
              template: null,
            },
          ],
          runnerAction: runner('none'),
        };
      }
      if (state.loop.stage === 'repairing' && state.verification_result === 'fail') {
        return {
          ...base,
          disposition: 'continue',
          action: 'repair',
          commandArgs: null,
          requiredInputs: ['repair-child'],
          inputOptions: [],
          runnerAction: runner('none'),
        };
      }
      if (children.allDone) {
        return {
          ...base,
          disposition: 'continue',
          action: 'advance-children',
          commandArgs: ['owner', 'loop', 'next', state.name, '--summary', '<summary>'],
          requiredInputs: ['summary'],
          inputOptions: [
            {
              name: 'summary',
              flag: '--summary',
              valueKind: 'text',
              required: true,
              template: null,
            },
          ],
          runnerAction: runner('none'),
        };
      }
      const blocked = children.children.some(({ status }) => status === 'blocked');
      const progressing = children.children.some(
        ({ status }) => status === 'ready' || status === 'active',
      );
      return {
        ...base,
        disposition: blocked && !progressing ? 'blocked' : 'continue',
        action: 'advance-children',
        commandArgs: null,
        requiredInputs: blocked && !progressing ? ['resolve-child-blocker'] : ['ready-children'],
        inputOptions: [],
        runnerAction: runner('none'),
      };
    }
    return {
      ...base,
      disposition: 'continue',
      action: state.loop.stage === 'repairing' ? 'repair' : 'builder-handoff',
      commandArgs: ['owner', 'loop', 'next', state.name, '--runner-input', '<temporary-json-file>'],
      requiredInputs: ['builder-handoff-json-file'],
      inputOptions: [
        {
          name: 'runner-input',
          flag: '--runner-input',
          valueKind: 'json-file',
          required: true,
          template: {
            kind: 'builder-handoff',
            summary: '<summary>',
            addressed_acceptance_ids: ['<acceptance-id>'],
            checks: [{ name: '<check-name>', result: 'not-run', note: null }],
            known_limits: [],
          },
        },
      ],
      runnerAction: runner('builder-handoff'),
    };
  }
  if (state.phase === 'verify') {
    const awaiting = state.loop.next_action === 'await-verifier-result';
    return {
      ...base,
      disposition: 'continue',
      action: awaiting ? 'await-verifier' : 'dispatch-verifier',
      commandArgs: ['owner', 'loop', 'next', state.name, '--runner-input', '<temporary-json-file>'],
      requiredInputs: [
        awaiting ? 'verifier-response-or-error-json-file' : 'resolved-check-plan-json-file',
      ],
      inputOptions: [
        {
          name: 'runner-input',
          flag: '--runner-input',
          valueKind: 'json-file',
          required: true,
          template: awaiting
            ? [
                {
                  kind: 'verifier-response',
                  response: {
                    kind: 'request-checks',
                    iteration: state.loop.iteration,
                    attempt: state.loop.attempt,
                    checks: [
                      {
                        id: '<check-id>',
                        name: '<check-name>',
                        executable: '<executable>',
                        argv: [],
                        cwdRef: '.',
                        timeoutMs: 120000,
                        repeatable: true,
                      },
                    ],
                  },
                },
                {
                  kind: 'verifier-response',
                  response: {
                    kind: 'final-result',
                    result: {
                      iteration: state.loop.iteration,
                      attempt: state.loop.attempt,
                      verdict: '<pass|fail|blocked>',
                      acceptance: [
                        {
                          id: '<acceptance-id>',
                          result: '<passed|failed|blocked>',
                          reason: '<reason>',
                        },
                      ],
                      risks: [],
                      summary: '<summary>',
                    },
                  },
                },
                {
                  kind: 'verifier-execution-error',
                  summary: '<summary>',
                  stateVersion: state.state_version,
                  iteration: state.loop.iteration,
                  attempt: state.loop.attempt,
                  verifierExecutionRef: '<from verifierDispatch>',
                },
                {
                  kind: 'verifier-unavailable',
                  summary: '<why no independent semantic execution is available>',
                  stateVersion: state.state_version,
                  iteration: state.loop.iteration,
                  attempt: state.loop.attempt,
                  verifierExecutionRef: '<from verifierDispatch>',
                },
              ]
            : { kind: 'dispatch-verifier', checks: [] },
        },
      ],
      runnerAction: runner(awaiting ? 'await-verifier' : 'dispatch-verifier'),
    };
  }
  return {
    ...base,
    disposition: 'continue',
    action: 'archive',
    commandArgs: ['owner', 'loop', 'archive', state.name, '--confirmed'],
    requiredInputs: [],
    runnerAction: runner('none'),
  };
}
