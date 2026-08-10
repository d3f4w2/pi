# ADR 0046: MCP OAuth 凭据边界

## 状态

Accepted

## 问题

远程 MCP 常用 OAuth。把访问令牌直接放在 `mcp.json` headers 中会让项目配置、缓存指纹或错误输出意外复制凭据；只支持静态 Bearer 令牌也无法刷新或执行动态客户端注册。

## 决策

HTTP/SSE 配置只保存非秘密 OAuth 元数据：公开客户端 ID、scope 和回环端口。SDK OAuth 2.1 流负责授权服务器发现、动态注册、PKCE、刷新和 issuer 绑定。Pi 额外验证回调 `state`，只在 `127.0.0.1` 上临时接收回调。

令牌、注册信息、PKCE 校验器和状态使用现有 `AuthStorage` 写入权限受限的 `auth.json`，键同时绑定 MCP 服务名和 URL 哈希。MCP 配置、发现缓存、状态和错误不包含秘密值。

## 结果

远程 MCP 获得可刷新 OAuth，配置仍可安全进入版本控制。授权需要一次显式 `/mcp auth` 和可用的本地回环端口；无 UI 的后台发现只报告 `authorization_required`，不会自行打开浏览器。
