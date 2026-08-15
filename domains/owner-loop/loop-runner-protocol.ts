const TRUSTED_IDENTITY = Symbol('owner.loop.trusted-execution-identity');
const TRUSTED_ENVELOPE = Symbol('owner.loop.trusted-verifier-envelope');

export const LOOP_SKILL_COORDINATION = 'skill-coordinated' as const;

export interface LoopRunnerExecutionIdentityInput {
  identityProvider: string;
  executionRef: string;
}

export interface LoopTrustedExecutionIdentity {
  readonly identityProvider: string;
  readonly executionRef: string;
  readonly [TRUSTED_IDENTITY]: true;
}

export interface LoopTrustedVerifierEnvelope<TPayload> {
  readonly candidateId: string;
  readonly identityProvider: string;
  readonly verifierExecutionRef: string;
  readonly payload: TPayload;
  readonly [TRUSTED_ENVELOPE]: true;
}

export interface LoopRunnerChannel {
  captureExecutionIdentity(input: LoopRunnerExecutionIdentityInput): LoopTrustedExecutionIdentity;
  envelopeVerifierResponse<TPayload>(options: {
    candidateId: string;
    identity: LoopTrustedExecutionIdentity;
    payload: TPayload;
  }): LoopTrustedVerifierEnvelope<TPayload>;
}

function requiredOpaqueText(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\u0000')) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

/**
 * Create the package-local Runner seam.
 *
 * This constructor is shipped with Owner and can be called by any local
 * process, so it can only create Skill-coordinated identities. A future host
 * attestation path must live outside this package boundary instead of trusting
 * caller-provided provider strings.
 */
export function createLoopRunnerChannel(): LoopRunnerChannel {
  const identities = new WeakSet<object>();
  return Object.freeze({
    captureExecutionIdentity(
      input: LoopRunnerExecutionIdentityInput,
    ): LoopTrustedExecutionIdentity {
      requiredOpaqueText(input.identityProvider, 'Loop identity provider');
      const identity = Object.freeze({
        identityProvider: LOOP_SKILL_COORDINATION,
        executionRef: requiredOpaqueText(input.executionRef, 'Loop execution ref'),
        [TRUSTED_IDENTITY]: true as const,
      });
      identities.add(identity);
      return identity;
    },
    envelopeVerifierResponse<TPayload>(options: {
      candidateId: string;
      identity: LoopTrustedExecutionIdentity;
      payload: TPayload;
    }): LoopTrustedVerifierEnvelope<TPayload> {
      if (!identities.has(options.identity)) {
        throw new Error('Loop execution identity was not captured by this Runner channel');
      }
      return Object.freeze({
        candidateId: requiredOpaqueText(options.candidateId, 'Loop candidate ID'),
        identityProvider: options.identity.identityProvider,
        verifierExecutionRef: options.identity.executionRef,
        payload: options.payload,
        [TRUSTED_ENVELOPE]: true as const,
      });
    },
  });
}

export function isLoopTrustedVerifierEnvelope<TPayload>(
  value: unknown,
): value is LoopTrustedVerifierEnvelope<TPayload> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[TRUSTED_ENVELOPE] === true
  );
}

export function isLoopTrustedExecutionIdentity(
  value: unknown,
): value is LoopTrustedExecutionIdentity {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[TRUSTED_IDENTITY] === true
  );
}
