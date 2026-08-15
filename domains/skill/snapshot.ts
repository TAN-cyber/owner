import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { loadSkillPackageDocument } from './load.js';
import type { SkillPackage } from './types.js';
import { validateSkillPackage } from './validate.js';

interface SnapshotFile {
  path: string;
  content: Buffer;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stable(item)]),
    );
  }
  return value;
}

function packageDocument(pkg: SkillPackage): unknown {
  return stable({
    ...(pkg.packageKind === 'runtime' ? { packageKind: 'runtime' } : {}),
    definition: pkg.definition,
    guardrails: pkg.guardrails,
    evals: pkg.evals,
  });
}

function normalizedRelativePath(source: string): string {
  return path.posix.normalize(source.replaceAll('\\', '/'));
}

function assertInside(parent: string, target: string, label: string): void {
  const relative = path.relative(parent, target);
  if (relative === '' || (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`))) {
    return;
  }
  throw new Error(`${label} resolves outside the Skill package`);
}

async function readPackageFile(
  root: string,
  relativePath: string,
  label: string,
): Promise<SnapshotFile> {
  const normalized = normalizedRelativePath(relativePath);
  if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`${label} resolves outside the Skill package`);
  }

  const target = path.resolve(root, ...normalized.split('/'));
  assertInside(root, target, label);

  let realTarget: string;
  try {
    realTarget = await fs.realpath(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${label} does not exist: ${relativePath}`, { cause: error });
    }
    throw error;
  }
  assertInside(root, realTarget, label);
  if (!(await fs.stat(realTarget)).isFile()) {
    throw new Error(`${label} is not a file: ${relativePath}`);
  }

  return { path: normalized, content: await fs.readFile(realTarget) };
}

async function snapshotFiles(pkg: SkillPackage): Promise<SnapshotFile[]> {
  const root = await fs.realpath(pkg.root);
  const files =
    pkg.packageKind === 'runtime' ? [] : [await readPackageFile(root, 'SKILL.md', 'SKILL.md')];
  for (const tool of pkg.definition.tools) {
    if (tool.kind !== 'script') continue;
    files.push(await readPackageFile(root, tool.source, `Script tool ${tool.id}`));
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function hashSnapshot(document: unknown, files: SnapshotFile[]): string {
  const fileDigests = files.map((file) => ({
    path: file.path,
    sha256: createHash('sha256').update(file.content).digest('hex'),
  }));
  return createHash('sha256')
    .update(JSON.stringify(stable({ package: document, files: fileDigests })))
    .digest('hex');
}

function packageJson(document: unknown): string {
  return JSON.stringify(document, null, 2) + '\n';
}

async function snapshotMaterial(pkg: SkillPackage): Promise<{
  document: unknown;
  files: SnapshotFile[];
  hash: string;
}> {
  const document = packageDocument(pkg);
  const files = await snapshotFiles(pkg);
  return { document, files, hash: hashSnapshot(document, files) };
}

export async function hashSkillPackage(pkg: SkillPackage): Promise<string> {
  return (await snapshotMaterial(pkg)).hash;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function verifyPublishedSnapshot(
  snapshotDir: string,
  material: { document: unknown; files: SnapshotFile[]; hash: string },
): Promise<void> {
  try {
    const storedHash = (await fs.readFile(path.join(snapshotDir, 'sha256'), 'utf8')).trim();
    if (storedHash !== material.hash) throw new Error('hash mismatch');
    const storedPackage = await fs.readFile(path.join(snapshotDir, 'package.json'), 'utf8');
    if (storedPackage !== packageJson(material.document)) throw new Error('package mismatch');
    for (const file of material.files) {
      const stored = await fs.readFile(path.join(snapshotDir, ...file.path.split('/')));
      if (!stored.equals(file.content)) throw new Error(`file mismatch: ${file.path}`);
    }
  } catch (error) {
    throw new Error(`Existing Skill snapshot is invalid: ${material.hash}`, { cause: error });
  }
}

export async function createSkillSnapshot(
  pkg: SkillPackage,
  changeDir: string,
): Promise<{ hash: string; snapshotDir: string }> {
  const material = await snapshotMaterial(pkg);
  const snapshotsRoot = path.resolve(changeDir, '.owner', 'skill-snapshots');
  const snapshotDir = path.join(snapshotsRoot, material.hash);
  await fs.mkdir(snapshotsRoot, { recursive: true });
  if (await pathExists(snapshotDir)) {
    await verifyPublishedSnapshot(snapshotDir, material);
    return { hash: material.hash, snapshotDir };
  }

  const temporaryDir = path.join(snapshotsRoot, `.tmp-${randomUUID()}`);
  assertInside(snapshotsRoot, temporaryDir, 'Temporary snapshot');
  assertInside(snapshotsRoot, snapshotDir, 'Published snapshot');

  try {
    await fs.mkdir(temporaryDir);
    for (const file of material.files) {
      const destination = path.join(temporaryDir, ...file.path.split('/'));
      assertInside(temporaryDir, destination, `Snapshot file ${file.path}`);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, file.content);
    }
    await fs.writeFile(path.join(temporaryDir, 'package.json'), packageJson(material.document));
    await fs.writeFile(path.join(temporaryDir, 'sha256'), material.hash + '\n');
    await fs.rename(temporaryDir, snapshotDir);
  } catch (error) {
    if (await pathExists(snapshotDir)) {
      try {
        await verifyPublishedSnapshot(snapshotDir, material);
      } finally {
        await fs.rm(temporaryDir, { recursive: true, force: true });
      }
      return { hash: material.hash, snapshotDir };
    }
    await fs.rm(temporaryDir, { recursive: true, force: true });
    throw error;
  }

  return { hash: material.hash, snapshotDir };
}

export async function readSkillSnapshot(changeDir: string, hash: string): Promise<SkillPackage> {
  if (!/^[a-f0-9]{64}$/u.test(hash)) {
    throw new Error(`Invalid Skill snapshot hash: ${hash}`);
  }
  const snapshotsRoot = path.resolve(changeDir, '.owner', 'skill-snapshots');
  const snapshotDir = path.join(snapshotsRoot, hash);
  assertInside(snapshotsRoot, snapshotDir, 'Skill snapshot');

  try {
    const storedHash = (await fs.readFile(path.join(snapshotDir, 'sha256'), 'utf8')).trim();
    if (storedHash !== hash) {
      throw new Error(`stored hash is ${storedHash || '(empty)'}`);
    }
    const packagePath = path.join(snapshotDir, 'package.json');
    const document = JSON.parse(await fs.readFile(packagePath, 'utf8')) as unknown;
    const pkg = loadSkillPackageDocument(document, snapshotDir, packagePath);
    const errors = validateSkillPackage(pkg);
    if (errors.length > 0) {
      throw new Error(errors.map((error) => `  - ${error}`).join('\n'));
    }
    const calculated = await hashSkillPackage(pkg);
    if (calculated !== hash) {
      throw new Error(`calculated hash is ${calculated}`);
    }
    return pkg;
  } catch (error) {
    throw new Error(`Skill snapshot is invalid or missing: ${hash}`, { cause: error });
  }
}
