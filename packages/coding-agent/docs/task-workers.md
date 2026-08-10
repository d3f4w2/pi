# 隔离任务 worker

`task` 把边界明确的研究或编码工作交给独立 Agent，同时最多运行三个。每个任务都复制到临时项目快照中执行，因此不会与当前工作区或其他窗口争抢同一文件。

操作：

- `start`：启动 `research` 或 `coding` 任务，默认硬超时 300 秒。
- `status`：查看全部或指定任务状态。
- `result`：读取最终回答、改动文件、用量和快照路径。
- `cancel`：取消运行中的任务。

`research` 只能读取和搜索。`coding` 可以修改快照并运行命令，但不能再次调用 `task`。结果正文默认最多 32 KiB，超时即使子运行器没有主动响应取消也会终止父等待。

任务修改不会自动合并。`result` 返回的 `workspacePath` 只用于父 Agent 复核和手动应用；会话退出时临时快照全部删除。

设计决策见 [ADR 0044](adr/0044-bounded-isolated-task-workers.md)。
