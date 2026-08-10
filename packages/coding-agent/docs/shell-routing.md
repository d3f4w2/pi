# Windows 终端路由

Windows 上，文件搜索和目录操作直接使用 Node/Windows 文件 API，不依赖 Git Bash、WSL、`rg` 或 `fd`。终端工具保留 Bash 和 PowerShell 两个明确执行器。

## 选择规则

- 文件读取、修改、搜索和目录查看：使用 `read`、`edit`、`write`、`grep`、`find`、`ls`，不调用 Shell。
- Git、npm、Node、Python、构建、测试和 Windows 操作：设置 `executor="powershell"`，直接启动系统 PowerShell。
- 只有脚本确实使用 Bash 语法时才保留默认 Bash 执行器。

终端工具的参数结构：

```json
{
  "command": "Get-ChildItem Env:",
  "executor": "powershell"
}
```

Pi 会直接启动：

```text
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command -
```

原始命令通过标准输入交给 PowerShell，不经过 Git Bash，也没有 Bash → PowerShell 的嵌套引用。

`executor` 不填写时默认为 `bash`。

## 可选的 Git Bash 配置

只有明确选择 `executor="bash"` 时，Pi 才依次检查 Git for Windows 的标准安装位置、PATH 中 `git.exe` 旁边的 Git Bash，以及 PATH 中其他真实 Bash。

也可以在 `~/.pi/agent/settings.json` 中明确设置：

```json
{
  "shellPath": "C:\\Program Files\\Git\\bin\\bash.exe"
}
```

Pi 不会再选择 `C:\Windows\System32\bash.exe` 或 `Sysnative\bash.exe`。它们是 WSL 中继程序，不是独立 Bash；WSL 未正确安装时会产生 `/bin/bash` 不存在的错误。

实现结构和关键决策见 [Windows 终端路由架构](shell-routing-architecture.md)。
