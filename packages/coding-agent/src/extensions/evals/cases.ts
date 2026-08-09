import type { RunRecord, ToolRunUsage } from "../run-metrics/types.ts";
import { buildEvalReport } from "./scorer.ts";
import type { EvalCase, EvalObservation, EvalReport } from "./types.ts";

const SUITE_ID = "infrastructure-smoke-v1";

export const INFRASTRUCTURE_SMOKE_CASES: readonly EvalCase[] = [
	{
		id: "locate-symbol",
		title: "定位符号",
		category: "navigation",
		expect: {
			outcomes: ["completed"],
			maxDurationMs: 400,
			maxTokens: 300,
			maxToolErrors: 0,
			maxRetries: 0,
			requiredTools: ["lsp"],
		},
	},
	{
		id: "exact-search",
		title: "精确搜索",
		category: "navigation",
		expect: {
			outcomes: ["completed"],
			maxDurationMs: 300,
			maxTokens: 250,
			maxToolErrors: 0,
			maxRetries: 0,
			requiredTools: ["grep"],
		},
	},
	{
		id: "edit-verify",
		title: "修改并验证",
		category: "editing",
		expect: {
			outcomes: ["verified"],
			verification: "passed",
			maxDurationMs: 800,
			maxTokens: 500,
			maxToolErrors: 0,
			maxRetries: 0,
			requiredTools: ["edit", "verify"],
		},
	},
	{
		id: "type-diagnostics",
		title: "类型诊断",
		category: "verification",
		expect: {
			outcomes: ["completed"],
			maxDurationMs: 500,
			maxTokens: 300,
			maxToolErrors: 0,
			maxRetries: 0,
			requiredTools: ["lsp"],
		},
	},
	{
		id: "focused-test",
		title: "专项测试",
		category: "testing",
		expect: {
			outcomes: ["verified"],
			verification: "passed",
			maxDurationMs: 1_000,
			maxTokens: 400,
			maxToolErrors: 0,
			maxRetries: 0,
			requiredTools: ["verify"],
		},
	},
	{
		id: "web-source",
		title: "联网来源",
		category: "web",
		expect: {
			outcomes: ["completed"],
			maxDurationMs: 900,
			maxTokens: 450,
			maxToolErrors: 0,
			maxRetries: 0,
			requiredTools: ["web_search"],
		},
	},
	{
		id: "process-lifecycle",
		title: "进程生命周期",
		category: "process",
		expect: {
			outcomes: ["completed"],
			maxDurationMs: 700,
			maxTokens: 350,
			maxToolErrors: 0,
			maxRetries: 0,
			requiredTools: ["process"],
		},
	},
	{
		id: "browser-snapshot",
		title: "浏览器快照",
		category: "browser",
		expect: {
			outcomes: ["completed"],
			maxDurationMs: 900,
			maxTokens: 450,
			maxToolErrors: 0,
			maxRetries: 0,
			requiredTools: ["browser"],
		},
	},
	{
		id: "debug-recovery",
		title: "调试恢复",
		category: "debugging",
		expect: {
			outcomes: ["verified"],
			verification: "passed",
			maxDurationMs: 1_000,
			maxTokens: 500,
			maxToolErrors: 0,
			maxRetries: 1,
			requiredTools: ["debug", "verify"],
		},
	},
	{
		id: "search-fallback",
		title: "搜索降级",
		category: "fallback",
		expect: {
			outcomes: ["completed"],
			maxDurationMs: 400,
			maxTokens: 250,
			maxToolErrors: 0,
			maxRetries: 0,
			requiredTools: ["grep"],
		},
	},
];

interface SmokeObservation {
	caseId: string;
	taskKind: RunRecord["taskKind"];
	outcome: RunRecord["outcome"];
	tools: Record<string, ToolRunUsage>;
	durationMs: number;
	totalTokens: number;
	retries?: number;
}

const SMOKE_OBSERVATIONS: readonly SmokeObservation[] = [
	{
		caseId: "locate-symbol",
		taskKind: "read_only",
		outcome: "completed",
		tools: { lsp: { calls: 1, errors: 0 } },
		durationMs: 120,
		totalTokens: 180,
	},
	{
		caseId: "exact-search",
		taskKind: "read_only",
		outcome: "completed",
		tools: { grep: { calls: 1, errors: 0 } },
		durationMs: 80,
		totalTokens: 140,
	},
	{
		caseId: "edit-verify",
		taskKind: "code_change",
		outcome: "verified",
		tools: { edit: { calls: 1, errors: 0 }, verify: { calls: 1, errors: 0 } },
		durationMs: 420,
		totalTokens: 320,
	},
	{
		caseId: "type-diagnostics",
		taskKind: "read_only",
		outcome: "completed",
		tools: { lsp: { calls: 1, errors: 0 } },
		durationMs: 160,
		totalTokens: 180,
	},
	{
		caseId: "focused-test",
		taskKind: "code_change",
		outcome: "verified",
		tools: { verify: { calls: 1, errors: 0 } },
		durationMs: 500,
		totalTokens: 240,
	},
	{
		caseId: "web-source",
		taskKind: "read_only",
		outcome: "completed",
		tools: { web_search: { calls: 1, errors: 0 } },
		durationMs: 560,
		totalTokens: 280,
	},
	{
		caseId: "process-lifecycle",
		taskKind: "read_only",
		outcome: "completed",
		tools: { process: { calls: 3, errors: 0 } },
		durationMs: 340,
		totalTokens: 210,
	},
	{
		caseId: "browser-snapshot",
		taskKind: "read_only",
		outcome: "completed",
		tools: { browser: { calls: 2, errors: 0 } },
		durationMs: 480,
		totalTokens: 300,
	},
	{
		caseId: "debug-recovery",
		taskKind: "code_change",
		outcome: "verified",
		tools: { debug: { calls: 2, errors: 0 }, verify: { calls: 1, errors: 0 } },
		durationMs: 680,
		totalTokens: 360,
		retries: 1,
	},
	{
		caseId: "search-fallback",
		taskKind: "read_only",
		outcome: "completed",
		tools: { grep: { calls: 1, errors: 0 } },
		durationMs: 100,
		totalTokens: 120,
	},
];

function observation(fixture: SmokeObservation, now: Date): EvalObservation {
	const verification =
		fixture.taskKind === "read_only" ? "not_needed" : fixture.outcome === "verified" ? "passed" : "missing";
	return {
		caseId: fixture.caseId,
		run: {
			version: 2,
			id: `smoke-${fixture.caseId}`,
			startedAt: now.toISOString(),
			durationMs: fixture.durationMs,
			turns: 1,
			retries: fixture.retries ?? 0,
			taskKind: fixture.taskKind,
			outcome: fixture.outcome,
			tools: fixture.tools,
			usage: {
				input: fixture.totalTokens,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: fixture.totalTokens,
				cost: 0,
			},
			evidence: { verification, checks: verification === "passed" ? 1 : 0 },
		},
	};
}

export function runInfrastructureSmoke(now = new Date()): EvalReport {
	return buildEvalReport(
		SUITE_ID,
		"local-infrastructure",
		INFRASTRUCTURE_SMOKE_CASES,
		SMOKE_OBSERVATIONS.map((fixture) => observation(fixture, now)),
		now,
	);
}
