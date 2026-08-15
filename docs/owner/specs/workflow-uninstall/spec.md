# 工作流级卸载

## Purpose

`owner uninstall` MUST 允许用户按工作流移除 Owner，并在移除 Pipeline 时可选择清理关联的外部 Skill，而不影响未选择的工作流或组件。

## Requirements

### Requirement: 交互式工作流选择

当交互式卸载在一个目标中发现 Loop、Pipeline 或两者时，系统 MUST 让用户从已发现的工作流中选择要移除的项。选择两者的结果 MUST 等同于当前完整 Owner 卸载；选择单一工作流时，系统 MUST 仅清理其专属文件并保留剩余工作流需要的共享组件。

#### Scenario: 保留 Loop 时移除 Pipeline

- **WHEN** 项目同时安装 Loop 和 Pipeline，且用户只选择 Pipeline
- **THEN** 系统移除 Pipeline 专属 Owner Skill 和安全可删除的 Pipeline 工作目录
- **AND** 保留 Loop Skill、共享 `/owner` 入口、Rule 与 Hook Router
- **AND** 将项目配置更新为只启用 Loop，并在 Pipeline 原为默认工作流时将默认项改为 Loop

#### Scenario: 保留 Pipeline 时移除 Loop

- **WHEN** 项目同时安装 Loop 和 Pipeline，且用户只选择 Loop
- **THEN** 系统移除 Loop 专属 Owner Skill 和安全可删除的 Loop 工作目录
- **AND** 保留 Pipeline Skill、Pipeline 工作目录以及 Pipeline 项目配置

### Requirement: Pipeline 外部 Skill 选择

在用户交互式选择 Pipeline 后，系统 MUST 额外提供 OpenSpec 和 Superpowers Skill 的独立可选项，默认均不选。系统 MUST 明确将全局 scope 的影响告知用户。

#### Scenario: 用户选择外部 Skill 清理

- **WHEN** 用户选择 Pipeline 并勾选 OpenSpec 或 Superpowers
- **THEN** 系统仅在同一已选平台和 scope 中移除对应 Skill
- **AND** 系统不得卸载 OpenSpec CLI、npm 包或未选择的外部工具

#### Scenario: 用户不选择外部 Skill 清理

- **WHEN** 用户选择 Pipeline 但不勾选 OpenSpec 或 Superpowers
- **THEN** 系统保留这些外部 Skill

### Requirement: 非交互兼容与安全清理

`--force`、`--json`、`--all-projects` 和既有 scope 选项 MUST 保持自动化兼容性：它们可以完整移除 Owner，但 MUST NOT 在没有显式新选项的情况下删除 OpenSpec 或 Superpowers Skill。所有工作目录清理 MUST 保留既有的受管树、身份校验和失败恢复保护。

#### Scenario: 非交互全量卸载

- **WHEN** 用户使用 `--force` 或 `--json` 执行卸载
- **THEN** 系统执行现有的全量 Owner 卸载语义
- **AND** 不删除 OpenSpec 或 Superpowers Skill

#### Scenario: 不安全目录

- **WHEN** 待清理的受管工作目录含有非受管内容或未通过身份校验
- **THEN** 系统拒绝该危险清理并报告卸载不完整
