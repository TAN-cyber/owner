import path from 'path';
import { describe, expect, it } from 'vitest';

import {
  OWNER_HOOK_PLATFORM_IDS,
  parseOwnerHookRequest,
  renderOwnerHookDecision,
} from '../../../domains/owner-entry/hook-adapter.js';

describe('Owner Hook platform adapter', () => {
  it('supports only Claude Code and Codex', () => {
    expect([...OWNER_HOOK_PLATFORM_IDS]).toEqual(['claude', 'codex']);
  });

  it('normalizes Claude and Codex write payloads', () => {
    expect(
      parseOwnerHookRequest(
        JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'src/a.ts' } }),
      ),
    ).toEqual({ intent: 'write', targets: ['src/a.ts'], toolName: 'Write' });
    expect(
      parseOwnerHookRequest(
        JSON.stringify({
          toolName: 'apply_patch',
          toolArgs: { patch: '*** Update File: src/b.ts' },
        }),
      ),
    ).toEqual({ intent: 'write', targets: ['src/b.ts'], toolName: 'apply_patch' });
  });

  it('normalizes raw Codex apply_patch input', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/existing.ts',
      '*** Add File: src/new.ts',
      '*** Delete File: src/old.ts',
      '*** End Patch',
    ].join('\n');

    expect(parseOwnerHookRequest(patch)).toEqual({
      intent: 'write',
      targets: ['src/existing.ts', 'src/new.ts', 'src/old.ts'],
      toolName: 'apply_patch',
    });
  });

  it('normalizes unified-diff targets and keeps absolute worktree roots', () => {
    expect(parseOwnerHookRequest(['--- a/src/old.ts', '+++ b/src/new.ts'].join('\n'))).toEqual({
      intent: 'write',
      targets: ['src/new.ts'],
      toolName: 'apply_patch',
    });

    const cwd = path.resolve('linked-worktree');
    expect(
      parseOwnerHookRequest(
        JSON.stringify({
          tool_name: 'Write',
          cwd,
          tool_input: { file_path: 'src/a.ts' },
        }),
      ),
    ).toEqual({ intent: 'write', targets: ['src/a.ts'], toolName: 'Write', cwd });
  });

  it('collects all targets and fails unknown writes closed', () => {
    expect(
      parseOwnerHookRequest(
        JSON.stringify({
          tool_name: 'Edit',
          tool_input: { file_paths: ['src/a.ts', 'src/b.ts'] },
        }),
      ),
    ).toEqual({ intent: 'write', targets: ['src/a.ts', 'src/b.ts'], toolName: 'Edit' });
    expect(parseOwnerHookRequest('{broken')).toEqual({
      intent: 'unknown',
      targets: [],
      toolName: null,
    });
    expect(
      parseOwnerHookRequest(
        JSON.stringify({
          tool_name: 'FutureWriteTool',
          tool_input: { file_path: 'src/future.ts' },
        }),
      ),
    ).toEqual({
      intent: 'unknown',
      targets: ['src/future.ts'],
      toolName: 'FutureWriteTool',
    });
  });

  it.each(['claude', 'codex'])('renders %s allow and deny through exit codes', (platformId) => {
    expect(renderOwnerHookDecision(platformId, { allowed: true, reason: 'allowed' })).toEqual({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
    expect(renderOwnerHookDecision(platformId, { allowed: false, reason: 'blocked' })).toEqual({
      exitCode: 2,
      stdout: '',
      stderr: 'blocked\n',
    });
  });

  it('rejects unsupported platforms', () => {
    expect(
      renderOwnerHookDecision('unknown-platform', { allowed: false, reason: 'blocked' }),
    ).toEqual({
      exitCode: 64,
      stdout: '',
      stderr: 'Unsupported Owner Hook platform: unknown-platform\n',
    });
  });
});
