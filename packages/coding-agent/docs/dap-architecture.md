# DAP 调试器架构

## 目标

通过统一工具提供断点、继续、单步、调用栈、作用域、变量和表达式求值，同时保持语言适配器可替换。

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

一个项目同时只保留一个调试会话，避免端口和进程泄漏。`start` 完成 initialize、launch、断点和 configurationDone；其他操作只发送必要的 DAP 请求。

## 工具操作

- `start`、`set_breakpoints`
- `continue`、`next`、`step_in`、`step_out`
- `stack`、`scopes`、`variables`、`evaluate`
- `stop`、`status`

输出限制为最相关的 50 项，完整对象留在调试器内部引用中。工具不自动启动；没有适配器时快速返回安装提示。

## 安全与性能

- `start`、继续和求值属于 `exec` 审批等级。
- 不通过 shell 拼接参数。
- 请求有超时，进程退出时拒绝全部未完成请求。
- 默认关闭调试目标继承的凭据环境变量。
- 未调用 `debug` 时没有进程、端口或模型 token 成本。
