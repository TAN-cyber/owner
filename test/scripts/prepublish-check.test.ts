import { spawnSync } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const temporary: string[] = [];
const prepublishCheck = path.resolve('scripts/release/prepublish-check.js');

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function writeFile(root: string, relativePath: string, content: string): Promise<void> {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

async function makePackageFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-prepublish-check-'));
  temporary.push(root);
  await writeFile(
    root,
    'package.json',
    JSON.stringify(
      {
        name: 'owner-prepublish-check-fixture',
        version: '0.1.0',
        files: ['index.js', 'README.md'],
      },
      null,
      2,
    ),
  );
  await writeFile(root, 'README.md', '# Fixture\n');
  await writeFile(root, 'index.js', 'export const ok = true;\n');
  await writeFile(
    root,
    '.gitignore',
    ['scratch/.cache/', 'scratch/.pytest-temp-*/', ''].join('\n'),
  );
  return root;
}

describe('prepublish security check', () => {
  it('packs only the Owner runtime and distribution assets', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-publish-fixture-'));
    temporary.push(root);
    await writeFile(
      root,
      'package.json',
      JSON.stringify(
        {
          name: 'owner-publish-fixture',
          version: '0.1.0',
          files: ['assets', 'bin', 'dist', 'scripts/install/postinstall.js', 'README.md'],
        },
        null,
        2,
      ),
    );
    await writeFile(root, 'README.md', '# Owner\n');
    await writeFile(root, 'assets/manifest.json', '{"version":"0.1.0"}\n');
    await writeFile(root, 'bin/owner.js', '#!/usr/bin/env node\n');
    await writeFile(root, 'dist/app/cli/index.js', 'export {};\n');
    await writeFile(root, 'scripts/install/postinstall.js', 'export {};\n');
    await writeFile(root, 'eval/retired.json', '{"retired":true}\n');
    const npmCache = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-npm-cache-'));
    temporary.push(npmCache);
    const result = spawnSync(
      'npm',
      ['pack', '--dry-run', '--json', '--ignore-scripts', '--cache', npmCache],
      { cwd: root, encoding: 'utf8' },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const jsonStart = result.stdout.lastIndexOf('\n[');
    const [packed] = JSON.parse(result.stdout.slice(jsonStart + 1)) as Array<{
      files: Array<{ path: string }>;
    }>;
    const published = packed.files.map((file) => file.path);
    expect(published).toEqual(
      expect.arrayContaining([
        'assets/manifest.json',
        'bin/owner.js',
        'dist/app/cli/index.js',
        'scripts/install/postinstall.js',
      ]),
    );
    expect(published.some((file) => file.startsWith('eval/'))).toBe(false);
  });

  it('scans only files that npm would publish', async () => {
    const root = await makePackageFixture();
    await writeFile(
      root,
      'scratch/.cache/tool/source.ts',
      'const api_key = "abcdefghijklmnopqrstuvwxyz";\n',
    );

    const result = spawnSync(process.execPath, [prepublishCheck], {
      cwd: root,
      encoding: 'utf8',
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).not.toContain('[SECURITY]');
  });

  it('does not stat excluded directories while expanding included package paths', async () => {
    const root = await makePackageFixture();
    const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    packageJson.files = ['scratch', '!scratch/.cache', '!scratch/.pytest-*'];
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify(packageJson, null, 2));
    await writeFile(root, 'scratch/source.txt', 'fixture\n');

    for (const name of ['.cache', '.pytest-broken']) {
      const missingTarget = path.join(root, `removed-${name.replaceAll('.', '')}`);
      await fs.mkdir(missingTarget);
      await fs.symlink(
        missingTarget,
        path.join(root, 'scratch', name),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      await fs.rm(missingTarget, { recursive: true });
    }

    const result = spawnSync(process.execPath, [prepublishCheck], {
      cwd: root,
      encoding: 'utf8',
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('[SECURITY] No secrets detected. Safe to publish.');
  });
});
