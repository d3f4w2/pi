# Controlled plugins

受控插件把扩展、Skill、MCP 配置和只读资源装在一个包里。安装、校验、启用是三步：下载成功不等于获得运行权限。

## 管理

直接输入 `/plugins` 打开菜单，也可以使用：

```text
/plugins list
/plugins add <来源> [--project]
/plugins inspect <来源>
/plugins enable <来源>
/plugins disable <来源>
/plugins update <来源>
/plugins rollback <来源>
/plugins remove <来源>
```

项目插件只在项目受信任时启用。npm、pnpm 和 Bun 安装统一禁用生命周期脚本。

## 清单

插件根目录必须包含 `pi-plugin.json`：

```json
{
  "schemaVersion": 1,
  "id": "example-plugin",
  "version": "1.0.0",
  "minimumPiVersion": ">=0.84.1",
  "capabilities": {
    "extensions": ["extensions/index.ts"],
    "skills": ["skills/review/SKILL.md"],
    "mcp": ["mcp/servers.json"],
    "resources": ["resources/guide.md"]
  },
  "integrity": {
    "extensions/index.ts": "sha256-...",
    "skills/review/SKILL.md": "sha256-...",
    "mcp/servers.json": "sha256-...",
    "resources/guide.md": "sha256-..."
  }
}
```

pi-go 会拒绝路径越界、符号链接、缺失文件、重复声明、哈希不匹配、版本不兼容、超大插件和生命周期脚本。用户批准时记录清单指纹；文件或清单变化后必须重新批准。

更新先把旧版本原子移到备份，再安装、校验和询问。失败或拒绝会恢复旧版本；成功后保留一个已验证版本供 `/plugins rollback` 使用。插件资源使用不暴露本机路径的 `plugin://` 地址交给统一 `read`。
