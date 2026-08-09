# 单代理增强工具

## `/stats`：看工具效果

直接输入：

```text
/stats
```

它会显示最近任务的成功、验证、失败情况，以及每个工具在成功任务里出现的比例。数据只保存在本机，不记录提示、代码、路径或工具输出。

## `eval`：连续运行 Python/Bun

适合计算、解析数据和小实验。第一次调用会启动解释器，后续调用保留变量。

```text
请用 Python 计算这些数据，后面继续复用变量。
```

需要清空状态时让代理调用 `eval reset`。Python 或 Bun 没安装时只会给出提示，不会自动安装。

## `debug`：断点调试

适合静态阅读和测试仍然找不到原因的运行时问题。

```text
请在 main.py 第 20 行设置断点，运行后查看局部变量。
```

依赖：

- Python：`pip install debugpy`
- Go：`go install github.com/go-delve/delve/cmd/dlv@latest`
- JavaScript/TypeScript：使用已安装的 VS Code js-debug；无法自动找到时设置 `PI_JS_DEBUG_PATH` 指向 `dapDebugServer.js`

推荐顺序：`start → stack → scopes → variables → next/continue → stop`。

## 网页工具

`web_fetch` 会自动合并同一轮的重复请求，最多同时读取 4 个网页。取消、超时和连接中断只会结束当前工具，不会退出 Pi，也不会改用终端重复请求。
