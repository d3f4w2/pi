# ADR-0047: 官方 AST 语法包与单一语言注册表

## Status

Accepted

## Context

当前 `@ast-grep/napi@0.45.1` 的 `Lang` 类型只内建 HTML、JavaScript、TSX、CSS 和 TypeScript。Python、Go、Rust、JSON、YAML 不能通过猜测 `Lang.Python` 等不存在的成员启用。官方 API 只允许通过 `registerDynamicLanguage` 一次性注册本地 tree-sitter 动态库。

搜索和编辑此前各自调用语言检测；继续分散扩展会产生“能搜索但不能修改”或目录过滤不一致。JSON/YAML 结构化替换还必须在写盘前证明结果可解析。

## Decision

- 固定依赖官方 `@ast-grep/lang-python`、`lang-go`、`lang-rust`、`lang-json`、`lang-yaml` 包，并在进程内一次性注册。
- 建立唯一 `LanguageRegistry`，同时提供扩展名、glob、解析器 ID、模式编译和结果验证。
- `ast_grep` 与 `ast_edit` 只通过该注册表检测语言和收集文件。
- JSON/YAML 候选内容写盘前分别使用标准 JSON 解析和现有 YAML 库复核。
- Markdown 没有对应官方动态包；第一版实现并测试受限的块级结构适配器，不宣称通用语法覆盖。

## Consequences

### Positive

- Python/Go/Rust 使用真实 tree-sitter AST 和 ast-grep 捕获语义。
- 搜索、预览、文件过滤和修改不会出现语言漂移。
- 只增加需求明确且有测试的语法，不追求未验证的语言数量。

### Negative

- 发布包增加五个带平台预编译动态库的依赖和体积。
- 官方动态语言注册是进程级一次性操作，测试和扩展必须共享初始化结果。
- Markdown 支持范围小于通用 AST 查询。

### Neutral

- 动态语言包的安装脚本只在没有预编译库时尝试本地构建；依赖安装使用 `--ignore-scripts`，运行时直接选择包内平台预编译库。

## Alternatives Considered

**直接把字符串传给 `parseAsync`**

拒绝。未注册的自定义语言没有解析器，属于猜测 API。

**调用外部 ast-grep CLI**

拒绝。增加额外进程、安装状态和跨平台差异，并绕开现有原子编辑闭环。

**为六种语言写文本模式替换**

拒绝。Python/Go/Rust 不能满足真实结构化搜索和修改要求，JSON/YAML 也无法保证语法有效。

## References

- `node_modules/@ast-grep/napi/types/lang.d.ts`
- `node_modules/@ast-grep/napi/types/registerDynamicLang.d.ts`
- <https://ast-grep.github.io/advanced/custom-language.html>
