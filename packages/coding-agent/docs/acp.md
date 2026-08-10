# ACP editor mode

ACP（Agent Client Protocol）让支持该协议的编辑器复用 pi-go 的同一套会话、模型、工具和审批规则。它不是第二个 Agent。

启动：

```powershell
pi-go --mode acp
```

输入和输出使用标准输入/标准输出上的 NDJSON。协议输出直接写入 stdout，普通日志不会混入协议流。

当前支持：

- 初始化和能力协商
- 新建、恢复、加载和列出会话
- 文本、图片、资源链接和内嵌资源输入
- 助手文本、思考、工具调用、工具结果和用量更新
- 取消当前请求
- 把编辑器传入的 stdio、HTTP、SSE MCP 服务绑定到当前会话
- 把 pi-go 的五种一次性或持久化审批选项映射为 ACP 权限请求

文件和终端工具默认仍在 pi-go 本地执行，因此 TUI、RPC 和 ACP 使用相同的路径边界、沙箱和审批状态。客户端没有提供可选能力时会明确降级，不会伪造成功。

如果编辑器在初始化时明确声明 `fs.readTextFile`、`fs.writeTextFile` 或 `terminal`，ACP 模式会把对应的 `read`、`write`、`edit`、`bash` 操作交给编辑器执行：

- `read` 只需要读取能力。
- `write` 只需要写入能力。
- `edit` 同时需要读取和写入能力，否则继续本地执行。
- `bash` 只在编辑器声明终端能力时使用编辑器终端。

路由发生在审批之后。编辑器已接管的操作失败时不会在本机静默重试，避免同一个写入或命令执行两次。重新加载会话不会丢失已协商的能力路由。

设计决策见 [ADR 0045](adr/0045-acp-client-capability-routing.md)。
