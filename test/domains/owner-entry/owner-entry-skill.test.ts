import { promises as fs } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const chineseRoot = path.resolve('assets', 'skills-zh');
const englishRoot = path.resolve('assets', 'skills');

async function readSkill(root: string, name: string): Promise<string> {
  return fs.readFile(path.join(root, name, 'SKILL.md'), 'utf8');
}

describe('Chinese Owner entry Skills', () => {
  it('keeps /owner as a short configuration-only alias', async () => {
    const source = await readSkill(chineseRoot, 'owner');

    expect(source).toContain('name: owner');
    expect(source).toContain(
      'description: "Owner 工作流入口。当用户明确调用 /owner，或明确要求使用 Owner 但未指定 Native/Classic 时使用；解析项目配置并加载唯一入口。"',
    );
    expect(source).not.toContain('存在需要恢复的 active Owner change');
    expect(source).toContain('owner workflow resolve . --activate --json');
    expect(source).not.toContain('owner-entry-runtime.mjs . --json');
    expect(source).toContain('不得搜索 Skill 文件、扫描平台配置目录或直接调用内部 bundle');
    expect(source).toContain('command not found');
    expect(source).toContain('停止并说明');
    expect(source).toContain('CLI 已启动但返回非零');
    expect(source).toContain('owner.workflow-resolution.v1');
    expect(source).toContain('只接受');
    expect(source).toContain('/owner-native');
    expect(source).toContain('/owner-classic');
    expect(source).toContain('不根据任务');
    expect(source.length).toBeLessThan(2_000);
    expect(source).not.toMatch(/OpenSpec|Superpowers|brainstorming|TDD|\/owner-open/iu);
  });

  it('publishes the existing thick workflow only through /owner-classic', async () => {
    const source = await readSkill(chineseRoot, 'owner-classic');

    expect(source).toContain('name: owner-classic');
    expect(source).toContain('OpenSpec');
    expect(source).toContain('Superpowers');
    expect(source).toContain('owner state select <change-name>');
    expect(source).toContain('/owner-open');
    expect(source).toContain('/owner-build');
    expect(source).toContain('owner-classic/reference/scripts.md');
    expect(source.length).toBeGreaterThan(10_000);
    expect(source).not.toMatch(/\/owner(?![-/])/u);
  });

  it('keeps shared Classic references on the explicit Classic entry', async () => {
    const referenceRoot = path.join(chineseRoot, 'owner-classic', 'reference');
    const files = (await fs.readdir(referenceRoot)).filter((name) => name.endsWith('.md'));
    const source = (
      await Promise.all(files.map((name) => fs.readFile(path.join(referenceRoot, name), 'utf8')))
    ).join('\n');

    expect(source).toContain('/owner-classic');
    expect(source).not.toMatch(/\/owner(?![-/])/u);
  });

  it('keeps Classic child Skills inside the explicit Classic entry', async () => {
    const classicChildren = [
      'owner-open',
      'owner-design',
      'owner-build',
      'owner-verify',
      'owner-archive',
      'owner-hotfix',
      'owner-tweak',
    ];
    const sources = await Promise.all(classicChildren.map((name) => readSkill(chineseRoot, name)));

    for (const source of sources) {
      expect(source).not.toMatch(/\/owner(?![-/])/u);
      expect(source).not.toContain('/owner-native');
    }
  });

  it('publishes the bilingual Classic entry through the shared manifest', async () => {
    const manifest = JSON.parse(await fs.readFile(path.resolve('assets', 'manifest.json'), 'utf8'));

    expect(manifest.skills).toContain('owner-classic/SKILL.md');
  });
});

describe('English Owner entry Skills', () => {
  it('keeps /owner as a short configuration-only alias', async () => {
    const source = await readSkill(englishRoot, 'owner');

    expect(source).toContain('name: owner');
    expect(source).toContain(
      'description: "Owner workflow entry. Use when the user invokes /owner or asks to use Owner without choosing Native or Classic; resolve and load exactly one entry from project configuration."',
    );
    expect(source).not.toContain('an active Owner change needs to be resumed');
    expect(source).toContain('owner workflow resolve . --activate --json');
    expect(source).not.toContain('owner-entry-runtime.mjs . --json');
    expect(source).toContain(
      'Do not search for Skill files, scan platform configuration directories, or invoke an internal bundle directly',
    );
    expect(source).toContain('command not found');
    expect(source).toContain('stop and report');
    expect(source).toContain('If the CLI starts but exits nonzero');
    expect(source).toContain('owner.workflow-resolution.v1');
    expect(source).toContain('Only accept');
    expect(source).toContain('/owner-native');
    expect(source).toContain('/owner-classic');
    expect(source).toContain('Do not switch');
    expect(source.length).toBeLessThan(2_000);
    expect(source).not.toMatch(/OpenSpec|Superpowers|brainstorming|TDD|\/owner-open/iu);
  });

  it('publishes the existing thick workflow only through /owner-classic', async () => {
    const source = await readSkill(englishRoot, 'owner-classic');

    expect(source).toContain('name: owner-classic');
    expect(source).toContain('OpenSpec');
    expect(source).toContain('Superpowers');
    expect(source).toContain('owner state select <change-name>');
    expect(source).toContain('/owner-open');
    expect(source).toContain('/owner-build');
    expect(source).toContain('owner-classic/reference/scripts.md');
    expect(source.length).toBeGreaterThan(10_000);
    expect(source).not.toMatch(/\/owner(?![-/])/u);
  });

  it('keeps shared Classic references on the explicit Classic entry', async () => {
    const referenceRoot = path.join(englishRoot, 'owner-classic', 'reference');
    const files = (await fs.readdir(referenceRoot)).filter((name) => name.endsWith('.md'));
    const source = (
      await Promise.all(files.map((name) => fs.readFile(path.join(referenceRoot, name), 'utf8')))
    ).join('\n');

    expect(source).toContain('/owner-classic');
    expect(source).not.toMatch(/\/owner(?![-/])/u);
  });

  it('keeps Classic child Skills inside the explicit Classic entry', async () => {
    const classicChildren = [
      'owner-open',
      'owner-design',
      'owner-build',
      'owner-verify',
      'owner-archive',
      'owner-hotfix',
      'owner-tweak',
    ];
    const sources = await Promise.all(classicChildren.map((name) => readSkill(englishRoot, name)));

    for (const source of sources) {
      expect(source).not.toMatch(/\/owner(?![-/])/u);
      expect(source).not.toContain('/owner-native');
    }
  });
});
