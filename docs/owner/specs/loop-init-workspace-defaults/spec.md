# loop-init-workspace-defaults

## 目标

Owner Loop 在项目没有既有 Loop 配置且用户未显式指定 root 时，统一使用 `docs` 作为 artifact root。初始化创建的用户文档工作区、写入的项目配置、JSON 结果、完成摘要和所有后续消费者必须指向同一、经过共享边界验证的真实位置；机器 Runtime 独立存放在项目根 `.owner/runtime/loop`。

## Loop 默认 artifact root

- `owner init` 选择 Loop 或 Both，且项目没有既有 `.owner/config.yaml`、用户没有提供 `--root` 时，`loop.artifact_root` 为 `docs`。
- `owner loop init` 在没有既有配置且未提供 `--root` 时，同样使用 `docs`。
- 共享默认配置构造器在未传 artifact root 时生成 `loop.artifact_root: docs`。
- 用户显式提供 `--root <relative-path>` 时使用该路径，包括显式 `--root .`。
- 项目已有合法 `loop.artifact_root` 时，重复初始化保留该值；Pipeline layout 的变化不得触发 Loop root move。

默认 Loop 用户文档目录布局为：

```text
docs/owner/
├── specs/
├── changes/
└── archive/
```

默认 Loop 机器 Runtime 布局为：

```text
.owner/runtime/loop/
├── changes/<change-name>/
│   ├── state.json
│   └── logs/
├── locks/
└── transactions/
```

初始化不得在 `docs/owner/` 创建 `runtime/`。未显式选择 `--root .` 时，也不得在项目根创建等价的 `owner/` 用户文档目录树。

## Root 共享边界

所有读取 `loop.artifact_root` 的消费者，包括 Loop runtime、Entry、安装与生成逻辑，都必须复用 workflow-contract 的配置解析和项目内相对路径规范化：

- 不以正则从 YAML 文本提取 root。
- 不把未验证值直接传给 `path.join`、目录枚举或文件读写。
- 绝对路径、`..` 越界、空值、非法类型或无效配置返回明确错误/不可用状态，不回退到 `docs` 或 `.` 猜测继续。
- Factory 生成 workflow package 时只读取已验证的 Loop用户文档 root，并保证所有打包路径仍位于项目根。

Loop Runtime 根固定从已验证 project root 解析为 `.owner/runtime/loop`，不受 `loop.artifact_root` 变化影响。共享边界不得降低 Loop protected I/O、workspace identity、portable state version 或 root move 语义。

初始化器 MUST 默认忽略 `.owner/*`，并且只为 `!.owner/config.yaml` 写入精确 allowlist。该例外 MUST NOT 暴露 `.owner/current-change.json`、Runtime、日志、锁、事务、skills、drafts 或 cache。已有等价规则 MUST 保持幂等，不得用会重新包含其他 `.owner` 子树的宽泛模式替换。

## 初始化完成摘要

项目范围 `owner init` 的完成摘要按实际启用 workflow 与解析后的 layout 输出：

- Loop-only：输出解析后的 `<loop.artifact_root>/owner/` 用户文档根；可以另行说明 Runtime 使用本地 `.owner/runtime/loop/`，但不得把它描述为需要提交的产物。
- Pipeline-only：legacy 布局输出 `openspec/` 与 `docs/superpowers/{specs,plans,reports}/`；docs 布局输出 `docs/openspec/` 与 `docs/superpowers/{specs,plans,reports}/`，不输出 Loop 工作目录。
- Both：同时输出 Loop 用户文档目录与解析后的 Pipeline 工作目录。

Loop 路径来自共享配置契约验证后的 `InitWorkflowDecision.artifactRoot`，Pipeline 路径来自 Pipeline layout resolver；中英文文案遵循相同条件与真实路径。

## 跨设备默认恢复

`.owner/config.yaml`、`.owner/current-change.json` 与 `.owner/runtime/loop` 可以不随 Git 同步。对于 Loop 默认布局，各设备重新执行 Loop 初始化后都得到 `loop.artifact_root: docs`，因此 `resume-probe` 扫描 `docs/owner/changes` 并能发现已同步的 active change。

缺少本机 Runtime 时，恢复 MUST 从已同步的 `owner-state.yaml` 与正式 Markdown 重建 `state.json`，并从最近稳定边界继续。Shape/Build 不重跑已完成阶段；丢失的 Verify execution 或 Archive-ready pass 必须重新执行必要检查并分派新的 Verifier。恢复不能续接原设备的进程、日志、subagent execution 或未同步实现。

Pipeline docs layout 不改变 Loop discovery。缺失 selection 时，单一 active change 仍按工作流归属与无歧义恢复规则处理；多个 Loop / Pipeline 候选由共享 Entry 协议失败关闭。

本能力不为自定义 Loop artifact root 引入自动猜测或跨目录扫描。

## Pipeline 配置默认值

Pipeline 项目配置保持既有字段值域与默认值：

- `review_mode` 为 `off | standard | thorough`，缺失时默认 `standard`。
- `artifact_layout` 为 `legacy | docs`；Runtime 缺失时默认 `legacy`，全新 Pipeline / Both init 默认 `docs`。

Loop 默认 root 和本地 Runtime 不覆盖、迁移或推断 Pipeline layout。

## 非目标

- 不自动移动已有 Loop artifact root。
- 不删除非空旧 Loop 目录或旧 per-change Runtime。
- 不改变 Loop clarification 模式或 Pipeline workflow。
- 不扫描配置 root 之外的候选 Loop changes。
- 不因 Pipeline layout 与 Loop 默认同处 `docs/` 而合并两个 workflow。
- 不把 `.owner/runtime/loop` 变成可提交的跨设备状态后端。
