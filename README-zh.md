# Owner

Owner 是一个面向 Claude Code 和 Codex 的可恢复 vibe coding 工作流。它把一次 AI 代码变更组织为需求确认、实现、验证、失败修复和归档闭环，并提供两套互相独立的工作流：

- **Loop**：`Shape → Build ↔ Verify → Archive`。面向自主规划能力较强的模型，使用 Owner 自带 Runtime，不依赖 OpenSpec 或 Superpowers。
- **Pipeline**：`Open → Design → Build → Verify → Archive`。使用 OpenSpec 管理 WHAT，使用 Superpowers 管理深设计、计划、TDD、调试和评审，Owner 负责状态、守卫、恢复和归档。

Owner 仅支持：

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- [Codex](https://developers.openai.com/codex/skills)

Owner 使用 MIT License。详见 [LICENSE](./LICENSE)。

## 为什么需要 Owner

直接 vibe coding 常见的失败不是模型完全不会写代码，而是长任务中的工程状态失控：

1. 聊天压缩、网络中断或换设备后，模型不知道做到哪个任务、哪轮验证。
2. Builder 运行自己新增的测试后就宣布完成，但测试集合可能漏掉验收条件。
3. 需求、设计、代码、测试和主规格分别存在，却没有可靠的生命周期连接。
4. 多 Agent、分支、worktree 和脏工作区导致文件归属与状态冲突。
5. 失败后无限自动修复，持续消耗 Token，却没有明确停止条件。

Owner 用磁盘状态、阶段守卫、候选版本、Runtime check receipt、独立验证、失败预算、工作区绑定和归档事务处理这些问题。

## Loop 与 Pipeline 怎么选

| 维度 | Loop | Pipeline |
|---|---|---|
| 流程 | Shape → Build ↔ Verify → Archive | Open → Design → Build → Verify → Archive |
| 规格 | brief + 完整目标 spec + acceptance | OpenSpec proposal + delta spec + tasks |
| 实现方法 | Agent 自主选择 | Superpowers 设计、计划、TDD、调试、评审 |
| 验证 | Runtime evidence + 只读 Verifier | Guard + 分层 review + light/full Verify |
| 恢复 | portable state + continuation + CAS | `.owner.yaml` + plan/tasks + checkpoint + hash |
| 成本 | 阶段与上下文更少 | 产物、Agent 轮次与审查更多 |
| 适合 | 普通中型业务、强模型、Token 敏感 | 支付、权限、迁移、并发、公共 API |

两套工作流不是轻重档位，也不会在任务中自动互相切换。统一入口只读取 `.owner/config.yaml`，确定性加载其中一套。

## 环境要求

- Node.js 22+
- npm 或 pnpm
- Git
- Claude Code 或 Codex
- Pipeline 模式需要网络安装 OpenSpec 与 Superpowers

## 从 npm 安装

```bash
npm install @redv/owner
npx owner --version
```

也可以从 [TAN-cyber](https://github.com/TAN-cyber) 仓库克隆后本地构建：

```bash
git clone https://github.com/TAN-cyber/owner.git
cd owner
corepack enable
pnpm install
pnpm build
npm link
```

下载或安装 CLI **不会自动修改 Claude Code 或 Codex 配置**。只有用户显式执行 `npx owner init` 后，Owner 才会把 Skills、Rules 和 Hooks 写入用户选择的宿主和范围。

## 初始化

### 安装到一个项目

Codex + Loop：

```bash
npx owner init /path/to/project \
  --scope project \
  --platform codex \
  --workflow loop
```

Claude Code + Pipeline：

```bash
npx owner init /path/to/project \
  --scope project \
  --platform claude \
  --workflow pipeline
```

同时安装 Loop 和 Pipeline：

```bash
npx owner init /path/to/project \
  --scope project \
  --platform codex \
  --workflow both
```

### 安装到用户范围

```bash
npx owner init --scope global --platform codex --workflow both
npx owner init --scope global --platform claude --workflow both
```

项目配置首次激活后写入 `<project>/.owner/config.yaml`。后续全局默认变化不会静默修改已经激活的项目。

### 非交互安装

```bash
npx owner init /path/to/project \
  --yes \
  --scope project \
  --platform codex \
  --workflow both \
  --language zh \
  --json
```

`--platform` 只接受 `claude` 或 `codex`。未知平台会被明确拒绝。

## 安装路径

| 宿主 | 项目 Skills | 用户 Skills | Rules/Hooks |
|---|---|---|---|
| Claude Code | `.claude/skills/` | `~/.claude/skills/` | `.claude/rules/`、`.claude/settings.local.json` |
| Codex | `.agents/skills/` | `~/.agents/skills/` | `.codex/rules/`、`.codex/hooks.json` |

Codex 的 `.agents/skills` 路径遵循[官方 Skills 文档](https://developers.openai.com/codex/skills)。Owner 不会把可分发仓库本身安装到仓库作者当前的 Codex 环境。

## 使用方式

### 统一入口

在 Claude Code 中使用：

```text
/owner 实现订单取消与幂等退款
```

在 Codex 中可通过 `$owner` 显式选择 Skill，也可以让 Codex 根据 Skill description 自动调用：

```text
$owner 实现订单取消与幂等退款
```

统一入口执行：

```bash
npx owner workflow resolve . --activate --json
```

它只返回 `owner-loop` 或 `owner-pipeline`，不会根据文件数或模型临场判断切换工作流。

### 显式入口

```text
/owner-loop   # Claude Code
/owner-pipeline  # Claude Code

$owner-loop   # Codex
$owner-pipeline  # Codex
```

## Loop 工作流

Loop 用户可读产物默认位于：

```text
docs/owner/
├── changes/<change>/
│   ├── owner-state.yaml
│   ├── brief.md
│   ├── specs/<capability>/spec.md
│   └── verification.md
├── specs/
└── archive/
```

本机锁、日志、任务、receipt 和 transaction 位于 `.owner/runtime/loop/`，不应提交到 Git。

常用 Runtime 命令：

```bash
npx owner loop new <change> --isolation current --json
npx owner loop status [change] --details --json
npx owner loop show <change> --json
npx owner loop next <change> [required inputs] --json
npx owner loop doctor [change] --json
npx owner loop archive <change> --preview --json
```

Loop 使用：

- 严格 portable state schema；
- `state_version` compare-and-swap；
- 原子文件写入；
- `iteration` 与 Verifier `attempt` 分离；
- candidate-bound Runtime checks 与 receipt；
- 对每个 acceptance item 的一次性 verdict；
- 带 state/candidate identity 的 continuation；
- 有预算的 Build/Verify 修复循环；
- 跨设备恢复后的重新验证。

## Pipeline 工作流

Pipeline 项目默认使用：

```text
docs/openspec/changes/<change>/.owner.yaml
docs/superpowers/
```

永久入口是 `owner-pipeline`，阶段 Skills 包括：

| 阶段 | Skill | 职责 |
|---|---|---|
| Open | `owner-open` | 探索需求、OpenSpec proposal/spec/tasks |
| Design | `owner-design` | Superpowers brainstorming 与 Design Doc |
| Build | `owner-build` | 计划、TDD、实现、review、checkpoint |
| Verify | `owner-verify` | light/full 验证与失败预算 |
| Archive | `owner-archive` | delta 合并、报告、提交与外部动作恢复 |

快捷入口：

- `owner-hotfix`：修复已有行为，先复现 RED 和根因分析；
- `owner-tweak`：单 change 的局部规格修改；
- `owner-pipeline` full：高风险或跨模块能力。

Pipeline 常用 Runtime 命令：

```bash
npx owner state init <change> full --isolation current
npx owner state get <change> phase
npx owner state next <change>
npx owner guard <change> <phase> --apply
npx owner handoff <change> design --write
npx owner archive <change> --dry-run
npx owner pipeline openspec -- status --change <change> --json
```

## 恢复与诊断

```bash
npx owner status /path/to/project --json
npx owner resume-probe /path/to/project --utterance "继续昨天的任务" --json
npx owner doctor /path/to/project --json
npx owner doctor /path/to/project --repair --yes
```

恢复只承诺已经保存并同步的状态与代码。未提交、未 push、未同步的旧设备代码不能通过状态文件凭空恢复。

## 更新与卸载

```bash
npx owner update /path/to/project --platform codex --scope project
npx owner uninstall /path/to/project --scope project --force
```

更新和卸载只处理 Owner 管理的文件，保留用户已有 Skills、Rules 和非 Owner Hooks。

## 开发与验证

```bash
corepack enable
pnpm install
pnpm build
pnpm lint
pnpm test
pnpm test:package-e2e
```

发布前至少验证：

```bash
node bin/owner.js --version
node bin/owner.js init --help
pnpm check:generated
npm pack --dry-run
```

## 发布到 npm

1. 将仓库推送到 GitHub。
2. 使用拥有 `redv` 作用域的 npm 账号执行 `npm login`。
3. npm 发布需要双因素认证。交互式发布时执行 `npm publish --access public --otp=<六位验证码>`；npm 也可能在命令执行后提示输入验证码。
4. CI 或其他非交互发布场景需要创建 Granular Access Token，授予 `redv` 作用域的包读写权限，并启用该 Token 的 2FA bypass。Token 只能放在密码管理器或 CI Secret 中，不要提交到 Git 或写入受跟踪的 `.npmrc`。
5. 使用 `npm publish --access public` 发布公开包。
6. 在干净项目运行 `npm install @redv/owner`。
7. 分别验证 `--platform claude` 与 `--platform codex`。
8. 分别验证 `--workflow loop`、`pipeline` 和 `both`。
9. 保留 LICENSE 与 NOTICE，不要删除授权文件。

本机临时使用 Token 发布时，可以这样配置，发布后立即删除本机配置：

```bash
export NPM_TOKEN="<granular-token>"
npm config set //registry.npmjs.org/:_authToken "$NPM_TOKEN"
npm publish --access public
npm config delete //registry.npmjs.org/:_authToken
unset NPM_TOKEN
```

## 安全边界

- Skills 与 Hooks 会在编码 Agent 权限范围内运行，安装前应 review 源码。
- 独立 Verifier 不能保证业务绝对正确；高风险系统仍需要可信 CI、人工评审和生产监控。
- Owner 只能验证已经明确写入 acceptance/spec 的行为。
- Verify 通过不自动表示用户授权 push、PR 或 merge。
- Pipeline 会安装第三方 OpenSpec 与 Superpowers，它们有各自的许可证和更新周期。

## 许可证与来源

Owner 使用 MIT License。

- 品牌、CLI、状态目录、Skill 和 schema 统一改为 Owner；
- 公开平台限制为 Claude Code 与 Codex；
- 包名与 GitHub 分发说明改为独立项目；
- 保留 Loop 与 Pipeline 双工作流、Runtime、测试和生成物体系。

详细归属信息见 [NOTICE](./NOTICE)。
