import path from 'path';
import { appendEngineRunText } from '../engine/protected-run-file.js';
import type { PipelineState } from './pipeline-state.js';
import type { PipelineTransitionEffect, PipelineTransitionEvent } from './pipeline-transitions.js';

export type PipelineStateEventSource = 'owner-state' | 'owner-guard' | 'owner-archive';

export interface PipelineStateEventInput {
  change: string;
  event: PipelineTransitionEvent | 'rebind';
  source: PipelineStateEventSource;
  from: PipelineState;
  to: PipelineState;
  effects: PipelineTransitionEffect[];
}

export interface PipelineStateEventRecord extends PipelineStateEventInput {
  schemaVersion: 1;
  timestamp: string;
}

export const PIPELINE_STATE_EVENT_LOG = path.join('.owner', 'state-events.jsonl');
const PIPELINE_STATE_EVENT_MAX_BYTES = 8 * 1024 * 1024;

export async function appendPipelineStateEvent(
  changeDir: string,
  input: PipelineStateEventInput,
): Promise<PipelineStateEventRecord> {
  const record: PipelineStateEventRecord = {
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    ...input,
  };
  await appendEngineRunText(
    changeDir,
    PIPELINE_STATE_EVENT_LOG,
    `${JSON.stringify(record)}\n`,
    PIPELINE_STATE_EVENT_MAX_BYTES,
    'Pipeline state event log',
  );
  return record;
}
