import { promises as fs } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

async function filesUnder(root: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) result.push(target);
    }
  };
  await visit(root);
  return result.sort();
}

async function combined(files: string[]): Promise<string> {
  return (await Promise.all(files.map((file) => fs.readFile(file, 'utf8')))).join('\n');
}

async function loopSpec(name: string): Promise<string> {
  return fs.readFile(path.resolve('docs', 'owner', 'specs', name, 'spec.md'), 'utf8');
}

describe('Owner Loop isolation boundaries', () => {
  it('keeps the Loop domain independent from Pipeline and OpenSpec execution', async () => {
    const files = (await filesUnder(path.resolve('domains', 'owner-loop'))).filter((file) =>
      file.endsWith('.ts'),
    );
    const source = await combined(files);

    expect(source).not.toMatch(/\bfrom\s+['"][^'"]*owner-pipeline[^'"]*['"]/u);
    expect(source).not.toMatch(/spawn(?:Sync)?\([^)]*openspec|execFile(?:Sync)?\([^)]*openspec/iu);
    expect(source).not.toMatch(/openspec[\\/]changes/iu);
    expect(source).toContain("'.owner/config.yaml'");
    expect(new Set(source.match(/\.owner\/[A-Za-z0-9._/-]+/gu) ?? [])).toEqual(
      new Set(['.owner/config.yaml', '.owner/current-change.json', '.owner/runtime/loop']),
    );
  });

  it('ships a self-contained Skill and runtime with no external workflow invocation', async () => {
    const skillFiles = [
      ...(await filesUnder(path.resolve('assets', 'skills', 'owner-loop'))),
      ...(await filesUnder(path.resolve('assets', 'skills-zh', 'owner-loop'))),
    ].filter((file) => /\.(?:md|mjs)$/u.test(file));
    const source = await combined(skillFiles);

    expect(source).not.toMatch(
      /requiredSkillCalls|openspec|superpowers|grill-me|brainstorming|test-driven-development|subagent-driven-development/iu,
    );
    expect(source).not.toMatch(/owner\s+(?:state|guard|handoff)\b/iu);
  });

  it('keeps both workflow domains independent below the entry seam', async () => {
    const [loopSource, pipelineSource] = await Promise.all([
      combined(
        (await filesUnder(path.resolve('domains', 'owner-loop'))).filter((file) =>
          file.endsWith('.ts'),
        ),
      ),
      combined(
        (await filesUnder(path.resolve('domains', 'owner-pipeline'))).filter((file) =>
          file.endsWith('.ts'),
        ),
      ),
    ]);

    expect(loopSource).not.toMatch(/\bfrom\s+['"][^'"]*owner-pipeline[^'"]*['"]/u);
    expect(pipelineSource).not.toMatch(/\bfrom\s+['"][^'"]*owner-loop[^'"]*['"]/u);
    for (const source of [loopSource, pipelineSource]) {
      const entryImports = source.match(/\bfrom\s+['"][^'"]*owner-entry[^'"]*['"]/gu) ?? [];
      expect(entryImports.length).toBeGreaterThan(0);
      expect(
        entryImports.every((entry) => /(?:current-selection|hook-adapter|hook-types)/u.test(entry)),
      ).toBe(true);
    }
  });

  it('keeps canonical Loop specs on the portable verification architecture', async () => {
    const [verification, loop, storage, resume, scope, workspace, init, parallel] =
      await Promise.all([
        loopSpec('loop-verification-evidence'),
        loopSpec('loop-completion-loop'),
        loopSpec('loop-runtime-storage'),
        loopSpec('loop-ambient-resume'),
        loopSpec('loop-scope-reopen'),
        loopSpec('loop-shape-workspace-isolation'),
        loopSpec('loop-init-workspace-defaults'),
        loopSpec('loop-parallel-worktree-tests'),
      ]);
    const canonical = [verification, loop, storage, resume, scope, workspace, init, parallel].join(
      '\n',
    );

    expect(verification).toContain('builder_execution_ref');
    expect(verification).toContain('verifier_execution_ref');
    expect(verification).toContain('每个已知验收 ID 恰好返回一次');
    expect(verification).toContain('Archive 不重新分派 Verifier');
    expect(loop).toContain('Build ↔ Verify');
    expect(loop).toContain('连续三个 attempt');
    expect(loop).toContain('loop.max_verify_failures');
    expect(storage).toContain('一个 active change 只有一份可携带权威：`owner-state.yaml`');
    expect(storage).toContain('│   ├── state.json');
    expect(storage).toContain('Archive 不重新运行必要检查或 Verifier');
    expect(resume).toContain('本机 Runtime 缺失不能使可同步的 active change 消失');
    expect(scope).toContain('实现继续使当前候选失效并返回 Build');
    expect(scope).toContain('正式需求修改返回 Shape');
    expect(workspace).toContain('portable workspace binding');
    expect(init).toContain('!.owner/config.yaml');
    expect(parallel).toContain('Builder/Verifier separation');

    expect(canonical).not.toMatch(
      /contractHash|approved_contract_hash|implementation_scope|verification_evidence|partial_allowance|base_hash|baseline-manifest\.json|trajectory\.jsonl|checkpoint-journal\.json|typed receipts|Archive freshness/iu,
    );
  });
});
