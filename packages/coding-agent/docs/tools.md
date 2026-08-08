# 工具管理

在 Pi 中输入 `/tools`，可以查看、开启或关闭所有已注册工具。

```text
↑/↓ 选择
←    关闭
→    开启
Enter/Esc 完成并保存
```

工具选择会保存到：

```text
~/.pi/agent/tool-preferences.json
```

Windows 默认位置：

```text
C:\Users\用户名\.pi\agent\tool-preferences.json
```

下次启动 Pi 时会自动恢复，不需要重新打开一次。

Pi 保存的是用户明确做过的选择：

- 明确开启的工具记录在 `enabledTools`。
- 明确关闭的工具记录在 `disabledTools`。
- 以后新增的工具仍按自己的默认状态出现。
- 暂时未安装的扩展工具记录会保留，重新安装后继续生效。

如果保存失败，当前会话中的开关仍然有效，Pi 会显示警告；下次启动不会恢复这次修改。

实现结构和关键决策见 [工具管理架构](tools-architecture.md)。
