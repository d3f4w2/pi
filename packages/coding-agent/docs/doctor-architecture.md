# `/doctor` 运行环境诊断架构

## 目标

把“工具为什么不能用”从猜测变成一份快速、只读、可执行的诊断报告。用户输入 `/doctor` 后，应直接看到核心能力是否可用、当前项目缺少什么，以及最短修复命令。

## 功能要求

- 检查当前模型、模型配置错误和认证配置状态。
- 检查核心工具是否注册、当前启用了多少工具。
- 检查 Windows 的 Git Bash，拒绝把旧 WSL `bash.exe` 中继当成可用 Shell。
- 根据项目根标记识别 TypeScript/JavaScript、Python 和 Go。
- 只对当前项目实际使用的语言检查对应 LSP。
- 检查可选的 mgrep 是否已安装，但未安装不阻塞普通开发。
- 说明联网搜索的无 Key 回退和可选 Brave Key 状态。
- 显示全局与项目 `settings.json`、`models.json` 和 `auth.json` 的位置，但不显示任何凭据内容。
- 每个问题附带一条短而准确的中文修复建议。

## 非功能要求

- 默认诊断不访问网络、不调用模型、不启动 Shell、不启动 LSP、不执行 mgrep。
- 不读取或输出 API Key、Token、认证对象和环境变量值。
- 不修改设置、配置、项目文件或会话状态。
- 单个检查失败不能中断其他检查。
- 典型项目应在 250ms 内完成；输出最多 12,000 字符，单条细节最多 400 字符。
- 诊断逻辑使用依赖注入，可以在测试中覆盖平台、PATH、文件系统和运行时状态。
- `/doctor` 只是用户命令，不注册模型工具，因此普通对话增加 0 个工具 Schema Token。

## 方案比较

### 方案 A：在线端到端自检

实际调用模型、搜索服务和语言服务器。证据最接近真实请求，但会变慢、受外部服务波动影响，甚至可能产生付费调用。拒绝作为默认行为。

### 方案 B：只打印配置文件和安装说明

实现简单，但不能区分“已安装可用”和“根本不存在”，仍需要用户猜测。拒绝。

### 方案 C：离线证据检查

检查当前进程已经拥有的模型和工具状态，扫描有限的根标记与 PATH 可执行文件，并生成分级修复建议。它不能证明远端服务在线，但速度稳定、没有费用、没有副作用。采用此方案。

## 高层结构

```text
/doctor
   |
   v
收集只读快照
├── 当前 cwd、平台、PATH
├── SettingsManager 加载错误与 shellPath
├── ModelRegistry 错误、模型数量、当前模型、认证状态
├── 已注册工具与当前活动工具
└── 配置文件路径和存在性
   |
   v
纯诊断引擎
├── 核心：模型、工具、Shell
├── 项目：语言识别、对应 LSP
├── 可选：mgrep、联网搜索
└── 配置：settings/models/auth
   |
   v
独立检查结果[]
   |
   v
有界中文报告 → TUI notify
```

## 检查等级

| 等级 | 含义 | 示例 |
|---|---|---|
| `error` | 核心能力不可用，会阻塞主要任务 | 没有模型、models.json 解析失败、核心工具未注册 |
| `warning` | 当前项目需要的能力缺失 | Python 项目没有 basedpyright、Windows 找不到 Git Bash |
| `info` | 可选增强未安装或未启用 | mgrep 未安装、Brave Key 未配置 |
| `ok` | 已有本地证据证明就绪 | 当前模型可用、Git Bash 路径存在、gopls 在 PATH |

`/doctor` 的退出呈现由最严重结果决定：有 error 使用错误通知，只有 warning 使用警告通知，否则使用普通通知。

## Shell 检查

诊断不能为了检查 Shell 再调用 Shell。它按以下顺序检查文件：

1. `settings.json` 中明确配置的 `shellPath`。
2. Windows 常见 Git Bash 位置。
3. PATH 中的 `bash`，以及 PATH 中 `Git/cmd` 相邻的 `Git/bin/bash.exe`。
4. Unix 的 `/bin/bash` 或 PATH 中的 `bash`。

Windows 的 `C:\Windows\System32\bash.exe` 和 `Sysnative\bash.exe` 明确判为不可用，避免再次进入损坏的 WSL 中继。

## 项目语言与 LSP

只扫描当前目录中的有限根标记，不递归遍历代码库：

- TypeScript/JavaScript：`tsconfig.json`、`jsconfig.json`、`package.json`
- Python：`pyproject.toml`、`uv.lock`、`requirements.txt`、`setup.py`、`setup.cfg`
- Go：`go.mod`、`go.work`

Node 运行方式下，TypeScript 语言服务器属于随 Pi 安装的依赖；独立 Bun 二进制才检查外部 `typescript-language-server`。Python 接受 `basedpyright-langserver`、`pyright-langserver` 或 `pylsp`，Go 检查 `gopls`。

## 安全边界

- `auth.json` 只检查是否存在，绝不读取文件内容。
- 环境变量只检查 `BRAVE_API_KEY` 是否为非空，绝不输出值。
- 模型认证只调用已有的布尔状态，不解析或打印 Key。
- 错误信息移除控制字符并限制长度，避免终端破坏和意外大输出。
- 修复建议只作为文字显示，不自动安装、不自动登录、不自动改配置。

## 失败模式

| 问题 | 处理 |
|---|---|
| settings.json 无法解析 | 记录 error，其他检查继续使用默认设置 |
| models.json 无效 | 使用 ModelRegistry 已有错误，记录 error |
| PATH 缺失或格式异常 | 视为空 PATH，给对应安装建议 |
| 某个文件探测抛错 | 将该检查转为 warning，继续其余检查 |
| 可选工具未安装 | info，不降低核心健康状态 |
| 报告过长 | 保留摘要和前部检查，末尾标记截断 |

## 验证

- 可执行文件解析：Windows PATHEXT、Git/cmd 邻接路径、旧 WSL 排除、Unix X_OK。
- 项目语言识别：空项目、单语言、多语言。
- 分级规则：核心失败、项目相关 LSP 缺失、可选能力缺失。
- 隐私测试：报告不包含模拟 API Key 和环境变量值。
- 扩展测试：`/doctor` 注册、状态清理、通知等级和异常隔离。
- 相关扩展回归与 `npm run check`。
