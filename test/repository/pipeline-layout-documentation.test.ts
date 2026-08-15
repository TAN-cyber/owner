import { promises as fs } from 'fs';
import { describe, expect, it } from 'vitest';

const documentation = [
  'docs/operations/AUTO-TRANSITION.md',
  'docs/operations/CONTEXT-COMPRESSION.md',
] as const;

describe('Pipeline layout documentation', () => {
  it.each(documentation)('uses the resolved change directory in %s', async (documentPath) => {
    const content = await fs.readFile(documentPath, 'utf8');

    expect(content).toContain('`<pipeline-change-dir>`');
    expect(content).not.toContain('`openspec/changes/<name>`');
  });

  it.each(['README.md', 'README-zh.md'])(
    'documents the default Pipeline path in %s',
    async (path) => {
      const content = await fs.readFile(path, 'utf8');

      expect(content).toContain('docs/openspec/changes/<change>/.owner.yaml');
    },
  );
});
