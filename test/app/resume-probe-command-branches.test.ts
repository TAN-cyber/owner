import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveOwnerEntryResumeProbe, readWorkflowProjectConfigDocument } = vi.hoisted(() => ({
  resolveOwnerEntryResumeProbe: vi.fn(),
  readWorkflowProjectConfigDocument: vi.fn(),
}));

vi.mock('../../domains/owner-entry/resume-probe.js', () => ({
  OWNER_RESUME_PROBE_SCHEMA_VERSION: 'owner.entry.resume-probe.v1',
  resolveOwnerEntryResumeProbe,
}));
vi.mock('../../domains/workflow-contract/project-config-reader.js', () => ({
  readWorkflowProjectConfigDocument,
}));

import { resolveProjectLanguage, resumeProbeCommand } from '../../app/commands/resume-probe.js';

describe('resume-probe command branches', () => {
  let stdoutWrite: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resolveOwnerEntryResumeProbe.mockReset();
    readWorkflowProjectConfigDocument.mockReset();
    stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutWrite.mockRestore();
  });

  it('formats every optional probe field and derives the workflow context', async () => {
    readWorkflowProjectConfigDocument.mockResolvedValue({
      config: { default_workflow: 'loop' },
      loop: { language: ' zh-CN ' },
      pipeline: { language: 'en' },
    });
    resolveOwnerEntryResumeProbe.mockResolvedValue({
      action: 'resume',
      confidence: 'high',
      reason: 'active change found',
      workflow: 'loop',
      skill: 'owner-loop',
      entrySource: 'ambient',
      changeName: 'demo-change',
      phase: 'build',
      nextCommand: 'owner loop next demo-change',
    });

    await resumeProbeCommand('project', { utterance: 'continue' });

    expect(resolveOwnerEntryResumeProbe).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        utterance: 'continue',
        locale: 'zh-CN',
        agent_context: { non_trivial_work: true, already_in_owner_flow: false },
      }),
    );
    expect(stdoutWrite).toHaveBeenCalledWith(
      expect.stringContaining('entry_source: ambient\nchange: demo-change\nphase: build\n'),
    );
  });

  it('supports JSON output, empty utterances, and explicit non-work context', async () => {
    readWorkflowProjectConfigDocument.mockResolvedValue({
      config: { default_workflow: 'pipeline' },
      pipeline: { language: 'en' },
    });
    resolveOwnerEntryResumeProbe.mockResolvedValue({
      action: 'start',
      confidence: 'low',
      reason: 'no active change',
    });

    await resumeProbeCommand('project', {
      json: true,
      workflowWork: false,
      alreadyInOwnerFlow: true,
    });

    expect(resolveOwnerEntryResumeProbe).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        utterance: '',
        locale: 'en',
        agent_context: { non_trivial_work: false, already_in_owner_flow: true },
      }),
    );
    expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('"action": "start"'));
  });

  it.each([
    [
      'loop language',
      { config: { default_workflow: 'loop' }, loop: { language: 'zh-CN' } },
      'zh-CN',
    ],
    [
      'pipeline language',
      { config: { default_workflow: 'pipeline' }, pipeline: { language: 'en' } },
      'en',
    ],
    ['loop fallback', { config: { default_workflow: 'loop' }, pipeline: { language: 'en' } }, 'en'],
    ['missing config', null, 'unknown'],
    ['blank language', { loop: { language: '  ' } }, 'unknown'],
  ])('resolves %s', async (_label, document, expected) => {
    readWorkflowProjectConfigDocument.mockResolvedValue(document);
    await expect(resolveProjectLanguage('project')).resolves.toBe(expected);
  });

  it('falls back to unknown when project config loading fails', async () => {
    readWorkflowProjectConfigDocument.mockRejectedValue(new Error('broken config'));
    await expect(resolveProjectLanguage('project')).resolves.toBe('unknown');
  });
});
