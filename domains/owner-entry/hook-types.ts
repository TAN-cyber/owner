import type { OwnerWorkflow } from './types.js';

export type OwnerHookIntent = 'write' | 'non-write' | 'unknown';

export interface OwnerHookRequest {
  intent: OwnerHookIntent;
  targets: string[];
  toolName: string | null;
  cwd?: string;
}

export interface OwnerHookDecision {
  allowed: boolean;
  reason: string;
  workflow?: OwnerWorkflow;
  change?: string;
  phase?: string;
}

export interface OwnerHookProcessOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}
