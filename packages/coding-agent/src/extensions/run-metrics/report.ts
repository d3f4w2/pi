import type { RunOutcome, RunRecord } from "./types.ts";

const SUCCESS_OUTCOMES = new Set<RunOutcome>(["completed", "verified"]);

interface ToolAggregate {
	name: string;
	runs: number;
	calls: number;
	errors: number;
	successes: number;
}

function percent(value: number, total: number): string {
	return total === 0 ? "-" : `${Math.round((value / total) * 100)}%`;
}

export function formatRunMetrics(records: readonly RunRecord[]): string {
	if (records.length === 0) return "还没有执行记录。完成几个任务后再运行 /stats。";
	const successful = records.filter((record) => SUCCESS_OUTCOMES.has(record.outcome)).length;
	const verified = records.filter((record) => record.outcome === "verified").length;
	const unverified = records.filter((record) => record.outcome === "unverified").length;
	const failed = records.filter((record) => record.outcome === "failed" || record.outcome === "aborted").length;
	const totalTokens = records.reduce((sum, record) => sum + record.usage.totalTokens, 0);
	const totalCost = records.reduce((sum, record) => sum + record.usage.cost, 0);
	const aggregate = new Map<string, ToolAggregate>();
	for (const record of records) {
		for (const [name, usage] of Object.entries(record.tools)) {
			const current = aggregate.get(name) ?? { name, runs: 0, calls: 0, errors: 0, successes: 0 };
			current.runs++;
			current.calls += usage.calls;
			current.errors += usage.errors;
			if (SUCCESS_OUTCOMES.has(record.outcome)) current.successes++;
			aggregate.set(name, current);
		}
	}
	const lines = [
		`执行记录：${records.length} 次`,
		`成功 ${successful} · 已验证代码任务 ${verified} · 未验证 ${unverified} · 失败/中止 ${failed}`,
		`Token ${totalTokens.toLocaleString()} · 费用 $${totalCost.toFixed(4)}`,
		"",
		"工具                 使用任务  调用  错误  使用时成功  未使用时成功  相关差值",
	];
	for (const tool of [...aggregate.values()].sort((a, b) => b.runs - a.runs || b.calls - a.calls).slice(0, 12)) {
		const without = records.filter((record) => !(tool.name in record.tools));
		const withoutSuccesses = without.filter((record) => SUCCESS_OUTCOMES.has(record.outcome)).length;
		const withRate = tool.runs === 0 ? 0 : tool.successes / tool.runs;
		const withoutRate = without.length === 0 ? 0 : withoutSuccesses / without.length;
		const delta = without.length === 0 ? "-" : `${Math.round((withRate - withoutRate) * 100)}pp`;
		lines.push(
			`${tool.name.padEnd(20).slice(0, 20)} ${String(tool.runs).padStart(8)} ${String(tool.calls).padStart(5)} ${String(tool.errors).padStart(5)} ${percent(tool.successes, tool.runs).padStart(10)} ${percent(withoutSuccesses, without.length).padStart(12)} ${delta.padStart(9)}`,
		);
	}
	lines.push("", "说明：相关差值只用于发现线索，不代表工具与成功之间存在因果关系。数据不包含提示、代码、路径或输出。");
	return lines.join("\n");
}
