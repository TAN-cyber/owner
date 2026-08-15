import { describe, expect, it } from 'vitest';
import {
  formatSelectedSummary,
  getSelectedChoiceNames,
  invertChoices,
  renderSelectedSummaryLine,
  selectAllChoices,
  toggleChoice,
  type PlatformSelectChoice,
} from '../../app/commands/platform-select-prompt.js';

describe('platform select prompt state helpers', () => {
  const choices: PlatformSelectChoice<string>[] = [
    { name: 'Claude Code', value: 'claude' },
    { name: 'Codex (detected)', value: 'codex', checked: true },
  ];

  it('prefers summary names over display names for selected choices', () => {
    const selectedChoices: PlatformSelectChoice<string>[] = [
      { name: 'Claude Code', value: 'claude' },
      { name: 'Codex (detected)', summaryName: 'Codex', value: 'codex', checked: true },
    ];

    expect(getSelectedChoiceNames(selectedChoices)).toEqual(['Codex']);
  });

  it('formats selected summary with selected names', () => {
    expect(formatSelectedSummary('Selected:', ['Codex (detected)'], 'none')).toBe(
      'Selected: Codex (detected)',
    );
  });

  it('formats selected summary with empty label when nothing is selected', () => {
    expect(formatSelectedSummary('Selected:', [], 'none')).toBe('Selected: none');
  });

  it('returns checked choice names in display order', () => {
    expect(getSelectedChoiceNames(choices)).toEqual(['Codex (detected)']);
  });

  it('toggles one choice and updates selected names', () => {
    const next = toggleChoice(choices, 'claude');
    expect(getSelectedChoiceNames(next)).toEqual(['Claude Code', 'Codex (detected)']);
  });

  it('selects all choices', () => {
    const next = selectAllChoices(choices);
    expect(getSelectedChoiceNames(next)).toEqual(['Claude Code', 'Codex (detected)']);
  });

  it('inverts choices', () => {
    const next = invertChoices(choices);
    expect(getSelectedChoiceNames(next)).toEqual(['Claude Code']);
  });
});

describe('platform select prompt rendering helpers', () => {
  it('renders a stable selected summary line outside choices', () => {
    expect(renderSelectedSummaryLine('Selected:', ['Claude Code', 'Codex'], 'none')).toBe(
      '  Selected: Claude Code, Codex',
    );
  });

  it('renders the localized empty label when there are no selected choices', () => {
    expect(renderSelectedSummaryLine('已选择：', [], '无')).toBe('  已选择： 无');
  });
});
