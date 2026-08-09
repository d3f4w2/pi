# ADR-0006: 统一 Diff 预览与结构化编辑

## Status

Accepted

## Context

Pi 已有 `edit` 的行级 Diff 预览和 `ast_grep` 的结构搜索，但存在两个断点：

- `write` 只展示新内容，覆盖已有文件时看不到删除了什么。
- `ast_grep` 能找到代码结构，却不能安全地批量修改这些结构。

如果分别给三个工具增加独立界面，Diff 计算、截断、统计和配色会逐渐不一致。结构化批量修改还必须避免“部分文件已经写入，后续文件才失败”的半完成状态。

## Decision

采用“准备变更，再统一展示和提交”的架构：

1. Diff 层只接收文件路径、旧内容和新内容，生成统一的 `FileDiff` 数据。
2. `edit`、`write`、`ast_edit` 共用同一个终端渲染器。
3. `ast_edit` 先扫描并在内存中生成全部文件的新内容；全部验证通过后，才原子替换文件。
4. `ast_edit` 使用现有工具审批策略，分类为写操作。TUI 在审批前已经显示 Diff；RPC、JSON 和 print 模式返回结构化结果，不等待终端交互。
5. 默认显示紧凑 Diff；展开工具输出时显示完整 Diff。标题展示文件状态和 `+新增/-删除` 统计。
6. 单次结构化修改限制文件数、文件大小、匹配数、输出大小和执行时间。

数据流：

```text
工具参数
   |
   v
准备变更（不写磁盘）
   |
   +--> FileDiff[] --> TUI 预览/审批
   |
   v
再次校验文件版本
   |
   v
全部原子替换 --> LSP 自动诊断 --> verify 按需验证
```

## Consequences

### Positive

- 普通编辑、覆盖写入和结构化编辑的视觉语言一致。
- 用户在写入前能看到真实结果，而不是只看到工具参数。
- 结构化批量编辑不会留下半完成状态。
- Diff 数据可复用于 HTML、RPC 和未来的 checkpoint/rewind。

### Negative

- `write` 预览需要额外读取一次目标文件。
- 大型批量修改需要缓存候选内容，因此设置严格上限。
- 结构替换模板只支持 ast-grep 捕获变量，不承担任意脚本执行。

### Neutral

- `edit` 的文件写入行为不变，只升级展示。
- yolo 模式仍可跳过人工确认，这是用户明确选择的安全模式。

## Alternatives Considered

**每个工具各自渲染 Diff**

拒绝。实现快，但统计、截断和配色会产生三套行为。

**直接调用 ast-grep CLI 的 rewrite**

拒绝。需要额外进程和平台安装，错误处理、路径边界与原子提交也更难统一。

**每修改一个文件立即写入**

拒绝。后续文件失败时会留下部分成功的仓库状态。

## References

- `packages/coding-agent/src/core/tools/edit-diff.ts`
- `packages/coding-agent/src/modes/interactive/components/diff.ts`
- `packages/coding-agent/src/extensions/ast-grep/`
