# 本地评测

`/evals` 用来检查本机评测基础是否工作，并把结果和一个已保存的基线比较。

```text
/evals run
/evals latest
/evals baseline
/evals compare
/evals failures
```

推荐顺序：

1. 运行 `/evals run`。
2. 确认 10 个离线案例通过。
3. 运行 `/evals baseline` 保存当前报告。
4. 修改代码并再次运行 `/evals run`。
5. 运行 `/evals compare` 查看差异。

报告比较成功率、Token、P50/P95 耗时、工具调用、错误和重试。报告保存在 `~/.pi/agent/evals/`。

## 边界

- 不调用模型。
- 不联网。
- 不读取 API Key、源码正文、提示词、路径或工具输入。
- 只验证评测器的本地数据和比较链路。
- 10 个案例全部通过不代表代理能力已经提高，也不能作为自动推广依据。

设计决策见 [ADR 0022](adr/0022-local-deterministic-evaluation-foundation.md)。
