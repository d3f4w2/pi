# ADR-0043: 有界只读 Eval 工具桥梁

## Status

Accepted

## Context

持久 Python/Bun 可以跨代码单元保留变量，但只能计算解释器内已有数据。允许代码单元调用任意 pi-go 工具会绕过工具选择、审批和能力边界；只按字符串拒绝几个危险名字也会留下新增工具自动暴露的问题。

桥梁还要处理代码单元超时、宿主取消、递归调用、路径穿越和大输出。网页内容进入解释器时必须继续标记为不可信数据，而不是指令。

## Decision

- 解释器只获得 `pi_tool`（Python）或 `piTool`（Bun），通过现有 JSON 行通道向宿主发送请求。
- 宿主维护不可扩展的 `read`、`grep`、`find`、`ls` 白名单和每项参数校验；工具名不能映射到动态注册表。
- 本地路径在调用现有只读工具前解析真实路径并限制到当前工作区。
- 每个代码单元共享调用数、参数字节、输出字节、总超时、递归锁和 AbortSignal。
- 外部网页结果保留现有读取防护，并增加 Eval 专用不可信内容标记。
- 会话关闭、reset、超时或取消会终止解释器并拒绝所有未完成桥梁请求。

## Consequences

### Positive

- Eval 可以在变量保留的循环中读取和筛选项目数据，无需开放写入或 shell。
- 新增普通工具不会自动进入 Eval，能力集合可以审计和计数。
- 复用现有只读工具的截断、忽略规则和网页读取安全实现。

### Negative

- Python 的 `pi_tool` 是同步调用；Bun 的 `piTool` 必须 `await`。
- 超时或 AbortSignal 会重置持久解释器，未保存的解释器状态丢失。
- read 的完整输出还会被桥梁再次截断。

### Neutral

- Eval 本身仍不是安全沙箱；桥梁只收窄新增的工具能力，不改变解释器已有的本地代码执行审批。

## Alternatives Considered

**把所有活动工具注入解释器**

拒绝。活动工具会随配置变化，无法形成稳定最小权限边界。

**允许任意工具名并维护拒绝列表**

拒绝。新增写工具会默认暴露，拒绝列表无法证明完整。

**让解释器启动第二个 pi-go CLI**

拒绝。会引入递归代理、模型调用、额外权限和不可控资源消耗。

## References

- `packages/coding-agent/docs/adr/0010-persistent-eval-processes.md`
- `packages/coding-agent/src/extensions/eval/`
