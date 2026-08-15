import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { projectOwnerHooksFromInstalledScope } from '../../../domains/skill/project-hook-projection.js';

describe('project Hook projection', () => {
  let projectRoot: string;
  let sourceRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-project-hook-target-'));
    sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-project-hook-source-'));
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
    await fs.rm(sourceRoot, { recursive: true, force: true });
  });

  it('projects a global Codex Router into the project without copying selection state', async () => {
    const sourceRouter = path.join(
      sourceRoot,
      '.agents',
      'skills',
      'owner',
      'scripts',
      'owner-hook-router.mjs',
    );
    await fs.mkdir(path.dirname(sourceRouter), { recursive: true });
    await fs.mkdir(path.join(sourceRoot, '.codex'), { recursive: true });
    await fs.writeFile(sourceRouter, '// installed global Router\n', 'utf8');
    await fs.mkdir(path.join(sourceRoot, '.owner'), { recursive: true });
    await fs.writeFile(
      path.join(sourceRoot, '.owner', 'current-change.json'),
      '{"schema":"owner.selection.v2","workflow":"native","change":"global"}',
      'utf8',
    );

    await expect(
      projectOwnerHooksFromInstalledScope(projectRoot, sourceRoot, 'global', 'native', {
        globalBaseDir: sourceRoot,
      }),
    ).resolves.toEqual({ installedPlatforms: ['codex'], failures: [] });

    const projectHooks = await fs.readFile(path.join(projectRoot, '.codex', 'hooks.json'), 'utf8');
    expect(projectHooks.replaceAll('\\', '/')).toContain(
      `${projectRoot.replaceAll('\\', '/')}/.agents/skills/owner/scripts/owner-hook-router.mjs`,
    );
    await expect(
      fs.access(
        path.join(projectRoot, '.agents', 'skills', 'owner', 'scripts', 'owner-hook-router.mjs'),
      ),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(projectRoot, '.owner', 'current-change.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
