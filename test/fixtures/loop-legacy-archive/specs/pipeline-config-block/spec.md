# pipeline-config-block

## 目标

`.owner/config.yaml` 按「全局 / 工作流专属」两层组织：全局字段留在顶层，Pipeline 工作流专属字段收纳在 `pipeline:` 嵌套映射下，与已有的 `loop:` 嵌套块对称。

## 配置结构

`owner.project.v1` 配置文件结构如下（`pipeline:` 块为本能力引入，与 `loop:` 块同级）：

```yaml
schema: owner.project.v1
default_workflow: loop | pipeline
workflows:
  - loop
  - pipeline
ambient_resume: true | false
loop:
  artifact_root: <relative-path>
  language: en | zh-CN
pipeline:
  language: en | zh-CN
  context_compression: off | beta
  review_mode: off | standard | thorough
  auto_transition: true | false
```

顶层字段语义不变：`schema`、`default_workflow`、`workflows`、`ambient_resume` 为全局，作用域不限于单个工作流；`loop:` 块仅作用于 Loop 工作流。

`pipeline:` 块字段（仅作用于 Pipeline 工作流）：

- `language`：Pipeline 产物语言，取值 `en | zh-CN`，默认 `zh-CN`。
- `context_compression`：新建 Pipeline change 的上下文压缩模式，取值 `off | beta`，默认 `off`。
- `review_mode`：新建 Pipeline change 的审查深度，取值 `off | standard | thorough`，默认 `standard`。
- `auto_transition`：Pipeline 阶段通过后是否自动进入下一阶段，取值 `true | false`，默认 `true`。

`pipeline:` 块整体可选；缺失时四项均回退上述默认值，行为等价于今天未配置该项目。

## 读取行为

Pipeline 工作流读取上述四项时，仅从 `pipeline:` 块读取：

- 块存在且字段存在：使用块内值。
- 块缺失或字段缺失：回退该字段的默认值。

Pipeline 不再从顶层读取这四项；顶层若残留同名旧字段，对 Pipeline 无效。Loop 工作流的读取不受影响（继续从 `loop:` 块读取，不读 `pipeline:`）。

读取仍沿用 error-tolerant 的 yaml 解析（`uniqueKeys: false`）：文件其他位置的语法错误不阻断单字段读取，相关字段的类型 / 枚举校验由各自既有的校验函数（`validateLanguage`、`contextCompression`、`reviewMode` 等）报错。

## 写入与迁移

`owner init` 与 `owner update` 写 `.owner/config.yaml` 时：

- 生成 `pipeline:` 块，块内包含全部四项字段（值取自既有配置或默认值），每项带与 `loop:` 块风格一致的双语注释。
- 当输入 config.yaml 在顶层存在 `language` / `context_compression` / `review_mode` / `auto_transition` 中的任意项（旧平铺格式）时，把这些字段的值迁入 `pipeline:` 块对应字段，并从顶层删除。
- 当旧顶层字段与 `pipeline:` 块内同名字段同时存在时，保留 `pipeline:` 块内的新格式值并删除旧顶层字段；旧顶层值不得覆盖新格式值。
- 迁移幂等：对已是新格式的输入重复执行，不产生重复字段、不丢失已填值。
- 迁移不改动顶层全局字段与 `loop:` 块的内容。

本能力不在 Pipeline 运行时提供对旧顶层平铺格式的兼容读取；旧格式只能经由 `owner init` / `owner update` 迁移到新格式。

## 类型契约

`OwnerProjectConfig`（`domains/owner-loop/loop-types.ts`）扩展可选 `pipeline` 块，字段与值域同上。`OwnerProjectConfig.pipeline` 缺失时不影响 Loop 解析。

## 非目标

- 不改变 `loop:` 块、顶层全局字段语义、字段值域。
- 不在运行时兼容旧平铺格式。
- 不调整 Pipeline change 级 `.owner.yaml`。
