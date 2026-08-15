import { describe, it, expect } from 'vitest';
import { quoteForShell, quoteArgsForShell } from '../../platform/process/shell-quote.js';

describe('shell-quote', () => {
  describe('quoteForShell', () => {
    it('leaves simple flags and identifiers unquoted', () => {
      expect(quoteForShell('init')).toBe('init');
      expect(quoteForShell('--tools')).toBe('--tools');
      expect(quoteForShell('--profile')).toBe('--profile');
      expect(quoteForShell('custom')).toBe('custom');
    });

    it('leaves paths without spaces or special chars unquoted', () => {
      expect(quoteForShell('/tmp/test')).toBe('/tmp/test');
      expect(quoteForShell('C:\\Projects\\Owner')).toBe('C:\\Projects\\Owner');
      expect(quoteForShell('claude,cursor')).toBe('claude,cursor');
      expect(quoteForShell('@fission-ai/openspec@latest')).toBe('@fission-ai/openspec@latest');
    });

    it('quotes paths containing spaces so the shell keeps them as one argument', () => {
      // Regression for issue #123: project path with spaces.
      expect(quoteForShell('C:\\Users\\Test User\\project')).toBe(
        '"C:\\Users\\Test User\\project"',
      );
      expect(quoteForShell('/home/test user/project')).toBe('"/home/test user/project"');
    });

    it('escapes embedded double quotes for cmd.exe', () => {
      expect(quoteForShell('a"b')).toBe('"a""b"');
    });

    it('quotes empty strings', () => {
      expect(quoteForShell('')).toBe('""');
    });
  });

  describe('quoteArgsForShell', () => {
    it('quotes only the arguments that need quoting, leaving the rest intact', () => {
      expect(
        quoteArgsForShell(['init', 'C:\\Users\\Test User\\project', '--tools', 'claude']),
      ).toEqual(['init', '"C:\\Users\\Test User\\project"', '--tools', 'claude']);
    });

    it('returns a new array without mutating the input', () => {
      const input = ['init', 'C:\\Users\\Test User\\project'];
      const result = quoteArgsForShell(input);
      expect(result).not.toBe(input);
      expect(input).toEqual(['init', 'C:\\Users\\Test User\\project']);
    });
  });
});
