import { spawnSync } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

export const scriptsDir = path.resolve('assets', 'skills', 'owner', 'scripts');
export const pipelineRuntimeRoot = path.resolve('assets', 'skills', 'owner', 'runtime', 'pipeline');
export const pipelineSkillRoot = pipelineRuntimeRoot;

export function posixPath(filePath: string): string {
  return path.resolve(filePath).replace(/\\/g, '/');
}

export function runNode(
  cwd: string,
  script: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = {},
  timeout?: number,
) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      OWNER_RUNTIME_PIPELINE_ROOT: pipelineRuntimeRoot,
      OWNER_PIPELINE_SKILL_ROOT: pipelineRuntimeRoot,
      ...env,
    },
    timeout,
  });
}

export async function writeFile(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

export function runHookGuard(
  cwd: string,
  script: string,
  stdin: string,
  env: NodeJS.ProcessEnv = {},
) {
  return spawnSync(process.execPath, [script], {
    cwd,
    encoding: 'utf8',
    input: stdin,
    env: {
      ...process.env,
      OWNER_RUNTIME_PIPELINE_ROOT: pipelineRuntimeRoot,
      OWNER_PIPELINE_SKILL_ROOT: pipelineRuntimeRoot,
      ...env,
    },
  });
}

export function hookStdin(filePath: string): string {
  return JSON.stringify({
    tool_name: 'Write',
    tool_input: { file_path: filePath, content: '// test' },
  });
}

export async function createChange(
  tmpDir: string,
  name: string,
  yaml: string,
  tasks = '- [x] done\n',
) {
  const changeDir = path.join(tmpDir, 'openspec', 'changes', name);
  await fs.mkdir(changeDir, { recursive: true });
  await writeFile(path.join(changeDir, '.owner.yaml'), yaml);
  await writeFile(path.join(changeDir, 'proposal.md'), 'proposal\n');
  await writeFile(path.join(changeDir, 'design.md'), 'design\n');
  await writeFile(path.join(changeDir, 'tasks.md'), tasks);
  return changeDir;
}

export async function createFakeOpenSpecArchive(
  tmpDir: string,
  archiveDate = new Date().toISOString().slice(0, 10),
) {
  const binDir = path.join(tmpDir, 'fake-bin');
  await fs.mkdir(binDir, { recursive: true });
  const scriptPath = path.join(binDir, 'openspec-fake.mjs');
  const logFile = path.join(binDir, 'openspec-args.log');
  const absLog = logFile.replace(/\\/g, '/');
  const script = [
    '#!/usr/bin/env node',
    "import { promises as fs } from 'node:fs';",
    "import path from 'node:path';",
    `const LOG = ${JSON.stringify(absLog)};`,
    `const ARCHIVE_DATE = ${JSON.stringify(archiveDate)};`,
    'const exists = async (p) => fs.access(p).then(() => true).catch(() => false);',
    'function extractAdded(text) {',
    '  let out = ""; let inA = false;',
    '  for (const line of text.split(/\\r?\\n/)) {',
    "    if (line === '## ADDED Requirements') { inA = true; continue; }",
    '    if (/^## (MODIFIED|REMOVED|RENAMED) Requirements$/.test(line)) { inA = false; continue; }',
    '    if (inA) out += line + "\\n";',
    '  }',
    '  return out;',
    '}',
    'const args = process.argv.slice(2);',
    "await fs.writeFile(LOG, args.join(' ') + '\\n');",
    "if (args[0] !== 'archive') { console.error('unsupported openspec command: ' + (args[0] || '')); process.exit(1); }",
    'const change = args[1];',
    "const changeDir = path.join('openspec', 'changes', change);",
    "const archiveDir = path.join('openspec', 'changes', 'archive', ARCHIVE_DATE + '-' + change);",
    "const specsDir = path.join(changeDir, 'specs');",
    'if (await exists(specsDir)) {',
    '  for (const cap of (await fs.readdir(specsDir)).sort()) {',
    "    const delta = path.join(specsDir, cap, 'spec.md');",
    '    if (!(await exists(delta))) continue;',
    "    const main = path.join('openspec', 'specs', cap, 'spec.md');",
    '    await fs.mkdir(path.dirname(main), { recursive: true });',
    "    const base = (await exists(main)) ? await fs.readFile(main, 'utf8') : `# ${cap} Specification\\n\\n## Purpose\\nTBD\\n\\n## Requirements\\n`;",
    "    await fs.writeFile(main, base + extractAdded(await fs.readFile(delta, 'utf8')));",
    '  }',
    '}',
    'await fs.mkdir(path.dirname(archiveDir), { recursive: true });',
    'await fs.rename(changeDir, archiveDir);',
    "console.log('Change ' + change + ' archived as ' + ARCHIVE_DATE + '-' + change + '.');",
    '',
  ].join('\n');
  await fs.writeFile(scriptPath, script);
  let command: string;
  if (process.platform === 'win32') {
    command = `node "${scriptPath.replace(/\\/g, '/')}"`;
  } else {
    await fs.chmod(scriptPath, 0o755);
    command = scriptPath;
  }
  return { command, logFile };
}

export async function setupScripts(tmpDir: string) {
  await fs.mkdir(tmpDir, { recursive: true });
  const tmpScriptsDir = path.join(tmpDir, 'scripts');
  await fs.mkdir(tmpScriptsDir, { recursive: true });
  for (const name of [
    'owner-runtime.mjs',
    'owner-env.mjs',
    'owner-archive.mjs',
    'owner-guard.mjs',
    'owner-handoff.mjs',
    'owner-state.mjs',
    'owner-yaml-validate.mjs',
    'owner-hook-guard.mjs',
  ]) {
    const content = await fs.readFile(path.join(scriptsDir, name), 'utf-8');
    const destination = path.join(tmpScriptsDir, name);
    await fs.writeFile(destination, content.replace(/\r\n/g, '\n'));
    await fs.chmod(destination, 0o755);
  }
  return {
    guardScript: path.join(tmpScriptsDir, 'owner-guard.mjs'),
    stateScript: path.join(tmpScriptsDir, 'owner-state.mjs'),
    validateScript: path.join(tmpScriptsDir, 'owner-yaml-validate.mjs'),
    hookGuardScript: path.join(tmpScriptsDir, 'owner-hook-guard.mjs'),
  };
}
