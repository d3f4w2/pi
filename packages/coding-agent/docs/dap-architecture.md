# DAP 调试器架构

## 目标

通过统一工具提供启动或附加、线程控制、高级断点、调用栈、变量和生命周期管理，同时保持语言适配器可替换。

## 分层

```text
debug 工具
  ↓
DebugSessionService
  ↓
DapClient（Content-Length 协议、请求/响应、事件）
  ↓
语言适配器
  ├─ Python: python -m debugpy.adapter
  ├─ JavaScript/TypeScript: js-debug-adapter
  └─ Go: dlv dap
```

一个项目同时只保留一个调试会话，避免端口和进程泄漏。`start` 与 `attach` 完成 initialize、能力协商、launch/attach、断点和 configurationDone；其他操作只发送必要的 DAP 请求。

进程附加遵循各适配器的真实协议：

- Python PID：先执行 `debugpy --listen 127.0.0.1:<port> --pid <pid>` 注入目标，再由适配器连接该本地端口。
- Python 远程：连接用户指定的 host/port。
- JavaScript/TypeScript：使用 js-debug 的 processId 或 address/port。
- Go：使用 Delve 的 local/processId attach。

## 工具操作

- 会话：`start`、`attach`、`status`、`restart`、`disconnect`、`stop`
- 执行：`threads`、`pause`、`continue`、`next`、`step_in`、`step_out`
- 查看：`stack`、`scopes`、`variables`、`evaluate`、`loaded_sources`、`modules`
- 断点：`set_breakpoints`、`set_function_breakpoints`、`set_exception_breakpoints`、`data_breakpoint_info`、`set_data_breakpoints`

共 23 项操作。高级操作先检查 initialize 返回的能力，不支持时直接说明，避免发送适配器无法处理的请求。`disconnect` 只断开调试器，`stop` 才请求结束目标进程。

输出限制为最相关的 50 项，完整对象留在调试器内部引用中。工具不自动启动；没有适配器时快速返回安装提示。

## 安全与性能

- `start`、`attach`、继续、修改断点和求值属于 `exec` 审批等级。
- 不通过 shell 拼接参数。
- Python PID 注入只监听 `127.0.0.1`，不把调试端口暴露到局域网。
- 请求有超时，进程退出时拒绝全部未完成请求。
- 默认关闭调试目标继承的凭据环境变量。
- 未调用 `debug` 时没有进程、端口或模型 token 成本。
