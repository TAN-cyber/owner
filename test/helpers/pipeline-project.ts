import { promises as fs } from 'fs';
import path from 'path';

/** Create the smallest healthy configured Pipeline workspace using legacy paths. */
export async function preparePipelineLegacyProject(projectRoot: string): Promise<void> {
  const openSpecRoot = path.join(projectRoot, 'openspec');
  await fs.mkdir(path.join(projectRoot, '.owner'), { recursive: true });
  await fs.mkdir(path.join(openSpecRoot, 'changes', 'archive'), { recursive: true });
  await fs.mkdir(path.join(openSpecRoot, 'specs'), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, '.owner', 'config.yaml'),
    [
      'schema: owner.project.v1',
      'default_workflow: pipeline',
      'workflows:',
      '  - pipeline',
      'pipeline:',
      '  artifact_layout: legacy',
      '  language: en',
      '  context_compression: off',
      '  review_mode: standard',
      '  auto_transition: true',
      '',
    ].join('\n'),
  );
  await fs.writeFile(path.join(openSpecRoot, 'config.yaml'), 'schema: spec-driven\n');
}
