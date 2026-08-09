# 快速源码开发启动器实现计划

## 目标

把 Windows 下 `pi-dev` 的主要启动成本从每次 `tsx` 转译降为 Node 原生类型擦除，同时保留源码即时生效和参数透传。

## 基线

- `tsx src/cli.ts --version`：热启动约 4–8 秒。
- `node dist/cli.js --version`：热启动约 1.2–1.3 秒，但可能运行旧构建。
- `node --experimental-strip-types src/cli.ts --version`：热启动约 1.5–1.7 秒。
- 正常与隔离配置目录的 RPC 启动中位数都约 1.34 秒，说明用户资源扫描不是当前主要瓶颈。

## 步骤

1. 新增 `scripts/pi-dev.ps1`，定位仓库、Node 和源码入口。
2. 使用 Node 原生 TypeScript strip-only 启动，并原样转发参数。
3. 把用户 PowerShell 的 `pi-dev` 函数改为调用该脚本。
4. 验证版本输出、调用目录恢复和多次启动耗时。
5. 运行仓库检查并记录结果。

## 不做

- 不引入后台守护进程。
- 不为启动创建缓存文件。
- 不跳过正常功能初始化。
- 不依赖构建产物。
