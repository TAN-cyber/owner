import { describe, expect, it } from 'vitest';
import type { RuntimeAdapter } from '../../domains/engine/runtime-types.js';

describe('RuntimeAdapter contract', () => {
  it('keeps platform execution outside the engine', async () => {
    const calls: string[] = [];
    const adapter: RuntimeAdapter = {
      id: 'test',
      supports: (action) => action.type === 'invoke_skill',
      execute: async (action) => {
        calls.push(action.ref ?? '');
        return { actionId: action.id, status: 'succeeded', summary: 'ok' };
      },
    };
    expect(adapter.supports({ id: 'a', stepId: null, type: 'invoke_skill', ref: 'demo' })).toBe(
      true,
    );
    await adapter.execute(
      { id: 'a', stepId: null, type: 'invoke_skill', ref: 'demo' },
      { changeDir: '.', state: {} as never },
    );
    expect(calls).toEqual(['demo']);
  });
});
