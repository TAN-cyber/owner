import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const layoutPath = path.join(repoRoot, 'config', 'repository-layout.json');

export function readRepositoryLayout() {
  return JSON.parse(fs.readFileSync(layoutPath, 'utf8'));
}

export function resolveRepositoryPath(relativePath) {
  if (relativePath === '.') {
    return repoRoot;
  }
  return path.join(repoRoot, ...relativePath.split('/'));
}
