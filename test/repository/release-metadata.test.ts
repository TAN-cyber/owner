import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve('.');

describe('release metadata', () => {
  it('keeps package, lockfile, and asset manifest versions aligned', () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
    ) as { name: string; version: string };
    const packageLock = JSON.parse(
      readFileSync(path.join(repositoryRoot, 'package-lock.json'), 'utf8'),
    ) as { name: string; version: string; packages: { '': { name: string; version: string } } };
    const assetsManifest = JSON.parse(
      readFileSync(path.join(repositoryRoot, 'assets', 'manifest.json'), 'utf8'),
    ) as { version: string };

    expect(packageJson).toMatchObject({ name: 'owner', version: '0.1.0' });
    expect(packageLock.name).toBe(packageJson.name);
    expect(packageLock.packages[''].name).toBe(packageJson.name);
    expect(packageLock.version).toBe(packageJson.version);
    expect(packageLock.packages[''].version).toBe(packageJson.version);
    expect(assetsManifest.version).toBe(packageJson.version);
  });
});
