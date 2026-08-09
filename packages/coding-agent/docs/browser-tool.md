# 浏览器工具

`browser` 用于验证真实网页交互、浏览器控制台和视觉结果。普通网页资料读取仍优先使用 `web_fetch`。

## 使用方式

先启动开发服务器，然后告诉 Pi：

```text
打开 http://localhost:3000，检查页面、控制台并截图
```

也可以输入：

```text
/browser
```

代理工具支持：

- `open`：打开 HTTP 或 HTTPS 页面。
- `snapshot`：返回页面文字和带 `e1`、`e2` 引用的可操作元素。
- `click`：点击快照返回的元素引用。
- `type`：向快照返回的输入元素填写文字，可选择按 Enter。
- `console`：读取页面控制台和运行时异常。
- `screenshot`：返回当前视口截图。
- `status` / `close`：查看状态或关闭浏览器。

## 安装和隐私

- 自动查找本机 Chrome、Edge 或 Chromium。
- 找不到时可设置 `PI_BROWSER_EXECUTABLE` 为浏览器程序路径。
- 使用临时隔离配置，不读取个人浏览器 Cookie、登录状态、历史记录或扩展。
- 只允许 HTTP 和 HTTPS，禁止 `file://` 和网址内账号密码。
- 网页和控制台内容始终是不可信外部内容。
- 退出 Pi 时自动关闭浏览器并清理临时目录。

设计决策见 [ADR-0016](adr/0016-direct-cdp-browser-control.md)。
