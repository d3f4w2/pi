# Windows 终端路由

Windows 上，Pi 的终端工具默认使用 Git Bash。模型只需要选择执行器，不需要自己拼接多层 Shell 命令。

## 选择规则

- 文件读取、修改和搜索：使用 `read`、`edit`、`write`、`grep` 等内置工具。
- Git、npm、Node、Python、构建和测试：使用默认 Bash 执行器。
- 注册表、Windows 服务、COM、证书库和 PowerShell cmdlet：使用 PowerShell 执行器。

终端工具的参数结构：

```json
{
  "command": "Get-ChildItem Env:",
  "executor": "powershell"
}
```

Pi 会自动执行：

```text
powershell.exe -NoProfile -NonInteractive -Command <安全引用后的命令>
```

`executor` 不填写时默认为 `bash`。

## Git Bash 配置

Pi 依次检查 Git for Windows 的标准安装位置、PATH 中 `git.exe` 旁边的 Git Bash，以及 PATH 中其他真实 Bash。你的 Git 安装在非标准目录时通常不需要手动配置。

也可以在 `~/.pi/agent/settings.json` 中明确设置：

```json
{
  "shellPath": "C:\\Program Files\\Git\\bin\\bash.exe"
}
```

Pi 不会再选择 `C:\Windows\System32\bash.exe` 或 `Sysnative\bash.exe`。它们是 WSL 中继程序，不是独立 Bash；WSL 未正确安装时会产生 `/bin/bash` 不存在的错误。

实现结构和关键决策见 [Windows 终端路由架构](shell-routing-architecture.md)。
