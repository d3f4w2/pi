import path from "node:path";
import { getAgentDir } from "../../config.ts";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { formatRunMetrics } from "./report.ts";
import { RunMetricsStore } from "./store.ts";
import { RunMetricsTracker } from "./tracker.ts";
import type { RunMetricsStoreLike } from "./types.ts";

export function createRunMetricsExtension(store: RunMetricsStoreLike): (pi: ExtensionAPI) => void {
	return (pi) => {
		const tracker = new RunMetricsTracker();
		let pendingRecord: ReturnType<RunMetricsTracker["finish"]>;

		pi.on("agent_start", () => tracker.start());
		pi.on("tool_result", (event) => tracker.recordTool(event));
		pi.on("turn_end", (event) => {
			tracker.recordTurn();
			if (
				event.message.role === "assistant" &&
				(event.message.stopReason === "error" || event.message.stopReason === "aborted")
			) {
				tracker.markAborted();
			}
		});
		pi.on("agent_end", () => {
			pendingRecord = tracker.finish();
		});
		pi.on("agent_settled", async () => {
			const record = pendingRecord;
			pendingRecord = undefined;
			if (!record) return;
			try {
				await store.append(record);
			} catch {
				// Metrics are best-effort and must never affect the agent run.
			}
		});

		pi.registerCommand("stats", {
			description: "查看本机工具使用效果统计",
			handler: async (_args, ctx) => {
				try {
					ctx.ui.notify(formatRunMetrics(await store.read()), "info");
				} catch (error) {
					ctx.ui.notify(`读取执行记录失败：${error instanceof Error ? error.message : String(error)}`, "error");
				}
			},
		});
	};
}

export default createRunMetricsExtension(new RunMetricsStore(path.join(getAgentDir(), "metrics", "tool-runs.jsonl")));
