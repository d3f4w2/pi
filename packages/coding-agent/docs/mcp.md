# MCP

MCP（Model Context Protocol）让 pi-go 使用外部服务提供的工具、资源和提示词。MCP 只增加能力，不会绕过 `/tools`、工具审批、超时或会话清理。

## 配置位置

- 用户：`~/.pi/agent/mcp.json`
- 项目：`<项目>/.pi/mcp.json`，只在项目受信任时读取
- 受控插件：插件 `pi-plugin.json` 声明的 MCP 配置
- ACP：编辑器为当前会话传入的 MCP 配置

后面的来源覆盖前面的同名服务。`disabledServers` 可以停用服务。

```json
{
  "servers": {
    "local": {
      "command": "node",
      "args": ["server.js"],
      "env": { "TOKEN": "$MY_TOKEN" },
      "timeoutMs": 15000
    },
    "remote": {
      "url": "https://example.com/mcp",
      "oauth": {
        "clientId": "optional-public-client-id",
        "scope": "mcp:tools",
        "callbackPort": 33418
      }
    },
    "legacy": {
      "url": "https://example.com/sse",
      "transport": "sse"
    }
  },
  "disabledServers": ["legacy"]
}
```

支持 stdio、Streamable HTTP 和 SSE。URL 不能携带用户名或密码；密钥值不会写入缓存指纹或状态输出。

HTTP/SSE 服务可以把 `oauth` 设为 `true`，或使用上面的对象。没有 `clientId` 时会按服务器能力执行动态客户端注册。授权使用 PKCE、`state` 和授权服务器 `issuer` 校验；访问令牌、刷新令牌、客户端注册信息和校验器只保存在现有 `~/.pi/agent/auth.json` 凭据存储中，不写入 `mcp.json` 或 `mcp-cache.json`。

## 使用

```text
/mcp status
/mcp test [服务名]
/mcp reload [服务名]
/mcp auth <服务名>
/mcp resources [服务名]
/mcp prompts [服务名]
/mcp prompt <服务名> <提示词名>
```

远端工具名会变成 `mcp__服务名__工具名`。只读工具按 read 级别审批，其余工具按 exec 级别审批。资源通过 `/mcp resources` 得到 `mcp://` 地址，再交给统一 `read` 读取。

启动不会等待所有 MCP 服务联网。pi-go 先加载安全缓存，再在后台连接；失败只影响对应服务，不拖住主任务。

状态显示 `authorization_required` 时，运行 `/mcp auth <服务名>`，打开通知中的地址并完成授权。Pi 只在 `127.0.0.1` 上临时监听配置的回调端口，收到一次回调或超时后立即关闭。

设计决策见 [ADR 0046](adr/0046-mcp-oauth-credential-boundary.md)。
