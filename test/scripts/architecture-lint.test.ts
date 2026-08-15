import { spawnSync } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function writeFile(root: string, relativePath: string, content: string): Promise<void> {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

async function makeMinimalRepository(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-architecture-lint-'));
  temporary.push(root);
  const layout = {
    assetsRoot: 'assets',
    manifestPath: 'assets/manifest.json',
    skillsRoots: { en: 'assets/skills', zh: 'assets/skills-zh' },
    pipelineRuntime: {
      entries: { state: 'domains/owner-pipeline/pipeline-state-entry.ts' },
      outputs: { state: 'assets/skills/owner/scripts/owner-state.mjs' },
    },
    allowedTopLevelEntries: [
      '.gitignore',
      'AGENTS.md',
      'CLAUDE.md',
      'app',
      'assets',
      'config',
      'domains',
      'package.json',
      'platform',
      'scratch',
      'test',
    ],
    sourceRoots: ['app', 'domains', 'platform'],
    appModules: [],
    domainModules: ['owner-pipeline'],
    platformModules: [],
    scriptModules: [],
    testRoots: ['test'],
  };

  await Promise.all([
    fs.mkdir(path.join(root, 'app'), { recursive: true }),
    fs.mkdir(path.join(root, 'platform'), { recursive: true }),
    fs.mkdir(path.join(root, 'test'), { recursive: true }),
    fs.mkdir(path.join(root, 'assets', 'skills'), { recursive: true }),
    fs.mkdir(path.join(root, 'assets', 'skills-zh'), { recursive: true }),
    writeFile(root, 'config/repository-layout.json', JSON.stringify(layout, null, 2)),
    writeFile(root, 'assets/manifest.json', '{}\n'),
    writeFile(root, 'domains/owner-pipeline/pipeline-state-entry.ts', 'export {};\n'),
    writeFile(root, 'assets/skills/owner/scripts/owner-state.mjs', 'export {};\n'),
    writeFile(
      root,
      'package.json',
      JSON.stringify({
        scripts: {
          lint: 'eslint app/ domains/ platform/ && pnpm run lint:architecture',
          'lint:architecture': 'node scripts/lint/architecture.mjs',
        },
      }),
    ),
    writeFile(
      root,
      'AGENTS.md',
      '## 项目结构规范\n\n`app/` `domains/` `platform/`\n\nlegacy `test/ts` is banned.\n',
    ),
    writeFile(
      root,
      'CLAUDE.md',
      '## 项目结构规范\n\n`app/` `domains/` `platform/`\n\nlegacy `test/ts` is banned.\n',
    ),
  ]);
  return root;
}

function runArchitectureLint(root: string) {
  return spawnSync(process.execPath, [path.resolve('scripts', 'lint', 'architecture.mjs')], {
    cwd: root,
    encoding: 'utf8',
  });
}

describe('architecture lint', () => {
  it('ignores a Git-ignored local runtime directory', async () => {
    const root = await makeMinimalRepository();
    await writeFile(root, '.gitignore', '.local-runtime/\n');
    await writeFile(root, '.local-runtime/skills/owner/runtime.mjs', 'export {};\n');

    const result = runArchitectureLint(root);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('rejects executable source outside an approved code root', async () => {
    const root = await makeMinimalRepository();
    await writeFile(root, '.gitignore', 'scratch/.cache/\n');
    await writeFile(root, 'scratch/source.mjs', 'export {};\n');

    const result = runArchitectureLint(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('scratch/source.mjs is code outside an approved code root');
  });

  it('ignores nested cache directories listed in .gitignore', async () => {
    const root = await makeMinimalRepository();
    await writeFile(root, '.gitignore', 'scratch/.cache/\nscratch/**/.cache/\n');
    await Promise.all([
      writeFile(root, 'scratch/.cache/tool/src/index.ts', 'export {};\n'),
      writeFile(root, 'scratch/nested/.cache/tool/src/index.ts', 'export {};\n'),
    ]);

    const result = runArchitectureLint(root);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
