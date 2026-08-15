# Pipeline 0.3.9 参考实现

本目录冻结 Owner Pipeline shell 状态机在 commit `053f76d`（tag `0.3.9`）时的实现，
用于 bash→mjs 迁移期间的差分兼容测试。

相比 0.3.8 基线的主要变化：

- `review_mode` 字段支持（off/standard/thorough）
- 阶段跳转强制检查（phase-skip enforcement）
- hotfix/tweak 无需 `design.md` 即可离开 `open`
- hook-guard 消息改为英文
- hook-guard 跨 change 误报修复

规则：

- `scripts/` 中的文件必须保持 byte-for-byte 不变（除非合同有意变更，见下文）。
- 不对冻结脚本执行格式化、重构或跨平台修复。
- `checksums.json` 是 fixture 完整性的本地基准，不依赖测试环境存在 Git。
- 新实现允许增加 Run 字段、Skill snapshot 和 Trajectory，但旧行为投影、
  稳定输出和退出码必须继续匹配本参考实现。

合同变更记录：

- `owner-state.sh` `project_review_mode_default()`: 默认值从 `"null"` 改为 `"standard"`，
  与 `pipeline-state-command.ts` 中 `reviewModeDefault()` 的运行时兜底保持一致。
  此变更属于有意的合同变更，目的是让 `full` 工作流默认启用 standard 级别审查。
