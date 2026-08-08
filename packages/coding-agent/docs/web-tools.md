# 联网工具

Pi 默认提供两个联网工具：

- `web_search`：搜索互联网，返回摘要和来源链接。
- `web_fetch`：读取指定网页，提取正文并转成 Markdown、纯文本或 HTML。

它们会自动出现在 `/tools` 中。上下键选择，左键关闭，右键开启。

搜索默认使用 DuckDuckGo，不需要 API Key。如果设置了 `BRAVE_API_KEY`，会优先使用 Brave，失败时自动回退到 DuckDuckGo：

```powershell
$env:BRAVE_API_KEY = "你的 Key"
pi-dev
```

联网请求只允许 HTTP 和 HTTPS，并会拦截本机、内网和云主机元数据地址。每次跳转都会重新检查，网页大小、输出大小和请求时间也有限制。网页和搜索结果始终按不可信外部内容处理。

## 参考实现与许可

工具接口和部分结果规范化行为参考了 `pi-webfetch` 与 `pi-websearch`：

- Copyright (c) 2026 Yeongyu Kim
- Copyright (c) 2026 Yeongyu

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
