# 单代理平台对标与产品策略

状态：已确认，分阶段实施

日期：2026-08-09

## 一句话结论

Pi 下一阶段不应该继续堆工具数量，而应该把现有工具组成一个闭环：

> 执行任务 → 留下证据 → 按需评测 → 产生候选记忆或改进 → 安全验证 → 用户批准 → 灰度使用 → 回滚本地状态

这条路线比单纯模仿 Oh My Pi 更适合我们的目标，因为它同时提高成功率、速度、Token 效率、安全性和用户掌控感。

## 我们从先进实现里学什么

| 参考实现 | 最值得学习的能力 | 我们的取舍 |
| --- | --- | --- |
| Oh My Pi | 完整的工具组、LSP/DAP、持久化 eval、上下文压缩、记忆后端、工具失败处理 | 复用工具工程思路，不追求工具数量；优先补齐评测、记忆和治理闭环 |
| OpenAI Codex | 沙箱、审批、网络控制、规则、Skills、可复现环境、安全扫描与修复验证 | 建立统一能力权限模型；把检查、修复、验证分开记录 |
| Claude Code | 目录作用域、allow/deny 规则、计划模式、权限来源可见 | 权限不仅是“询问/不询问”，还要明确文件、命令、网络和凭据范围 |
| Letta | 常驻小记忆、按需检索的长期记忆、可挂载和只读记忆块 | 不把所有历史塞进上下文；分层存储、按需召回 |
| Cursor / Windsurf | 用户规则、项目规则、自动记忆分离；可共享知识写入规则或 AGENTS.md | 自动记忆只作为候选；稳定团队知识进入可审查的项目规则 |
| Harbor / SWE-bench / Terminal-Bench | 真实任务、隔离环境、确定性验证、重复运行和回归比较 | 先建本地小型评测集，再接外部基准；不靠模型“感觉不错”打分 |
| SICA / Darwin Gödel Machine / ACE | 从运行结果产生候选改进，让多个候选在评测中竞争 | 初期只允许改进提示词、策略和 Skill；禁止生产代理直接改核心代码 |

## 当前 Pi 的基础与缺口

### 已经较强的部分

- 精确读写、结构化搜索、LSP、AST、DAP、持久化 eval。
- 工具失败熔断、异常隔离、后台进程和网页异常隔离。
- `/tools`、`tool_search`、权限模式、长期任务台账、运行指标。
- 变更后的自动诊断、影响范围分析、验证工具和撤销能力。

这些能力说明执行层已经够用，不需要再从零重做。

### 仍然缺少的闭环

| 板块 | 当前情况 | 真正缺少的部分 |
| --- | --- | --- |
| 评测 | 已记录部分运行指标 | 开发集与隐藏保留集、不可修改的评分器、重复运行、版本比较和发布门禁 |
| 记忆 | 主要依赖会话、文档和 Skill | 分层记忆、来源、时效、失效检测、查看/修改/遗忘 |
| 自进化 | 没有受控闭环 | 从失败归因到候选改进，再到隔离评测、批准、灰度和回滚 |
| 安全 | 有信任和审批，但同进程扩展仍拥有 Pi 进程权限 | 每次调用的能力判断、进程外强制边界、秘密隔离、审计和可选沙箱 |
| 可操作性 | 功能很多，入口分散 | 能力总览、状态解释、配置来源、故障恢复和新手模式 |
| 上下文 | 已有智能读取和过期失效 | 更稳定的中途压缩、跨会话交接、检查点和可控回忆 |

## 产品原则

1. **正确率优先**：先确认任务做对，再优化 Token 和速度。
2. **当前证据优先**：代码、测试和用户当前指令永远高于旧记忆。
3. **评测先于进化**：没有可重复评测，就不允许自动推广改进。
4. **最小权限**：工具只得到完成当前动作所需的文件、命令、网络和凭据权限。
5. **可选能力不能拖垮主任务**：语义搜索、记忆、网页和外部服务失败时快速降级。
6. **用户始终看得见**：系统要说明正在做什么、为什么、预计多久、失败后怎么办。
7. **所有本地自动化状态都能撤销**：设置、记忆、策略、Skill 和候选版本都保留来源与回滚点；已经发生的外部副作用不能伪装成可撤销。
8. **控制面不能由候选修改**：评测器、权限策略、审批记录和隐藏测试必须位于候选不可写区域。
9. **记录不等于学习**：隐私安全的运行统计可以默认记录；可复现轨迹和长期学习必须单独授权。
10. **不制造虚假安全感**：能力声明用于判断和审计；只有进程外策略或操作系统隔离才能约束恶意扩展。

## 我们怎样超过 Oh My Pi

不是在“31 个还是 40 个工具”上竞争，而是在下面六点做得更可靠：

1. **证据绑定的记忆**：每条项目记忆带来源、版本、有效期；代码变化后自动变为“待复核”。
2. **有门禁的自进化**：改进必须战胜固定基线，而且不能增加安全回归、Token 和延迟失控。
3. **面向中国用户的低门槛操作**：短中文说明、渐进展示、一键诊断、明确等待提示。
4. **Token 与延迟预算是硬指标**：每次候选比较同时看成功率、Token、耗时、调用次数和重试数。
5. **安全策略是统一底座**：所有受控工具共享同一个权限、秘密、网络、审计模型；同进程扩展明确显示为受信代码。
6. **防刷分的评测**：开发集用于调试，隐藏保留集用于推广；候选不能修改评分器，也不能在批准后被替换。

## 明确不做

- 暂不追求更多模型供应商。
- 暂不把子代理、协作和多代理作为主线。
- 暂不允许代理直接修改并启用自己的核心运行代码。
- 不建立默认常驻的大型向量数据库。
- 不用单个模型裁判替代测试、类型检查和确定性规则。
- 不把原始会话、网页内容或失败轨迹直接变成长期记忆。
- 不把公开固定任务集上的单次高分当作推广依据。
- 不为了“看起来先进”重写 Rust 核心或复制所有 Oh My Pi 工具。

## 主要资料

- [Oh My Pi README](https://github.com/can1357/oh-my-pi)
- [Oh My Pi Memory](https://github.com/can1357/oh-my-pi/blob/main/docs/memory.md)
- [Oh My Pi Compaction](https://github.com/can1357/oh-my-pi/blob/main/docs/compaction.md)
- [Oh My Pi Settings](https://github.com/can1357/oh-my-pi/blob/main/docs/settings.md)
- [OpenAI Codex Security](https://learn.chatgpt.com/docs/security)
- [OpenAI Evals](https://platform.openai.com/docs/guides/evals)
- [Anthropic Claude Code Security](https://docs.anthropic.com/en/docs/claude-code/security)
- [Letta Memory Blocks](https://docs.letta.com/guides/agents/memory-blocks)
- [Cursor Rules and Memories](https://docs.cursor.com/context/rules)
- [Windsurf Memories and Rules](https://docs.windsurf.com/windsurf/cascade/memories)
- [Harbor](https://github.com/harbor-framework/harbor)
- [Harbor Index](https://github.com/harbor-framework/harbor-index)
- [SWE-bench](https://www.swebench.com/)
- [Terminal-Bench 2.0](https://arxiv.org/abs/2505.17306)
- [A Self-Improving Coding Agent](https://arxiv.org/abs/2504.15228)
- [Darwin Gödel Machine](https://sakana.ai/dgm/)
- [Agentic Context Engineering](https://arxiv.org/abs/2510.04618)
