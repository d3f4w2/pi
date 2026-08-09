import type { EvalComparison, EvalReport } from "./types.ts";

function percent(value: number): string {
	return `${Math.round(value * 100)}%`;
}

function signed(value: number, suffix = ""): string {
	return `${value > 0 ? "+" : ""}${value}${suffix}`;
}

export function formatEvalReport(report: EvalReport): string {
	const lines = [
		`评测基础设施：${report.summary.passed}/${report.summary.total} 通过`,
		`成功率 ${percent(report.summary.successRate)} · Token ${report.summary.totalTokens} · P50/P95 ${report.summary.p50DurationMs}/${report.summary.p95DurationMs}ms`,
		`工具调用 ${report.summary.toolCalls} · 错误 ${report.summary.toolErrors} · 重试 ${report.summary.retries}`,
	];
	const failures = report.cases.filter((result) => !result.passed);
	if (failures.length > 0) {
		lines.push("", "失败案例：");
		for (const result of failures) lines.push(`- ${result.id}：${result.failures.join("；")}`);
	}
	lines.push("", "说明：这是离线基础设施冒烟，不调用模型，也不代表代理能力提升。");
	return lines.join("\n");
}

export function formatEvalComparison(comparison: EvalComparison): string {
	const lines = [
		comparison.passed ? "基线比较：通过" : "基线比较：未通过",
		`成功率 ${signed(Math.round(comparison.delta.successRate * 100), "pp")} · Token ${signed(comparison.delta.totalTokens)} · P95 ${signed(comparison.delta.p95DurationMs, "ms")}`,
		`工具调用 ${signed(comparison.delta.toolCalls)} · 错误 ${signed(comparison.delta.toolErrors)} · 重试 ${signed(comparison.delta.retries)}`,
	];
	if (comparison.reasons.length > 0) lines.push("", ...comparison.reasons.map((reason) => `- ${reason}`));
	lines.push("", "说明：基础设施冒烟只能验证评测链路，不能作为功能推广证据。");
	return lines.join("\n");
}

export function formatEvalFailures(report: EvalReport): string {
	const failures = report.cases.filter((result) => !result.passed);
	if (failures.length === 0) return "最近一次基础设施冒烟没有失败案例。";
	return ["最近失败案例：", ...failures.map((result) => `- ${result.id}：${result.failures.join("；")}`)].join("\n");
}
