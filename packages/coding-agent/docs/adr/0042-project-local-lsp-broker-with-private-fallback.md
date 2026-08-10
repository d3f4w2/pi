# ADR-0042: 项目本地 LSP broker 与私有进程回退

## Status

Accepted

## Context

语言服务器冷启动和项目索引成本远高于单次 LSP 请求。多个 pi-go 会话在同一项目中各自启动服务器会重复占用时间和内存；直接跨项目复用又会混淆根目录、配置和打开文档。

共享服务不能成为任务硬依赖。broker、socket、协议或共享服务器任一失败时，已有私有 LSP 路径必须继续可用。会话关闭也不能终止仍被其他会话引用的服务器。

## Decision

- 每个“规范化项目根 + 语言服务器启动配置”使用一个小型本地 broker；Windows 使用 named pipe，Unix 使用权限为 `0600` 的本地 socket。
- 握手包含协议版本、项目根和完整启动配置。缓存键包含项目根、语言适配器、命令和参数。
- broker 复用真实服务器的初始化结果，并重写 JSON-RPC 请求 ID 与文档版本；客户端关闭只减少引用。
- 服务器无引用后进入 linger，broker 无会话和服务器后空闲退出。
- 初始化失败写入有期限的负缓存；`reload` 清理匹配服务器及失败缓存。
- 客户端优先连接共享 transport；连接、初始化或运行中断开时启动私有服务器，并最多重试当前操作一次。

## Consequences

### Positive

- 第二会话跳过语言服务器冷启动和项目初始化。
- 项目根参与 endpoint 和缓存键，不同项目不会错误共享。
- broker 崩溃只造成一次回退延迟，不阻断 LSP 操作。

### Negative

- broker 必须维护请求 ID、初始化、文档版本和服务器请求路由，复杂度高于简单 stdio 客户端。
- Node 发布形态需要可执行的 broker worker 文件；单文件运行时不具备 worker 时只能回退私有进程。
- 一次共享服务器重启会断开该服务器的所有共享客户端。

### Neutral

- broker 不监听 TCP，不提供远程发现、身份系统或持久数据库。

## Alternatives Considered

**全局单 broker 共享所有项目**

拒绝。扩大故障域并提高跨项目键错误导致状态泄漏的风险。

**文件锁加共享 stdio 句柄**

拒绝。独立进程不能可靠共享一组 stdio 流，也无法完成请求路由和引用计数。

**共享失败时直接报错**

拒绝。共享是性能优化，不能让它成为普通任务的可用性依赖。

## References

- <https://github.com/can1357/oh-my-pi/blob/main/docs/tools/lsp.md>
- `packages/coding-agent/docs/lsp-architecture.md`
