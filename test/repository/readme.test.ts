import { describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';

const readmes = ['README.md', 'README-zh.md'] as const;

async function readBoth(): Promise<[string, string]> {
  return Promise.all([fs.readFile('README.md', 'utf-8'), fs.readFile('README-zh.md', 'utf-8')]);
}

describe('Owner README contract', () => {
  it('documents Native and Classic as explicit workflow choices', async () => {
    const [english, chinese] = await readBoth();

    for (const content of [english, chinese]) {
      expect(content).toContain('Native');
      expect(content).toContain('Classic');
      expect(content).toContain('--workflow native');
      expect(content).toContain('--workflow both');
      expect(content).toContain('owner-native');
      expect(content).toContain('owner-classic');
    }
  });

  it('limits public host support to Claude Code and Codex', async () => {
    const [english, chinese] = await readBoth();

    for (const content of [english, chinese]) {
      expect(content).toContain('--platform claude');
      expect(content).toContain('--platform codex');
      expect(content).toContain('.claude/skills/');
      expect(content).toContain('.agents/skills/');
      expect(content).not.toMatch(/--platform (?:cursor|opencode|gemini|windsurf)\b/u);
    }
  });

  it('makes host mutation conditional on explicit init', async () => {
    const [english, chinese] = await readBoth();

    expect(english).toContain('only after the user explicitly runs `owner init`');
    expect(chinese).toContain('只有用户显式执行 `owner init`');
    expect(chinese).toContain('不会把可分发仓库本身安装到仓库作者当前的 Codex 环境');
  });

  it('documents GitHub distribution without claiming an unpublished repository URL', async () => {
    const [english, chinese] = await readBoth();

    for (const content of [english, chinese]) {
      expect(content).toContain('git+https://github.com/<YOUR_GITHUB_USER>/owner.git');
    }
  });

  it('keeps the documented Node.js requirement aligned with package engines', async () => {
    const packageJson = JSON.parse(await fs.readFile('package.json', 'utf-8')) as {
      engines: { node: string };
    };
    const match = packageJson.engines.node.match(/^>=(\d+)/);
    expect(match).not.toBeNull();
    const minimumMajor = match![1];
    const [readmeEn, readmeZh, contributingEn, contributingZh] = await Promise.all([
      fs.readFile('README.md', 'utf-8'),
      fs.readFile('README-zh.md', 'utf-8'),
      fs.readFile('CONTRIBUTING.md', 'utf-8'),
      fs.readFile('CONTRIBUTING-zh.md', 'utf-8'),
    ]);

    expect(readmeEn).toContain(`Node.js ${minimumMajor}+`);
    expect(readmeZh).toContain(`Node.js ${minimumMajor}+`);
    expect(contributingEn).toContain(`Node.js \`>=${minimumMajor}\``);
    expect(contributingZh).toContain(`Node.js \`>=${minimumMajor}\``);
  });

  it('documents recovery boundaries and license information', async () => {
    const [english, chinese] = await readBoth();

    expect(english).toContain('Unsynced code cannot be recovered');
    expect(chinese).toContain('未提交、未 push、未同步的旧设备代码不能通过状态文件凭空恢复');
    for (const content of [english, chinese]) {
      expect(content).toContain('[LICENSE](./LICENSE)');
      expect(content).not.toMatch(/derived from|upstream baseline/iu);
    }
  });
});
