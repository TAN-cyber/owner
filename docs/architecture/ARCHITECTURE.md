# Owner 0.1.0 架构

Owner 只提供两套 vibe coding 工作流：Native 与 Classic。两者共享安装、入口解析、Hook 路由和项目配置契约，但保持独立的状态机、产物目录与阶段守卫。

## 产品边界

Owner 支持 Claude Code 与 Codex，不提供其他宿主适配。公开能力包括：

- `owner init/status/workflow/resume-probe/doctor/update/uninstall`
- `owner native ...` Native 生命周期命令
- `owner state/guard/handoff/archive ...` Classic 生命周期命令
- `owner`、`owner-native`、`owner-classic` 以及 Classic 阶段 Skills

Native 是自包含工作流。Classic 使用 OpenSpec 管理需求事实，使用 Superpowers 提供设计、计划、TDD、调试和评审方法。

## 分层

```text
app/commands
    |
    +--> domains/owner-entry ------> 统一入口、workflow selection、恢复探测、Hook Router
    +--> domains/owner-native -----> Shape -> Build <-> Verify -> Archive
    +--> domains/owner-classic ----> Open -> Design -> Build -> Verify -> Archive
    +--> domains/integrations -----> OpenSpec、Superpowers
    +--> domains/skill ------------> Owner Skills、Rules、Hooks 的安装与卸载
    +--> domains/workflow-contract -> .owner/config.yaml 与安全写入契约
    +--> domains/engine -----------> 两套工作流复用的状态、循环和守卫基础结构
    |
platform/ -------------------------> 文件系统、进程、路径、宿主安装与版本适配
```

`app/` 只负责编排和用户输出；状态转换、路径边界、验证规则等领域行为放在 `domains/`；宿主与操作系统差异放在 `platform/`。

## 统一入口

项目首次激活时写入 `.owner/config.yaml`。`owner workflow resolve --activate` 只读取显式配置并返回 `native` 或 `classic`，不会根据任务大小、文件数量或模型判断自动切换。

每个平台只安装一个共享入口和一个 Hook Router。Router 读取 `.owner/current-change.json`，把一次写操作交给当前 change 所属工作流的 Guard。Native 与 Classic 不会同时处理同一次写入。

## Native

Native 生命周期为：

```text
Shape -> Build -> Verify -> Archive
           ^         |
           +-- repair+
```

主要设计：

- portable state、brief、目标 spec、acceptance 和 verification report 位于配置的 artifact root，默认是 `docs/owner/`。
- 锁、执行日志、receipt 和 transaction 位于 `.owner/runtime/native/`，属于本机运行状态。
- 状态写入使用 schema 校验、原子替换和 `state_version` compare-and-swap，避免并发 Agent 覆盖新状态。
- Build 产生候选版本；Verify 绑定候选身份并逐项判断 acceptance，不能只相信 Builder 的完成声明。
- 验证失败会回到 Build，但受迭代预算与无进展判断限制，避免无限修复消耗。
- 恢复记录当前阶段、候选、验收结果与 continuation。换设备后仍需获得代码，并对候选重新验证；状态文件不能恢复从未同步的代码。

## Classic

Classic 生命周期为：

```text
Open -> Design -> Build -> Verify -> Archive
```

职责边界：

- OpenSpec 保存 proposal、delta spec 与 tasks，定义要实现什么。
- Superpowers 提供 brainstorming、writing-plans、TDD、debugging 与 review 方法，定义如何实现和审查。
- Owner 的 `.owner.yaml`、handoff、checkpoint、Guard 和 Archive transaction 连接整个生命周期。

Classic 阶段 Skills `owner-open/design/build/verify/archive` 是工作流组成部分；`owner-hotfix` 与 `owner-tweak` 是 Classic 的预设入口，不是独立产品。

## 恢复与上下文压缩

聊天上下文不是事实源。阶段、change、workspace、计划哈希、handoff、候选与验证结果写入磁盘；`resume-probe` 根据这些状态给出可恢复目标。

例如 Build 执行到任务 4 后断网，新会话不需要依赖旧聊天猜测进度。Native 从 portable state、runtime receipt 与 candidate identity 恢复；Classic 从 `.owner.yaml`、OpenSpec tasks、Superpowers plan 和 checkpoint 恢复。如果代码只存在于断线设备且未同步，两套工作流都会明确阻塞，而不是假装能够恢复。

## 验证模型

Owner 通过可执行检查和独立 Verifier 降低“代码写完但不符合需求”的风险：

1. 需求先落为 spec 与 acceptance，而不是只保留在聊天中。
2. Build 必须产出与候选绑定的测试/检查证据。
3. Verify 逐条读取 acceptance、代码改动和执行结果，输出通过、失败或阻塞。
4. 失败项形成有界修复输入；通过后仍需用户确认才能执行 push、PR 或 merge 等外部动作。

该机制提高可审计性，但不是形式化正确性证明。遗漏的需求、错误的验收项或质量不足的 Verifier 仍会影响结果。

## 生成资产

TypeScript 是运行时事实源：

```text
domains/owner-classic/* -> assets/skills/owner/scripts/owner-*.mjs
domains/owner-native/*  -> assets/skills/owner-native/scripts/owner-native-*.mjs
domains/owner-entry/*   -> owner-entry-runtime.mjs + owner-hook-router.mjs
```

生成的 `.mjs` 文件是安装到用户项目后可独立运行的 Node.js 产物，不代表额外的产品命令。`assets/manifest.json`、`config/repository-layout.json` 与生成资产由构建和仓库契约测试保持一致。

## 安装边界

下载或安装 npm 包不会修改 Claude Code 或 Codex 配置。只有显式运行 `owner init` 才会写入用户选择的宿主和 scope。安装器只管理 manifest 声明的 Owner 文件；更新和卸载保留非 Owner 文件，并拒绝递归处理不可信的 symlink 或未知目录内容。

## 相关文档

- [上下文压缩](../operations/CONTEXT-COMPRESSION.md)
- [自动衔接](../operations/AUTO-TRANSITION.md)
