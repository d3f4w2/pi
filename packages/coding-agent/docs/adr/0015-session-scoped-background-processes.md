# ADR-0015: 使用会话级结构化后台进程管理

## Status

Accepted

## Context

开发服务器、文件监听器和测试观察模式不会主动退出。通过普通终端工具启动它们会占住一次工具调用，重复启动还可能造成端口冲突。代理需要读取新增日志、重启和停止服务，但不能操作用户原本启动的其他进程。

## Decision

注册一个 `process` 工具，通过 `operation` 支持：

```text
start -> status -> logs -> restart -> stop
```

关键约束：

1. `start` 接收可执行文件和参数数组，直接创建进程，不拼接 Shell 命令。
2. 每个进程使用 Pi 生成的逻辑 ID；`stop` 和 `restart` 只能操作当前扩展实例创建的进程。
3. 工作目录必须位于当前项目内。
4. 每个进程使用有界环形日志，并以游标返回增量内容。
5. 同一会话最多运行八个托管进程。
6. Pi 会话关闭时停止全部托管进程；Pi 重启后不接管旧进程。
7. `/process` 与代理工具共用同一个管理器。

## Consequences

### Positive

- 长期运行的服务不会阻塞代理回合。
- 增量日志减少重复内容和 Token 消耗。
- 逻辑 ID 和项目边界避免误杀用户进程。
- 参数数组消除 Shell 注入和 Windows 转义差异。

### Negative

- Pi 关闭时服务也会停止。
- 第一版不支持系统服务、容器编排或跨 Pi 会话接管。

### Neutral

- 短代码计算继续使用 `eval`，断点调试继续使用 `debug`。

## Alternatives Considered

**继续使用终端后台语法**

拒绝。不同 Shell 的后台语法、PID 获取和日志重定向不一致。

**保存 PID 并在下次启动时接管**

拒绝。PID 会复用，无法安全确认进程仍属于 Pi。

**每个动作注册一个工具**

拒绝。会增加工具 Schema 和模型选择成本。

## References

- `packages/coding-agent/src/extensions/process/`
- `packages/coding-agent/src/utils/child-process.ts`
