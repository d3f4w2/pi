# ADR-0016: 通过 CDP 控制临时浏览器

## Status

Accepted

## Context

网页项目仅通过类型检查和命令测试仍可能出现布局、交互、控制台或运行时错误。代理需要在真实浏览器中打开页面、读取可操作元素、点击、输入、截图和查看错误。

引入完整浏览器框架会增加包体、安装脚本和浏览器下载成本。直接复用用户已安装的 Chrome、Edge 或 Chromium 更适合 Pi 的本地开发场景。

## Decision

注册一个 `browser` 工具，通过 Chrome DevTools Protocol（CDP）控制一个隔离的临时浏览器会话，支持：

```text
open -> snapshot -> click/type -> console/screenshot -> close
```

关键约束：

1. 自动发现 Chrome、Edge 或 Chromium，也允许通过 `PI_BROWSER_EXECUTABLE` 指定路径。
2. 使用临时用户目录启动无头浏览器，不读取用户日常浏览器的 Cookie、登录状态或扩展。
3. 只允许 `http://` 和 `https://`，禁止 `file://`、网址内账号密码和任意浏览器启动参数。
4. `snapshot` 返回有界的语义元素和稳定引用，不返回整页 HTML。
5. `click` 和 `type` 只操作最近快照产生的引用，不接受任意 JavaScript 或 CSS 选择器。
6. 控制台、异常、文本和截图都有大小上限。
7. 网页内容始终标记为不可信外部内容，不能成为代理指令。
8. Pi 会话关闭时关闭浏览器并清理临时目录。
9. 不提供 `/browser` 手动元素面板；元素引用仅供代理内部连续调用，用户只表达高层目标。

## Consequences

### Positive

- 不新增浏览器自动化依赖或安装脚本。
- 可以验证真实 DOM、交互、控制台和视觉结果。
- 临时配置目录避免泄露用户浏览器凭据。
- 语义快照比 HTML 更准确且更省 Token。

### Negative

- 依赖本机已经安装 Chromium 系浏览器。
- CDP 兼容层需要由项目维护。
- 第一版不支持多标签页、文件上传、下载和复用个人登录状态。

### Neutral

- `web_search` 和 `web_fetch` 继续负责资料搜索和正文读取；`browser` 只在真实交互或视觉验证必要时使用。

## Alternatives Considered

**引入 Playwright**

暂不采用。能力完整，但会增加直接依赖、安装脚本审查和浏览器下载成本。

**通过终端运行浏览器脚本**

拒绝。脚本输出和生命周期难以限制，也不能稳定复用页面状态。

**连接用户正在使用的浏览器配置**

拒绝。可能读取 Cookie、密码、历史记录和扩展数据。

## References

- `packages/coding-agent/src/extensions/browser/`
- Chrome DevTools Protocol
