# 稳定公开 CLI 协议

规范路径：`owner-pipeline/reference/scripts.md`

本文件是 Pipeline Skill 调用 Owner Runtime 的单一事实来源。Skill 只使用 PATH 中的公开 `owner` CLI；随包发布的 `owner/scripts/*.mjs` 属于内部安装与 Runtime 资产，不由 Skill 搜索或直接调用。

## CLI 引导

进入 workflow 时直接运行下方所需的公开 `owner` 命令。若命令返回 `command not found`、`executable not found` 或 `ENOENT`，停止并说明 Owner CLI 安装不完整；不得搜索 Skill 文件、枚举平台目录或直接调用内部 bundle。CLI 已启动但返回非零时，报告原错误，不得通过内部脚本重试。

## 公开工作流协议

日常工作流统一调用公开 CLI：

```bash
owner pipeline workspace prepare <change-name> --isolation <current|branch|worktree> --json
owner pipeline workspace resolve <change-name> --json
owner state select <change-name>
owner state current
owner state clear-selection
owner state check <change-name> <phase>
owner guard <change-name> <phase> --apply
owner handoff <change-name>
owner archive <change-name>
owner resume-probe . --stdin --json
owner pipeline intent route --stdin
```

在 Open 阶段先运行 workspace prepare；恢复时运行 workspace resolve，它会扫描已登记 Worktree 并返回应进入的 `projectRoot`。进入明确的 change 后再运行 `owner state select <change-name>`。普通源码写入只受该选择管辖；尚未选择时 hook 会阻塞并要求选择。切换 branch/worktree 或选择失效后必须重新运行 resolve 和 select。

guard 的 `--apply` 在检查通过后推进状态。需要直接表达状态事件时使用 `owner state transition`；阶段推进后使用 `owner state next` 解析是否自动调用下一 Skill。

## 自动状态更新

guard 支持 `--apply` 参数，验证通过后自动更新 `.owner.yaml` 状态字段：

```bash
owner guard <change-name> <phase> --apply
```

`--apply` 内部委托给状态机 transition。需要直接表达状态事件时使用：

```bash
owner state transition <change-name> open-complete
owner state transition <change-name> design-complete
owner state transition <change-name> build-complete
owner state transition <change-name> verify-pass
owner state transition <change-name> verify-fail
owner state transition <change-name> archive-confirm
owner state transition <change-name> archive-reopen
owner state transition <change-name> archived
owner state transition <change-name> preset-escalate
```

归档完成由 `owner archive <change-name>` 负责；OpenSpec 会先把 change 移到带日期前缀的归档目录，再由 Owner 完成状态记录。预归档确认使用 `archive-confirm` 或 `archive-reopen`；不要在归档流程之外手动执行 `archived` transition。

## 解析下一步

阶段守卫推进 phase 后，用 `next` 子命令解析是否自动调用下一个 skill：

```bash
owner state next <change-name>
```

输出 `NEXT: auto|manual|done` + `SKILL: <skill-name>`（`done` 时省略）+ `HINT`（仅 `manual` 时）。`auto_transition: false` 时输出 `manual`，只暂停下一 skill 调用，不影响已发生的 phase 推进。

## 归档脚本

一键完成归档全部步骤：

```bash
owner archive <change-name>
```
