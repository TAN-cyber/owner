import { describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { promises as fs } from 'fs';
import path from 'path';

type AssetsManifest = {
  skills: string[];
};

type PackageJson = {
  files?: string[];
};

const scriptsDirectory = path.resolve('assets', 'skills', 'owner', 'scripts');
const classicReferenceDirectory = path.resolve('assets', 'skills', 'owner-classic', 'reference');

function manifestScriptPath(fileName: string): string {
  return `owner/scripts/${fileName}`;
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf-8')) as T;
}

describe('Classic runtime release assets', () => {
  it('ships bilingual Classic references under the Classic entry', async () => {
    const manifest = await readJson<AssetsManifest>(path.resolve('assets', 'manifest.json'));
    const englishFiles = (await fs.readdir(classicReferenceDirectory))
      .filter((fileName) => fileName.endsWith('.md'))
      .sort();
    const chineseFiles = (
      await fs.readdir(path.resolve('assets', 'skills-zh', 'owner-classic', 'reference'))
    )
      .filter((fileName) => fileName.endsWith('.md'))
      .sort();
    const manifestReferences = manifest.skills
      .filter((skillPath) => skillPath.startsWith('owner-classic/reference/'))
      .sort();

    expect(chineseFiles).toEqual(englishFiles);
    expect(manifestReferences).toEqual(
      englishFiles.map((fileName) => `owner-classic/reference/${fileName}`),
    );
    expect(existsSync(path.resolve('assets', 'skills', 'owner', 'reference'))).toBe(false);
    expect(existsSync(path.resolve('assets', 'skills-zh', 'owner', 'reference'))).toBe(false);
  });

  it('lists every shipped Classic script in the assets manifest', async () => {
    const manifest = await readJson<AssetsManifest>(path.resolve('assets', 'manifest.json'));
    const scriptFiles = (await fs.readdir(scriptsDirectory))
      .filter((fileName) => fileName.endsWith('.mjs'))
      .sort();
    const manifestScripts = manifest.skills
      .filter((skillPath) => skillPath.startsWith('owner/scripts/'))
      .sort();

    expect(manifestScripts).toEqual(scriptFiles.map(manifestScriptPath).sort());
    expect(manifestScripts).toContain('owner/scripts/owner-runtime.mjs');
  });

  it('keeps relative launcher imports resolvable inside shipped scripts', async () => {
    const manifest = await readJson<AssetsManifest>(path.resolve('assets', 'manifest.json'));
    const scriptFiles = new Set(
      (await fs.readdir(scriptsDirectory)).filter((fileName) => fileName.endsWith('.mjs')),
    );
    const importPattern = /from\s+['"]\.\/([^'"]+)['"]/g;

    for (const fileName of scriptFiles) {
      const source = await fs.readFile(path.join(scriptsDirectory, fileName), 'utf-8');
      const imports = [...source.matchAll(importPattern)].map((match) => match[1]);

      for (const importName of imports) {
        expect(scriptFiles.has(importName), `${fileName} imports missing ${importName}`).toBe(true);
        expect(manifest.skills).toContain(manifestScriptPath(importName));
      }
    }
  });

  it('keeps npm package allowlist broad enough to ship Owner assets and installer', async () => {
    const packageJson = await readJson<PackageJson>(path.resolve('package.json'));

    expect(packageJson.files).toContain('assets');
    expect(packageJson.files).toContain('bin');
    expect(packageJson.files).toContain('dist');
    expect(packageJson.files?.some((entry) => entry.startsWith('eval'))).toBe(false);
    expect(packageJson.files).toContain('scripts/install/postinstall.js');
  });
});
