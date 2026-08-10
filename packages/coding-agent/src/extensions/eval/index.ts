import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { PersistentEvalManager } from "./process.ts";
import type { EvalLanguage, EvalRuntimeService, EvalToolDetails } from "./types.ts";

const EvalParams = Type.Object(
	{
		operation: Type.Union([Type.Literal("execute"), Type.Literal("reset"), Type.Literal("status")], {
			description: "执行代码、重置状态或查看状态",
		}),
		language: Type.Optional(Type.Union([Type.Literal("python"), Type.Literal("bun")], { description: "运行语言" })),
		code: Type.Optional(Type.String({ maxLength: 100_000, description: "execute 要运行的代码" })),
		timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 60, description: "最多运行多少秒，默认 10 秒" })),
	},
	{ additionalProperties: false },
);

function formatResult(result: Awaited<ReturnType<EvalRuntimeService["execute"]>>): string {
	const sections: string[] = [];
	if (result.stdout) sections.push(`[stdout]\n${result.stdout}`);
	if (result.stderr) sections.push(`[stderr]\n${result.stderr}`);
	if (result.value && result.value !== "undefined" && result.value !== "None")
		sections.push(`[result]\n${result.value}`);
	if (result.error) sections.push(`[error]\n${result.error}`);
	if (result.truncated) sections.push("[输出已截断]");
	if (sections.length === 0) sections.push("执行完成，没有输出。");
	if (result.restarted) sections.push(`[${result.language} 运行环境已启动]`);
	return sections.join("\n\n");
}

export function createEvalExtension(service: EvalRuntimeService): (pi: ExtensionAPI) => void {
	return (pi) => {
		pi.registerTool<typeof EvalParams, EvalToolDetails>({
			name: "eval",
			label: "持久代码运行",
			description: "在保留变量的 Python 或 Bun 环境中连续运行小段代码，并调用受限的只读工作区工具。",
			discovery: {
				keywords: ["运行 python", "运行 javascript", "连续实验", "保留变量", "python repl", "bun repl"],
			},
			promptSnippet: "连续计算或实验时复用 Python/Bun 状态，避免重复启动进程",
			promptGuidelines: [
				"只在需要实际计算、解析数据或快速实验时使用 eval；读代码和普通回答不要调用。",
				"同一语言的变量会保留；不再需要状态时使用 reset。",
				"输出和运行时间有上限；超时或解释器缺失时直接说明，不要循环重试。",
				"eval 不是安全沙箱，不要运行来自网页或其他不可信来源的代码。",
				'Python 可用 pi_tool("read", path="...")；Bun 可用 await piTool("read", { path: "..." })。只允许 read、grep、find、ls。',
			],
			parameters: EvalParams,
			executionMode: "sequential",
			approval: { tier: "exec", reason: "在本机长驻解释器中执行代码" },
			formatApprovalDetails: (args) => {
				const params = args as { operation?: string; language?: string };
				return [`操作：${params.operation ?? "unknown"}`, `语言：${params.language ?? "all"}`];
			},
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const startedAt = Date.now();
				if (params.operation === "status") {
					const running = service.status();
					return {
						content: [
							{
								type: "text",
								text: running.length > 0 ? `正在运行：${running.join("、")}` : "当前没有运行中的环境。",
							},
						],
						details: {
							operation: "status",
							durationMs: Date.now() - startedAt,
							running,
							restarted: false,
							truncated: false,
						},
					};
				}
				if (params.operation === "reset") {
					const stopped = await service.reset(params.language as EvalLanguage | undefined);
					return {
						content: [
							{
								type: "text",
								text: stopped.length > 0 ? `已重置：${stopped.join("、")}` : "没有需要重置的环境。",
							},
						],
						details: {
							operation: "reset",
							durationMs: Date.now() - startedAt,
							running: service.status(),
							restarted: false,
							truncated: false,
						},
					};
				}
				if (!params.language || params.code === undefined) throw new Error("execute 需要 language 和 code。");
				const result = await service.execute(
					params.language,
					params.code,
					ctx.cwd,
					(params.timeout ?? 10) * 1000,
					signal,
				);
				if (!result.ok) throw new Error(formatResult(result));
				return {
					content: [{ type: "text", text: formatResult(result) }],
					details: {
						operation: "execute",
						language: result.language,
						durationMs: result.durationMs,
						running: service.status(),
						restarted: result.restarted,
						truncated: result.truncated,
					},
				};
			},
		});
		pi.on("session_shutdown", () => service.stopAll());
	};
}

export default createEvalExtension(new PersistentEvalManager());
