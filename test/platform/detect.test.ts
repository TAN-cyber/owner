import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  detectPlatforms,
  hasPlatformDetectionPath,
  hasSkills,
} from '../../platform/install/detect.js';
import { SUPPORTED_PLATFORM_IDS, SUPPORTED_PLATFORMS } from '../../platform/install/platforms.js';

describe('Claude Code and Codex detection', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-detect-'));
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('registers exactly the two supported hosts', () => {
    expect(SUPPORTED_PLATFORM_IDS).toEqual(['claude', 'codex']);
    expect(SUPPORTED_PLATFORMS.map(({ id }) => id)).toEqual(['claude', 'codex']);
  });

  it('detects Claude Code from its project directory', async () => {
    await fs.mkdir(path.join(projectRoot, '.claude'), { recursive: true });

    await expect(detectPlatforms(projectRoot)).resolves.toEqual(new Set(['claude']));
  });

  it('detects Codex only when its config evidence exists', async () => {
    await fs.mkdir(path.join(projectRoot, '.agents', 'skills'), { recursive: true });
    await expect(detectPlatforms(projectRoot)).resolves.toEqual(new Set());

    await fs.mkdir(path.join(projectRoot, '.codex'), { recursive: true });
    await expect(detectPlatforms(projectRoot)).resolves.toEqual(new Set(['codex']));
  });

  it('detects both supported hosts independently', async () => {
    await Promise.all([
      fs.mkdir(path.join(projectRoot, '.claude'), { recursive: true }),
      fs.mkdir(path.join(projectRoot, '.codex'), { recursive: true }),
    ]);

    await expect(detectPlatforms(projectRoot)).resolves.toEqual(new Set(['claude', 'codex']));
  });

  it('recognizes managed Owner, OpenSpec, and Superpowers skills', async () => {
    const claude = SUPPORTED_PLATFORMS.find(({ id }) => id === 'claude')!;
    const skillsRoot = path.join(projectRoot, '.claude', 'skills');
    await Promise.all(
      ['owner', 'openspec-apply-change', 'using-superpowers'].map((name) =>
        fs.mkdir(path.join(skillsRoot, name), { recursive: true }),
      ),
    );

    await expect(hasSkills(projectRoot, claude, 'owner')).resolves.toBe(true);
    await expect(hasSkills(projectRoot, claude, 'openspec')).resolves.toBe(true);
    await expect(hasSkills(projectRoot, claude, 'superpowers')).resolves.toBe(true);
  });

  it('requires Codex detection evidence when resolving a selected target', async () => {
    const codex = SUPPORTED_PLATFORMS.find(({ id }) => id === 'codex')!;

    await expect(hasPlatformDetectionPath(projectRoot, codex)).resolves.toBe(false);
    await fs.mkdir(path.join(projectRoot, '.codex'), { recursive: true });
    await expect(hasPlatformDetectionPath(projectRoot, codex)).resolves.toBe(true);
  });
});
