import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { ExecutionPolicy } from "./policy.ts";

const MISSING_VERIFICATION_MESSAGE =
	"代码已经修改，但还没有验证。请用 verify 检查最相关的文件或包；若失败，修复后最多再验证一次。";
const FAILED_VERIFICATION_MESSAGE =
	"刚才的验证没有通过。请根据关键错误修复，并用 verify 再检查一次；工具不可用或仍失败时直接说明。";

export default function executionControllerExtension(pi: ExtensionAPI): void {
	const policy = new ExecutionPolicy();

	pi.on("agent_start", () => policy.reset());
	pi.on("tool_result", (event) => policy.recordToolResult(event));
	pi.on("turn_end", (event, ctx) => {
		if (event.toolResults.length > 0 || event.message.role !== "assistant") return;
		if (event.message.stopReason === "error" || event.message.stopReason === "aborted") return;
		if (!pi.getActiveTools().includes("verify") || ctx.hasPendingMessages()) return;
		const reason = policy.takeReminder();
		if (!reason) return;
		pi.sendMessage(
			{
				customType: "single-agent-controller",
				content: reason === "failed" ? FAILED_VERIFICATION_MESSAGE : MISSING_VERIFICATION_MESSAGE,
				display: false,
				details: policy.snapshot(),
			},
			{ deliverAs: "steer" },
		);
	});
}
