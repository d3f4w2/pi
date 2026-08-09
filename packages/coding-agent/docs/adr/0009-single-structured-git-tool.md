# ADR-0009: 使用单一结构化 Git 工具

## Status

Accepted

## Context

代理目前可以通过终端运行 Git，但存在三个问题：

- 原始 `git status` 和 `git diff` 输出可能很长，浪费上下文。
- Windows 上通过不同 Shell 执行 Git 容易出现转义和环境差异。
- 多会话共用工作区时，宽泛的 `git add .` 或普通 `git commit` 可能包含其他会话的修改。

用户需要一个简单入口，同时需要 `/git` 给人使用。

## Decision

注册一个名为 `git` 的工具，通过 `operation` 支持：

```text
overview -> diff -> stage/unstage -> commit -> push
               \-> log
```

关键约束：

1. 直接启动 `git` 进程并传递参数数组，不经过 Bash、WSL、PowerShell，也不拼接命令字符串。
2. `overview`、`diff`、`log` 为只读；`stage`、`unstage`、`commit` 为写操作；`push` 设置强制确认策略。
3. `stage` 和 `unstage` 只接受 `git status --porcelain=v2 -z` 返回的精确路径。
4. `commit` 要求调用方传入预期文件列表，并验证它与当前暂存文件集合完全一致；不一致时拒绝提交。
5. `push` 不支持 force、删除远程分支或任意附加参数。
6. `/git` 与代理工具共用服务层和 Diff 模型。
7. 输出、文件数量、Diff 大小和进程时间均有上限。

## Consequences

### Positive

- 模型只需要学习一个工具名，工具 Schema 更集中。
- Git 输出先被解析和压缩，减少 Token。
- 参数数组消除 Shell 注入和跨平台转义问题。
- 精确暂存和提交验证降低误提交其他会话修改的风险。
- 现有统一 Diff 组件可以直接复用。

### Negative

- 单一工具的参数 Schema 比一个只读工具更大。
- 第一版不支持按行暂存、交互式 rebase、分支删除和冲突解决。
- `commit` 的严格文件集合检查要求用户先整理暂存区。

### Neutral

- 工具不会自动提交或推送；只有用户请求或 `/git` 操作才会执行。
- 常规 Shell Git 仍然存在，但系统提示会优先使用结构化工具。

## Alternatives Considered

**拆成多个 Git 工具**

拒绝。每个工具都需要独立 Schema、描述、发现和权限配置，增加模型选择成本。

**继续只使用终端 Git**

拒绝。无法可靠限制参数、输出和提交文件范围。

**直接引入完整 Git 库**

拒绝。依赖和兼容成本较高；本机 Git 已提供稳定的仓库语义。

## References

- `packages/coding-agent/src/extensions/git/`
- `packages/coding-agent/src/core/tool-approval.ts`
- `packages/coding-agent/src/modes/interactive/components/diff.ts`
