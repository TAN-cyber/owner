# 文件结构参考

规范路径：`owner-pipeline/reference/file-structure.md`

本文件是 Owner 项目文件结构参考。按需查阅，不随 skill 一次性加载。

```text
<pipeline-open-spec-root>/              # OpenSpec — WHAT；由 Pipeline layout resolver 返回
├── config.yaml
├── changes/
│   ├── <name>/                        # 活跃 change
│   │   ├── .openspec.yaml
│   │   ├── .owner.yaml
│   │   ├── proposal.md                # Why + What
│   │   ├── design.md                  # 高层架构决策
│   │   ├── specs/<capability>/spec.md # Delta 能力规格
│   │   ├── .owner/handoff/            # 脚本生成的阶段交接包
│   │   └── tasks.md                   # 任务清单
│   └── archive/YYYY-MM-DD-<name>/     # 已归档
└── specs/<capability>/spec.md         # 主 specs（归档时按 OpenSpec delta 语义合并）

<pipeline-superpowers-root>/            # Superpowers — HOW；由 Pipeline layout resolver 返回
├── specs/YYYY-MM-DD-<topic>-design.md # 设计文档（技术 RFC，归档时标注状态）
└── plans/YYYY-MM-DD-<feature>.md      # 实施计划（文件头含 change 关联元数据）

.owner/
└── config.yaml                        # Owner 项目配置（context_compression 默认 off，可设 beta）
```
