import { createHash } from 'crypto';
import type { WorkflowProtocol } from './types.js';

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stableValue(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

export function hashWorkflowProtocol(protocol: WorkflowProtocol): string {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(protocol)))
    .digest('hex');
}
