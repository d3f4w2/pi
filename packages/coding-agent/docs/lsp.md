# LSP 代码理解工具

`lsp` 使用编程语言自己的分析器确认代码关系。它适合查定义、引用、类型、错误和安全重命名；准确文字搜索仍使用 `grep`，未知功能探索使用 `code_search`。

如果只知道 `loadUser` 这样的符号名，不知道它在哪个文件，代理必须先用内置 `grep` 找到具体文件和行号，再调用 `lsp`。不能把 `.`、项目根目录或文件夹当作 `path`；唯一例外是 `diagnostics path="*"`，表示检查整个项目。

## 支持语言

- TypeScript / JavaScript：npm、源码和普通 Bun 安装可以直接使用；独立 Bun 二进制需要全局安装 `typescript-language-server` 和 `typescript`。
- Python：推荐在项目环境执行 `pip install basedpyright`。
- Go：执行 `go install golang.org/x/tools/gopls@latest`。

语言服务器只在每个语言工作区第一次调用时启动，通常需要几秒。Python 和 Go 会在启动前显示对应安装命令，后续调用复用进程，不重复提醒。缺少服务器或启动失败时，工具会给出简短提示，代理应立即改用 `grep` 和 `read`。

## 项目级诊断

`lsp diagnostics path="*"` 不会逐个打开项目文件，而是根据当前目录的配置运行一个标准项目检查：

| 项目 | 识别标记 | 检查方式 |
|---|---|---|
| TypeScript / JavaScript | `tsconfig.json`、`jsconfig.json` | 项目本地或 Pi 自带的 `tsc --noEmit` |
| Python | `pyproject.toml`、`requirements.txt`、`setup.cfg`、`setup.py` | `basedpyright`，找不到时尝试 `pyright` |
| Go | `go.mod`、`go.work` | `go build ./...`；工作区按 `go.work` 中的模块检查 |

检查命令直接启动，不经过 Bash、PowerShell、WSL 或 `npx`，因此不会因为 shell 配置失败，也不会自动联网安装软件。默认最多运行 20 秒、返回 50 行；可用 `max_results` 调低或提高到 100 行。项目测试仍使用 `bash` 运行项目自己定义的测试命令。

## 修改后的自动检查

启用 `lsp` 后，代理通过 `edit`、`write` 或 `lsp rename` 修改代码时，会在当前一批工具调用结束后自动检查相关文件。它不会扫描整个项目，也不会在每次小编辑后重复检查。

- 文件修改完成后会在后台预热对应语言服务器；预热不向模型发送内容。
- 第一次冷启动还没完成时，检查延后一回合，让启动与模型工作同时进行，不额外卡住当前回合。
- 一批修改最多检查 8 个受支持的代码文件。
- 总等待时间约 2.5 秒；超时或服务器不可用时直接跳过。
- 本轮刚启动语言服务器且首次没有收到诊断时，会在同一时间预算内确认一次，避免把尚未发布的错误误判为正常。
- 最多向模型返回 20 条问题；没有问题时不向模型发送内容，因此几乎不增加 Token。
- 同一次代理运行最多反馈两轮，防止“修改—检查”无限循环。
- 自动检查只是快速反馈，最终仍以项目自己的类型检查和测试为准。

## 常见操作

```text
grep pattern=loadUser path=.
lsp definition path=src/index.ts symbol=loadUser
lsp type_definition path=src/index.ts symbol=User
lsp references path=src/index.ts line=20 column=15
lsp hover path=src/index.ts symbol=loadUser
lsp symbols path=src/index.ts
lsp workspace_symbols path=src/index.ts query=Provider
lsp diagnostics path=src/index.ts
lsp diagnostics path="*"
lsp rename path=src/index.ts symbol=loadUser new_name=loadCurrentUser
lsp rename_file path=src/old-name.ts new_path=src/new-name.ts
lsp code_actions path=src/index.ts line=20
lsp code_actions path=src/index.ts line=20 query="Add missing import" apply=true
lsp status
lsp reload path=src/index.ts
lsp capabilities path=src/index.ts
```

行号和列号从 1 开始。可以用 `symbol` 代替列号；如果文件中同名内容出现多次，工具会返回候选行，要求调用方指定位置。

`code_actions` 默认只预览候选。`rename`、`rename_file` 和 `code_actions apply=true` 会修改当前项目中的文件，并进入工具确认流程。`rename_file` 会先让语言服务器计算引用更新，再移动文件；写入失败时回滚。执行后应查看 Git diff，并运行相关检查或测试。

`status` 不启动服务器。`reload` 用于服务器异常或配置变化，不应在普通查询前调用。`request` 是受执行确认保护的高级接口，用于尚未提供具名操作的标准或服务器扩展方法；生命周期方法和 `workspace/applyEdit` 不能直接调用。

架构和关键决策见 [lsp-architecture.md](lsp-architecture.md)。
