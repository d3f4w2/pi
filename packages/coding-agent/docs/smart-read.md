# 智能读取

长代码文件现在会自动返回“结构地图”，不再默认把整个实现塞进上下文。

```text
¶src/store.ts#d9F2sL0pQa
[Outline: 842 lines, 73 source lines shown. Use mode="full" or offset/limit to expand.]
1#6D8fAq|import { readFile } from "node:fs/promises";
19#f9Qw3A|export interface StoreOptions {
45#nA7k1D|export class Store {
51#cV9pQ2|  async load(id: string): Promise<Item> {
[... lines 52-88 omitted; use offset=52 limit=37 ...]
```

代理先看到整个文件的导入、类型、类、函数和方法，再用提示中的 `offset/limit` 只展开需要的实现。可见源码仍带可靠编辑锚点，因此可以继续交给 `edit`。

## 模式

- `mode="auto"`：默认。短文件返回全文；长代码文件返回结构地图。
- `mode="full"`：强制返回原文，仍受正常行数和字节限制。
- `mode="outline"`：支持的代码文件即使较短也强制返回结构地图。
- 设置 `offset` 或 `limit`：始终视为精确范围读取，不做摘要。

自动结构地图支持：

- TypeScript、JavaScript、TSX、HTML、CSS：本地 AST 解析。
- Python、Go：本地声明提取。

其他文件、`AGENTS.md`、`SKILL.md` 和 Pi 文档保持原来的全文读取方式。

## 性能原则

- 不调用模型。
- 不联网。
- 不启动 LSP 或子进程。
- 不建立后台索引。
- 单文件最多解析 1 MB。
- 结构结果按内容版本缓存，最多保留 64 份。
- 解析失败立即回退全文，不让辅助能力拖垮任务。

在本仓库的 `agent-session.ts`（3344 行）实测中：结构地图显示 120 行，输出相对正常全文读取减少约 83.8%；首次生成约 23 ms，缓存后约 2 ms。该数据只用于说明量级，不作为跨机器性能承诺。

架构见 [Smart Read Architecture](smart-read-architecture.md)，关键决策见 [ADR-0001](adr/0001-smart-read-local-structural-outlines.md)。

