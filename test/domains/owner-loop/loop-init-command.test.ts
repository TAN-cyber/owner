import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loopInitCommand } from '../../../domains/owner-loop/loop-init-command.js';
import {
  defaultProjectConfig,
  writeProjectConfig,
} from '../../../domains/owner-loop/loop-config.js';

describe('Loop init command branches', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-loop-init-command-'));
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('initializes a project with the default artifact root', async () => {
    await expect(loopInitCommand([], projectRoot)).resolves.toMatchObject({
      command: 'init',
      exitCode: 0,
      data: { artifactRoot: 'docs', language: 'en' },
    });
  });

  it('rejects a conflicting requested root', async () => {
    await writeProjectConfig(projectRoot, defaultProjectConfig('docs'));

    await expect(loopInitCommand(['--root', 'other-docs'], projectRoot)).rejects.toThrow(
      'refusing conflicting root other-docs',
    );
  });

  it('reuses an existing Loop project config', async () => {
    await writeProjectConfig(projectRoot, defaultProjectConfig('docs', 'zh-CN'));

    await expect(loopInitCommand([], projectRoot)).resolves.toMatchObject({
      command: 'init',
      exitCode: 0,
      data: { artifactRoot: 'docs', language: 'zh-CN' },
    });
  });

  it('rejects initialization while a root move is pending', async () => {
    const config = defaultProjectConfig('docs');
    config.loop.pending_root_move = {
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      fromArtifactRoot: '.',
      toArtifactRoot: 'docs',
      stage: 'switched',
      cleanup: {
        kind: 'forward-source',
        state: 'deleting',
        manifestHash: 'a'.repeat(64),
      },
    };
    await writeProjectConfig(projectRoot, config);

    await expect(loopInitCommand([], projectRoot)).rejects.toThrow(
      'Loop root move aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee is incomplete',
    );
  });
});
