# `/doctor` 健康检查

当 Pi、工具或语言服务器“好像不能用”时，先输入：

```text
/doctor
```

它会生成一份中文报告，说明哪些能力正常、哪些只是不必要的可选项、哪些问题会影响当前任务，以及最短修复方法。

## 它检查什么

- 当前模型是否选中、是否有可用模型、`models.json` 是否加载失败。
- `read`、`bash`、`edit`、`write`、`grep` 核心工具是否注册。
- Windows 是否找到真正的 Git Bash，而不是损坏的旧 WSL `bash.exe` 中继。
- 当前目录是不是 TypeScript/JavaScript、Python 或 Go 项目。
- 当前项目需要的语言服务器是否在 PATH。
- mgrep 是否安装；未安装时明确说明内置 `grep` 仍可使用。
- `web_search` 是否启用，以及 Brave Key 或无 Key DuckDuckGo 回退状态。
- 全局与项目 `settings.json`、`models.json`、`auth.json` 的保存位置。

## 结果怎么看

| 结果 | 含义 |
|---|---|
| `错误` | 核心能力不可用，需要先修复，例如没有模型或配置文件无效 |
| `提醒` | 当前项目需要的能力缺失，例如 Python 项目没有 basedpyright |
| `可选` | 增强能力未安装，不影响普通任务，例如 mgrep 未安装 |
| `正常` | 已有本地证据证明该项就绪 |

常见修复：

```text
没有模型                 → /api 或 /login
Windows 没有 Git Bash    → 安装 Git for Windows，或设置 shellPath
Python LSP 缺失          → pip install basedpyright
Go LSP 缺失              → go install golang.org/x/tools/gopls@latest
mgrep 缺失               → npm install -g @mixedbread/mgrep，然后 mgrep login
```

## 隐私与速度

`/doctor` 是离线、只读检查：

- 不访问网络。
- 不调用模型或供应商 API。
- 不启动 Shell、LSP 或 mgrep。
- 不自动安装、登录或修改配置。
- 不读取 `auth.json` 内容。
- 只判断少量环境变量是否配置，不输出变量值。

它是用户命令，不是模型工具，所以不会给普通对话增加工具 Schema Token。

## 限制

本地检查只能证明路径、配置和注册状态。远端服务是否在线、账号额度是否充足，仍以真正调用时的结果为准。为了避免误报和等待，`/doctor` 不主动测试远端接口。
