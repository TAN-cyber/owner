import { promises as fs } from 'fs';
import path from 'path';

import { defaultProjectConfig, writeProjectConfig } from '../../domains/owner-loop/loop-config.js';
import { loopProjectPaths } from '../../domains/owner-loop/loop-paths.js';

export async function seedLoopRoot(projectRoot: string, artifactRoot: string): Promise<string> {
  await writeProjectConfig(projectRoot, defaultProjectConfig(artifactRoot));
  const paths = await loopProjectPaths(projectRoot, artifactRoot);
  await fs.mkdir(path.join(paths.loopRoot, 'specs', 'word-count'), { recursive: true });
  await fs.mkdir(path.join(paths.loopRoot, 'changes', 'active-change'), { recursive: true });
  await fs.writeFile(path.join(paths.loopRoot, 'specs', 'word-count', 'spec.md'), 'count words\n');
  await fs.writeFile(
    path.join(paths.loopRoot, 'changes', 'active-change', 'payload.bin'),
    Buffer.from([0, 1, 2, 250, 255]),
  );
  return paths.loopRoot;
}
