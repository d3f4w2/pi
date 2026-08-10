# Windows 终端路由架构与关键决策

本文记录 Pi 在 Windows 上选择 Git Bash 和 PowerShell 的实现方式。使用方法见 [shell-routing.md](shell-routing.md)。

## 设计目标

- 保持一个统一的终端工具和输出处理流程。
- `grep`、`find`、`ls` 在 Windows 直接走文件 API，不依赖外部搜索程序。
- 普通 Windows 命令可以直接运行在 PowerShell，不要求 Git Bash 存在。
- WSL 未安装或损坏时不能误选 WSL 的 `bash.exe` 中继。
- 超时、取消、环境变量和输出截断对两种执行器保持一致。

## 整体流程

```text
bash(command, executor?)
        ↓
executor 默认为 bash（兼容 Bash 脚本）
        ├─ bash：原样交给已配置 Bash
        └─ powershell：校验 Windows 平台
                         ↓
                    直接启动 powershell.exe
                         ↓ stdin 传入原始命令
                    复用输出、取消和超时逻辑

grep / find / ls
        └─ Node 文件 API + 分层 .gitignore + glob/正则
             （不启动 Shell，不要求 rg/fd）
```

## 文件职责

| 文件 | 职责 |
|---|---|
| `core/tools/bash.ts` | 定义执行器参数、直接 PowerShell 启动和统一执行流程。 |
| `core/tools/native-file-search.ts` | Windows 原生遍历、glob 和分层忽略规则。 |
| `utils/shell.ts` | 查找可用 Bash、过滤 WSL 中继，并生成系统 PowerShell 配置。 |
| `test/shell-routing.test.ts` | 验证命令包装、平台限制和 Bash 路径选择。 |
| `test/system-prompt.test.ts` | 验证模型只把 Windows 专属任务交给 PowerShell。 |

## 关键决策

### ADR-001：一个工具，两个执行器

决定：保留 `bash` 工具，在参数中增加可选的 `executor: "bash" | "powershell"`。

原因：新增独立 PowerShell 工具会重复超时、取消、输出截断、环境变量注入和渲染逻辑。执行器参数只改变命令入口，其余能力可以完整复用。

### ADR-002：不自动猜测命令语言

决定：由模型根据任务类型明确选择执行器，不根据命令字符串猜测 PowerShell 语法。

原因：`Get-*`、管道和变量等文本可能出现在脚本、文档或参数中。字符串猜测容易误判并改变命令语义。

### ADR-003：PowerShell 是独立执行后端

决定：模型只提供原始 PowerShell 命令。Pi 直接启动系统 PowerShell，固定使用无配置、非交互参数，并通过标准输入发送命令。

原因：让模型手写 `powershell.exe -Command` 会产生 JSON 和 PowerShell 多层引号；从 Git Bash 再启动 PowerShell还会把 Git Bash 和 WSL 变成不必要的故障点。

### ADR-004：Windows 文件搜索有内置后端

决定：Windows 的 `grep` 和 `find` 使用 Node 文件 API，支持分层 `.gitignore`、隐藏文件、glob、正则、上下文、结果上限和取消；`ls` 继续使用原生目录 API。其他平台保留成熟的 `rg`/`fd` 快速路径。

原因：搜索是高频基础能力，不能因为 `rg.cmd` 指向错误脚本、Git Bash 缺失或 WSL 损坏而不可用。内置后端保证可用性，平台快速路径保证其他系统既有性能。

### ADR-005：跳过 WSL bash.exe 中继

决定：Windows Shell 搜索过滤 `System32\bash.exe` 和 `Sysnative\bash.exe`，继续检查后面的 Git Bash、MSYS2 或 Cygwin 路径。如果 Git Bash 不在标准目录，就通过 PATH 中的 `git.exe` 反推相邻的 `bin\bash.exe` 和 `usr\bin\bash.exe`。

原因：这些文件只是 WSL 启动入口，内部仍依赖 Linux `/bin/bash`。把它们当成本机 Bash 会在 WSL 未配置时失败并输出乱码。

### ADR-006：PowerShell 仅限 Windows

决定：非 Windows 平台选择 PowerShell 执行器时立即报错。

原因：不能假设 Linux 或 macOS 安装了 `pwsh`，也不能让平台专属行为变成隐式依赖。

## 失败处理

- Git Bash 不存在：提示安装 Git for Windows 或配置 `shellPath`。
- 明确配置为 WSL 中继：拒绝启动并提示改用 Git Bash。
- 非 Windows 使用 PowerShell：在启动子进程前失败。
- PowerShell 返回非零退出码：沿用终端工具现有错误输出。
- 命令超时或取消：终止 Git Bash 及其 PowerShell 子进程树。

## 测试要求

- Bash 命令保持原样。
- PowerShell 命令保持原样，通过独立执行器和标准输入传递。
- PowerShell 可以在没有 Git Bash/WSL 的环境直接执行。
- 非 Windows 拒绝 PowerShell。
- WSL 中继排在 PATH 前面时仍选择后面的真实 Bash。
- Git 安装在非标准目录时能从 `git.exe` 找到相邻 Git Bash。
- 原生 grep/find 覆盖隐藏文件、分层忽略规则、路径 glob、正则、上下文、上限和取消。
- 模型提示明确要求普通 Windows 命令使用 PowerShell，Bash 只用于 Bash 语法。
