# 统一 read

`read` 是一个入口，不需要先判断该用文件工具、网页工具还是解压命令。

## 能读什么

- 本地文本和图片
- `http://`、`https://` 网页与文本资源
- 本地或网络 PDF
- ZIP、TAR、TAR.GZ 和普通 GZ
- `file://` 文件地址
- `pi://project/<path>` 当前项目文件
- `pi://docs/<path>` Pi-go 自带文档
- MCP 或插件注册的内部资源地址

## 常用方式

```text
read({ path: "src/index.ts" })
read({ path: "https://example.com/docs" })
read({ path: "manual.pdf", page: 3 })
read({ path: "release.zip" })
read({ path: "release.zip", entry: "docs/README.md" })
read({ path: "release.zip!/docs/README.md" })
read({ path: "pi://project/package.json" })
```

读取压缩包时，先不传 `entry` 查看目录，再读取一个具体文件。这样更快，也更省 token。

## 安全边界

- 网页请求沿用私网和本机地址拦截，网页内容会标记为不可信。
- 压缩包拒绝 `../`、绝对路径、超大条目、异常压缩比和 ZIP64。
- 单条目最多解压 20 MB，总展开声明最多 100 MB，最多 10,000 个条目。
- 压缩包只在内存中读取，不会把内容写到磁盘。
- PDF 和网页最终仍受 read 的行数与字节上限控制。
- 本地普通文本保留行锚点和结构化大纲；网页、PDF和内部资源不生成可编辑锚点。

## 内部资源

扩展可以注册 URI 解析器：

```ts
const dispose = registerInternalReadResourceResolver({
  name: "knowledge",
  canRead: (uri) => uri.startsWith("knowledge://"),
  read: async (uri) => ({ data: await loadResource(uri), mimeType: "text/markdown" }),
});
```

解析器返回内容，统一 `read` 负责图片、PDF、压缩包、截断和展示。卸载扩展时调用 `dispose()`。
