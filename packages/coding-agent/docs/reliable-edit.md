# 可靠编辑

`read` 和 `edit` 已组成一个安全闭环，代理会自动使用，不需要用户配置。

读取普通文本文件时，每行前面会出现定位锚点：

```text
¶src/user.ts#nV3sD8qL2p
10#u8L2Qp|export function loadUser(id: string) {
11#P4c1Mx|  return users.get(id);
12#0aN7Ke|}
```

- `¶` 后面是文件路径和本次读取的版本。
- `10#u8L2Qp` 是第 10 行的定位锚点。
- `|` 后面才是文件原文。

代理修改时会把文件版本和锚点交给 `edit`：

```json
{
  "path": "src/user.ts",
  "baseHash": "nV3sD8qL2p",
  "edits": [
    {
      "startAnchor": "10#u8L2Qp",
      "endAnchor": "12#0aN7Ke",
      "newText": "export function loadUser(id: string): User | undefined {\n  return users.get(id);\n}"
    }
  ]
}
```

执行前会一次检查所有修改：

- 文件是否在读取后发生变化；
- 锚点是否仍然存在且没有歧义；
- 多个修改是否重叠；
- 修改是否真的改变了内容。

任何一项失败，文件都不会改变。全部通过后，本地文件会通过“临时文件 + 重命名”一次替换，进程中断时也不容易留下半个文件。

`AGENTS.md`、`SKILL.md` 和 Pi 自身文档仍按普通文本读取，避免给只读指令增加无用 token。没有锚点时，`edit` 仍可使用精确 `oldText/newText`。

架构与决策见 [Reliable Edit Architecture](reliable-edit-architecture.md)，实施与验证步骤见 [Reliable Edit Plan](reliable-edit-plan.md)。

