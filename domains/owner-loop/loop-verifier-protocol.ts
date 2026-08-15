import {
  isLoopTrustedVerifierEnvelope,
  type LoopTrustedVerifierEnvelope,
} from './loop-runner-protocol.js';

export type LoopAcceptanceVerdict = 'passed' | 'failed' | 'blocked';

export interface LoopVerifierAcceptanceResult {
  id: string;
  result: LoopAcceptanceVerdict;
  reason: string;
}

export interface LoopVerifierFinalResult {
  iteration: number;
  attempt: number;
  verdict: 'pass' | 'fail' | 'blocked';
  acceptance: LoopVerifierAcceptanceResult[];
  risks: string[];
  summary: string;
}

export interface LoopVerifierCheckRequest {
  id: string;
  name: string;
  executable: string;
  argv: string[];
  cwdRef: string;
  timeoutMs: number;
  repeatable: boolean;
}

export type LoopVerifierResponse =
  | {
      kind: 'request-checks';
      iteration: number;
      attempt: number;
      checks: LoopVerifierCheckRequest[];
    }
  | {
      kind: 'final-result';
      result: LoopVerifierFinalResult;
    };

export interface LoopVerifierBinding {
  candidateId: string;
  identityProvider: string;
  builderExecutionRef: string;
  iteration: number;
  attempt: number;
  acceptanceIds: readonly string[];
  requiredChecksPassed: boolean;
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} fields are invalid`);
  }
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value as number;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be non-empty text`);
  }
  return value;
}

function parseAcceptance(value: unknown): LoopVerifierAcceptanceResult[] {
  if (!Array.isArray(value)) throw new Error('Loop Verifier acceptance must be an array');
  return value.map((entry, index) => {
    const item = plainRecord(entry, `Loop Verifier acceptance ${index}`);
    exactKeys(item, ['id', 'result', 'reason'], `Loop Verifier acceptance ${index}`);
    const id = text(item.id, `Loop Verifier acceptance ${index} ID`);
    if (!['passed', 'failed', 'blocked'].includes(String(item.result))) {
      throw new Error(`Loop Verifier acceptance ${id} result is invalid`);
    }
    return {
      id,
      result: item.result as LoopAcceptanceVerdict,
      reason: text(item.reason, `Loop Verifier acceptance ${id} reason`),
    };
  });
}

function parseFinalResult(value: unknown): LoopVerifierFinalResult {
  const input = plainRecord(value, 'Loop Verifier final result');
  exactKeys(
    input,
    ['iteration', 'attempt', 'verdict', 'acceptance', 'risks', 'summary'],
    'Loop Verifier final result',
  );
  if (!['pass', 'fail', 'blocked'].includes(String(input.verdict))) {
    throw new Error('Loop Verifier verdict is invalid');
  }
  if (!Array.isArray(input.risks) || !input.risks.every((risk) => typeof risk === 'string')) {
    throw new Error('Loop Verifier risks must be text entries');
  }
  return {
    iteration: integer(input.iteration, 'Loop Verifier iteration'),
    attempt: integer(input.attempt, 'Loop Verifier attempt'),
    verdict: input.verdict as LoopVerifierFinalResult['verdict'],
    acceptance: parseAcceptance(input.acceptance),
    risks: input.risks as string[],
    summary: text(input.summary, 'Loop Verifier summary'),
  };
}

function parseCheckRequest(value: unknown, index: number): LoopVerifierCheckRequest {
  const input = plainRecord(value, `Loop Verifier check request ${index}`);
  exactKeys(
    input,
    ['id', 'name', 'executable', 'argv', 'cwdRef', 'timeoutMs', 'repeatable'],
    `Loop Verifier check request ${index}`,
  );
  if (!Array.isArray(input.argv) || !input.argv.every((entry) => typeof entry === 'string')) {
    throw new Error(`Loop Verifier check request ${index} argv is invalid`);
  }
  if (typeof input.repeatable !== 'boolean') {
    throw new Error(`Loop Verifier check request ${index} repeatable is invalid`);
  }
  const timeoutMs = integer(input.timeoutMs, `Loop Verifier check request ${index} timeout`);
  if (timeoutMs < 1) throw new Error('Loop Verifier check timeout must be positive');
  return {
    id: text(input.id, `Loop Verifier check request ${index} ID`),
    name: text(input.name, `Loop Verifier check request ${index} name`),
    executable: text(input.executable, `Loop Verifier check request ${index} executable`),
    argv: input.argv as string[],
    cwdRef: text(input.cwdRef, `Loop Verifier check request ${index} cwd`),
    timeoutMs,
    repeatable: input.repeatable,
  };
}

export function parseLoopVerifierResponse(value: unknown): LoopVerifierResponse {
  const input = plainRecord(value, 'Loop Verifier response');
  if (input.kind === 'final-result') {
    exactKeys(input, ['kind', 'result'], 'Loop Verifier response');
    return { kind: 'final-result', result: parseFinalResult(input.result) };
  }
  if (input.kind === 'request-checks') {
    exactKeys(input, ['kind', 'iteration', 'attempt', 'checks'], 'Loop Verifier response');
    if (!Array.isArray(input.checks) || input.checks.length === 0) {
      throw new Error('Loop Verifier check request batch must be non-empty');
    }
    return {
      kind: 'request-checks',
      iteration: integer(input.iteration, 'Loop Verifier iteration'),
      attempt: integer(input.attempt, 'Loop Verifier attempt'),
      checks: input.checks.map(parseCheckRequest),
    };
  }
  throw new Error('Loop Verifier response kind is invalid');
}

export function normalizeLoopCheckRequestId(request: LoopVerifierCheckRequest): string {
  return JSON.stringify([
    request.id,
    request.executable,
    request.argv,
    request.cwdRef.replaceAll('\\', '/'),
  ]);
}

export function validateLoopTrustedVerifierEnvelope(options: {
  envelope: LoopTrustedVerifierEnvelope<unknown> | unknown;
  binding: LoopVerifierBinding;
}): LoopVerifierResponse {
  if (!isLoopTrustedVerifierEnvelope<unknown>(options.envelope)) {
    throw new Error('Loop Verifier result must come from the trusted Runner channel');
  }
  const { envelope, binding } = options;
  if (envelope.candidateId !== binding.candidateId) {
    throw new Error('Loop Verifier result does not match the current candidate');
  }
  if (envelope.identityProvider !== binding.identityProvider) {
    throw new Error('Loop Verifier identity provider does not match the Builder provider');
  }
  if (envelope.verifierExecutionRef === binding.builderExecutionRef) {
    throw new Error('Loop Builder and Verifier must be different executions');
  }
  const response = parseLoopVerifierResponse(envelope.payload);
  const iteration =
    response.kind === 'final-result' ? response.result.iteration : response.iteration;
  const attempt = response.kind === 'final-result' ? response.result.attempt : response.attempt;
  if (iteration !== binding.iteration || attempt !== binding.attempt) {
    throw new Error('Loop Verifier result is stale for the current iteration or attempt');
  }
  if (response.kind === 'request-checks') return response;

  const expected = [...binding.acceptanceIds];
  const actual = response.result.acceptance.map(({ id }) => id);
  const duplicates = actual.filter((id, index) => actual.indexOf(id) !== index);
  const unknown = actual.filter((id) => !expected.includes(id));
  const missing = expected.filter((id) => !actual.includes(id));
  if (duplicates.length > 0 || unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `Loop Verifier acceptance coverage is invalid (duplicate: ${[...new Set(duplicates)].join(', ') || 'none'}; unknown: ${unknown.join(', ') || 'none'}; missing: ${missing.join(', ') || 'none'})`,
    );
  }
  if (!binding.requiredChecksPassed && response.result.verdict === 'pass') {
    throw new Error('Loop verification cannot pass before every required check succeeds');
  }
  const results = response.result.acceptance.map(({ result }) => result);
  if (response.result.verdict === 'pass' && results.some((result) => result !== 'passed')) {
    throw new Error('Loop pass requires every acceptance criterion to pass');
  }
  if (response.result.verdict === 'fail' && !results.includes('failed')) {
    throw new Error('Loop fail requires at least one failed acceptance criterion');
  }
  if (response.result.verdict === 'blocked' && !results.includes('blocked')) {
    throw new Error('Loop blocked verdict requires at least one blocked acceptance criterion');
  }
  return response;
}
