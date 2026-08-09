# verify 代码验证

`verify` 在代码修改后运行最小范围的类型检查、相关测试或 lint，并只把关键结果交给模型。

## 什么时候使用

- 修改业务逻辑或修复 Bug 后
- 修改公共接口、构建配置或依赖后
- 提交代码前需要证明改动正确时

只回答问题、读取代码、修改文档或注释时不要使用。

## 操作

| operation | 行为 |
| --- | --- |
| `auto` | 默认；类型检查后，只运行能安全定位的相关测试 |
| `typecheck` | 只运行类型或静态检查 |
| `test` | 运行测试；没有具体测试文件时允许运行目标项目的完整测试 |
| `lint` | 只运行项目 lint |

示例：

```text
verify operation="auto" path="packages/coding-agent/src/extensions/verify/service.ts"
```

`timeout` 是每项检查的秒数，默认 60，最小 5，最大 300。

## 语言支持

### TypeScript/JavaScript

- 优先使用 `typecheck`、`type-check`、`check:types` 或 `check-types` 脚本。
- 没有脚本时使用项目本地或 Pi 自带的 TypeScript。
- 测试和 lint 使用 `package.json` 中的脚本。
- 自动识别 npm、pnpm、yarn 和 Bun。

### Python

- 类型检查依次尝试 `basedpyright`、`pyright`。
- 单个 `.py` 文件即使没有 `pyproject.toml` 也可以检查，并先通过 Python AST 做不执行代码的语法检查。
- 测试使用 `python -m pytest`。
- lint 使用 `ruff check`。
- 缺少工具时只提示安装，不会自动安装，也不会阻止后续可用检查。

### Go

- `auto` 和 `test` 使用 `go test`，同时完成编译和测试。
- `typecheck` 和 `lint` 使用 `go vet`。
- 指向具体文件时只检查对应包。

## 输出与日志

通过时只返回检查名称和耗时。失败时最多返回 40 行关键错误，完整的已捕获输出保存在：

```text
~/.pi/agent/verify-logs/
```

每项默认最多运行 60 秒。失败或超时后停止，不会循环重试。

## “检查修改”和“查看内容”的区别

- “检查刚才的修改”“验证刚才的代码”：调用 `verify`，用检查结果证明代码是否正确。
- “看看刚才写了什么”“读取文件”：调用 `read`，只展示内容。

只要刚通过 `write` 或 `edit` 修改了代码，“检查、验证、确认正确、测试刚写的代码”都应先调用 `verify`。

`verify` 不会自动运行普通源文件，避免执行刚创建但尚未确认安全的代码。只有用户明确要求运行程序时，代理才可以在验证之后使用终端执行。
