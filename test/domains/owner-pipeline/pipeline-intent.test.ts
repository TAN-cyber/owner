import { describe, expect, it } from 'vitest';
import {
  OwnerIntentValidationError,
  resolveOwnerIntentRoute,
  type OwnerIntentFrame,
} from '../../../domains/owner-pipeline/pipeline-intent.js';

function frame(overrides: Partial<OwnerIntentFrame> = {}): OwnerIntentFrame {
  const base: OwnerIntentFrame = {
    schema_version: 'owner.intent.v1',
    utterance: 'fix the failing owner guard regression',
    locale: 'en',
    intent: { name: 'fix_bug', confidence: 0.91 },
    entities: [{ type: 'bug_signal', value: 'regression', text: 'regression' }],
    slots: {
      requested_action: 'fix',
      workflow_candidate: 'hotfix',
      user_explicit_workflow: null,
      change_id: null,
      target_area: 'owner guard',
      scope: 'small',
      existing_behavior: true,
      new_capability: false,
      public_api_change: false,
      schema_change: false,
      cross_module_change: false,
    },
    context: {
      active_changes_count: 0,
      active_change_names: [],
      dirty_worktree: false,
    },
    evidence: [
      { field: 'intent.name', quote: 'fix', source: 'user' },
      { field: 'slots.workflow_candidate', quote: 'regression', source: 'user' },
    ],
    proposed_route: {
      name: 'hotfix',
      next_skill: 'owner-hotfix',
      confidence: 0.9,
      requires_confirmation: false,
      fallback_reason: null,
    },
  };
  return {
    ...base,
    ...overrides,
    intent: { ...base.intent, ...overrides.intent },
    slots: { ...base.slots, ...overrides.slots },
    context: { ...base.context, ...overrides.context },
    proposed_route: { ...base.proposed_route, ...overrides.proposed_route },
  };
}

describe('resolveOwnerIntentRoute', () => {
  it('routes existing bug fixes to hotfix', () => {
    const result = resolveOwnerIntentRoute(frame());

    expect(result.route).toMatchObject({
      name: 'hotfix',
      next_skill: 'owner-hotfix',
      requires_confirmation: false,
    });
  });

  it('accepts compact frames and normalizes omitted optional fields', () => {
    const result = resolveOwnerIntentRoute({
      schema_version: 'owner.intent.v1',
      utterance: 'fix the failing owner guard regression',
      intent: { name: 'fix_bug', confidence: 0.91 },
      slots: {
        requested_action: 'fix',
        workflow_candidate: 'hotfix',
        user_explicit_workflow: null,
        change_id: null,
        existing_behavior: true,
        new_capability: false,
        public_api_change: false,
        schema_change: false,
        cross_module_change: false,
      },
      context: {
        active_changes_count: 0,
        active_change_names: [],
      },
      evidence: [
        { field: 'intent.name', quote: 'fix', source: 'user' },
        { field: 'slots.workflow_candidate', quote: 'regression', source: 'user' },
      ],
      proposed_route: { name: 'hotfix', confidence: 0.9 },
    });

    expect(result.route).toMatchObject({ name: 'hotfix', next_skill: 'owner-hotfix' });
    expect(result.normalizedFrame).toMatchObject({
      locale: 'unknown',
      entities: [],
      slots: { target_area: null, scope: 'unknown' },
      context: { dirty_worktree: null },
      proposed_route: {
        next_skill: null,
        requires_confirmation: true,
        fallback_reason: null,
      },
    });
  });

  it('routes doc, config, and prompt changes to tweak', () => {
    const result = resolveOwnerIntentRoute(
      frame({
        utterance: 'tweak the owner prompt wording',
        intent: { name: 'make_tweak', confidence: 0.89 },
        entities: [{ type: 'file_path', value: 'assets/skills-zh/owner/SKILL.md', text: 'prompt' }],
        slots: {
          requested_action: 'modify',
          workflow_candidate: 'tweak',
          existing_behavior: null,
          target_area: 'prompt wording',
        },
        evidence: [
          { field: 'intent.name', quote: 'tweak', source: 'user' },
          { field: 'slots.workflow_candidate', quote: 'prompt wording', source: 'user' },
        ],
        proposed_route: { name: 'tweak', next_skill: 'owner-tweak', confidence: 0.88 },
      }),
    );

    expect(result.route).toMatchObject({ name: 'tweak', next_skill: 'owner-tweak' });
  });

  it('routes new capability and public API risk signals to full', () => {
    const result = resolveOwnerIntentRoute(
      frame({
        utterance: 'add a public API for intent routing',
        intent: { name: 'start_change', confidence: 0.93 },
        entities: [{ type: 'risk_signal', value: 'public_api_change', text: 'public API' }],
        slots: {
          requested_action: 'create',
          workflow_candidate: 'full',
          scope: 'large',
          existing_behavior: false,
          new_capability: true,
          public_api_change: true,
        },
        evidence: [
          { field: 'intent.name', quote: 'add', source: 'user' },
          { field: 'slots.public_api_change', quote: 'public API', source: 'user' },
        ],
        proposed_route: { name: 'full', next_skill: 'owner-open', confidence: 0.93 },
      }),
    );

    expect(result.route).toMatchObject({ name: 'full', next_skill: 'owner-open' });
  });

  it('does not ask user when route confidence is low but intent/slots/evidence is clear', () => {
    const result = resolveOwnerIntentRoute(
      frame({
        proposed_route: {
          name: 'ask_user',
          next_skill: null,
          confidence: 0.01,
          requires_confirmation: true,
          fallback_reason: 'low route confidence',
        },
      }),
    );

    expect(result.route.name).toBe('hotfix');
    expect(result.route.fallback_reason).toBeNull();
    expect(result.route.next_skill).toBe('owner-hotfix');
    expect(result.diagnostics.some((diagnostic) => diagnostic.includes('ask_user'))).toBe(true);
  });

  it('asks the user when explicit hotfix conflicts with risk signals', () => {
    const result = resolveOwnerIntentRoute(
      frame({
        utterance: 'use hotfix but add a public API',
        slots: {
          user_explicit_workflow: 'hotfix',
          workflow_candidate: 'hotfix',
          new_capability: true,
          public_api_change: true,
        },
        entities: [{ type: 'workflow', value: 'hotfix', text: 'hotfix' }],
        evidence: [
          { field: 'slots.user_explicit_workflow', quote: 'hotfix', source: 'user' },
          { field: 'slots.public_api_change', quote: 'public API', source: 'user' },
        ],
      }),
    );

    expect(result.route.name).toBe('ask_user');
    expect(result.route.fallback_reason).toContain('conflicts with risk signals');
  });

  it('asks the user when multiple active changes are possible and no change id is provided', () => {
    const result = resolveOwnerIntentRoute(
      frame({
        utterance: 'continue owner',
        intent: { name: 'resume_change', confidence: 0.9 },
        slots: { requested_action: 'continue', workflow_candidate: null },
        context: { active_changes_count: 2, active_change_names: ['a', 'b'] },
        evidence: [{ field: 'intent.name', quote: 'continue', source: 'user' }],
      }),
    );

    expect(result.route.name).toBe('ask_user');
    expect(result.route.fallback_reason).toContain('multiple active changes');
  });

  it('routes explicit resume with a matching change id to resume', () => {
    const result = resolveOwnerIntentRoute(
      frame({
        utterance: 'resume change intent-frame-routing',
        intent: { name: 'resume_change', confidence: 0.92 },
        slots: {
          requested_action: 'resume',
          workflow_candidate: null,
          change_id: 'intent-frame-routing',
        },
        context: {
          active_changes_count: 2,
          active_change_names: ['intent-frame-routing', 'other-change'],
        },
        evidence: [
          { field: 'intent.name', quote: 'resume', source: 'user' },
          { field: 'slots.change_id', quote: 'intent-frame-routing', source: 'user' },
        ],
      }),
    );

    expect(result.route).toMatchObject({ name: 'resume', next_skill: null });
  });

  it('asks the user when confidence is too low', () => {
    const result = resolveOwnerIntentRoute(
      frame({ intent: { name: 'fix_bug', confidence: 0.49 } }),
    );

    expect(result.route.name).toBe('ask_user');
    expect(result.route.fallback_reason).toContain('confidence');
  });

  it('throws a readable validation error for invalid schema', () => {
    const action = () => resolveOwnerIntentRoute({ schema_version: 'wrong' });

    expect(action).toThrow(OwnerIntentValidationError);
    expect(action).toThrow(/schema_version must be one of/);
  });

  it('throws when context.active_changes_count is not a valid integer', () => {
    const action = () =>
      resolveOwnerIntentRoute(
        frame({
          context: {
            active_changes_count: -1,
            active_change_names: ['a'],
          },
        }),
      );

    expect(action).toThrow(OwnerIntentValidationError);
    expect(action).toThrow(/context.active_changes_count/);
  });

  it('throws when context.active_change_names is not a string array', () => {
    const action = () =>
      resolveOwnerIntentRoute(
        frame({
          context: {
            active_changes_count: 1,
            active_change_names: ['ok', 1 as unknown as string],
          },
        }),
      );

    expect(action).toThrow(OwnerIntentValidationError);
    expect(action).toThrow(/active_change_names must only contain strings/);
  });

  it('records diagnostics when next_skill/requires_confirmation/fallback_reason are normalized', () => {
    const result = resolveOwnerIntentRoute(
      frame({
        proposed_route: {
          name: 'hotfix',
          next_skill: 'owner-open',
          confidence: 0.92,
          requires_confirmation: true,
          fallback_reason: 'manual set',
        },
      }),
    );

    expect(result.route.name).toBe('hotfix');
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        "agent proposed_route next_skill 'owner-open' normalized to 'owner-hotfix'",
        "agent proposed_route requires_confirmation 'true' normalized to 'false'",
        "agent proposed_route fallback_reason 'manual set' normalized to 'null'",
      ]),
    );
  });
});
