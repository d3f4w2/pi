# 本地确定性评测基础实施计划

## Step 1：升级运行记录

- 定义 `RunRecord`、Token/费用、重试和验证证据摘要。
- 从 assistant turn 汇总 usage，不保存提示词、路径、源码或工具参数。
- 读取旧版记录时迁移，损坏行继续跳过。
- 扩展 run-metrics 专项测试。

## Step 2：实现评测核心

- 定义 `EvalCase`、案例观测、评分结果、`EvalReport` 和基线比较结果。
- 实现确定性评分器、P50/P95、Token、延迟、工具错误和重试统计。
- 建立 10 个不联网、不调用模型的基础设施冒烟案例。
- 测试通过、失败、预算退步和稳定重复运行。

## Step 3：实现存储和 `/evals`

- 报告写入有大小上限的 JSONL；损坏行隔离。
- 基线使用原子替换保存。
- `/evals run`、`baseline`、`compare`、`failures`、`latest` 提供短中文结果。
- 所有输出明确说明基础设施冒烟不代表代理能力提升。

## Step 4：文档、验证和提交

- 更新 `[Unreleased]`、代理平台路线和命令说明。
- 运行 run-metrics、evals 和浏览器专项测试。
- 运行 `npm run check`。
- 只暂存本次收尾和评测相关文件，提交后推送个人仓库。
