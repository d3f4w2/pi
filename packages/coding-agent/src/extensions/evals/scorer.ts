import { createHash } from "node:crypto";
import type {
	EvalCase,
	EvalCaseMetrics,
	EvalCaseResult,
	EvalComparison,
	EvalObservation,
	EvalReport,
} from "./types.ts";

function aggregateTools(observation: EvalObservation): Pick<EvalCaseMetrics, "toolCalls" | "toolErrors"> {
	return Object.values(observation.run.tools).reduce(
		(total, usage) => ({ toolCalls: total.toolCalls + usage.calls, toolErrors: total.toolErrors + usage.errors }),
		{ toolCalls: 0, toolErrors: 0 },
	);
}

export function scoreEvalCase(testCase: EvalCase, observation: EvalObservation): EvalCaseResult {
	const failures: string[] = [];
	const tools = aggregateTools(observation);
	if (observation.caseId !== testCase.id) failures.push("案例标识不匹配");
	if (!testCase.expect.outcomes.includes(observation.run.outcome))
		failures.push(`结果不符合预期：${observation.run.outcome}`);
	if (testCase.expect.verification && observation.run.evidence.verification !== testCase.expect.verification) {
		failures.push(`验证证据不符合预期：${observation.run.evidence.verification}`);
	}
	if (testCase.expect.maxDurationMs !== undefined && observation.run.durationMs > testCase.expect.maxDurationMs) {
		failures.push(`耗时超过预算：${observation.run.durationMs}ms`);
	}
	if (testCase.expect.maxTokens !== undefined && observation.run.usage.totalTokens > testCase.expect.maxTokens) {
		failures.push(`Token 超过预算：${observation.run.usage.totalTokens}`);
	}
	if (testCase.expect.maxToolErrors !== undefined && tools.toolErrors > testCase.expect.maxToolErrors) {
		failures.push(`工具错误超过预算：${tools.toolErrors}`);
	}
	if (testCase.expect.maxRetries !== undefined && observation.run.retries > testCase.expect.maxRetries) {
		failures.push(`重试超过预算：${observation.run.retries}`);
	}
	for (const tool of testCase.expect.requiredTools ?? []) {
		if (!observation.run.tools[tool] || observation.run.tools[tool].calls === 0)
			failures.push(`缺少必要工具：${tool}`);
	}
	return {
		id: testCase.id,
		title: testCase.title,
		category: testCase.category,
		passed: failures.length === 0,
		failures,
		metrics: {
			durationMs: observation.run.durationMs,
			totalTokens: observation.run.usage.totalTokens,
			toolCalls: tools.toolCalls,
			toolErrors: tools.toolErrors,
			retries: observation.run.retries,
		},
	};
}

function percentile(values: readonly number[], ratio: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0;
}

export function buildEvalReport(
	suiteId: string,
	candidateLabel: string,
	testCases: readonly EvalCase[],
	observations: readonly EvalObservation[],
	now = new Date(),
): EvalReport {
	const observationsByCase = new Map(observations.map((observation) => [observation.caseId, observation]));
	const results = testCases.map((testCase) => {
		const observation = observationsByCase.get(testCase.id);
		if (observation) return scoreEvalCase(testCase, observation);
		return {
			id: testCase.id,
			title: testCase.title,
			category: testCase.category,
			passed: false,
			failures: ["缺少案例观测"],
			metrics: { durationMs: 0, totalTokens: 0, toolCalls: 0, toolErrors: 0, retries: 0 },
		};
	});
	const digest = createHash("sha256").update(JSON.stringify({ suiteId, candidateLabel, testCases })).digest("hex");
	const createdAt = now.toISOString();
	const id = createHash("sha256").update(`${createdAt}:${digest}`).digest("hex").slice(0, 24);
	const passed = results.filter((result) => result.passed).length;
	return {
		version: 1,
		id,
		createdAt,
		suiteId,
		candidate: { label: candidateLabel, digest },
		environment: { platform: process.platform, arch: process.arch, node: process.version },
		cases: results,
		summary: {
			total: results.length,
			passed,
			failed: results.length - passed,
			successRate: results.length === 0 ? 0 : passed / results.length,
			totalTokens: results.reduce((sum, result) => sum + result.metrics.totalTokens, 0),
			durationMs: results.reduce((sum, result) => sum + result.metrics.durationMs, 0),
			p50DurationMs: percentile(
				results.map((result) => result.metrics.durationMs),
				0.5,
			),
			p95DurationMs: percentile(
				results.map((result) => result.metrics.durationMs),
				0.95,
			),
			toolCalls: results.reduce((sum, result) => sum + result.metrics.toolCalls, 0),
			toolErrors: results.reduce((sum, result) => sum + result.metrics.toolErrors, 0),
			retries: results.reduce((sum, result) => sum + result.metrics.retries, 0),
		},
	};
}

export function compareEvalReports(baseline: EvalReport, candidate: EvalReport): EvalComparison {
	const baselineCases = new Map(baseline.cases.map((result) => [result.id, result]));
	const regressions = candidate.cases
		.filter((result) => baselineCases.get(result.id)?.passed === true && !result.passed)
		.map((result) => result.id);
	const delta = {
		successRate: candidate.summary.successRate - baseline.summary.successRate,
		totalTokens: candidate.summary.totalTokens - baseline.summary.totalTokens,
		p95DurationMs: candidate.summary.p95DurationMs - baseline.summary.p95DurationMs,
		toolCalls: candidate.summary.toolCalls - baseline.summary.toolCalls,
		toolErrors: candidate.summary.toolErrors - baseline.summary.toolErrors,
		retries: candidate.summary.retries - baseline.summary.retries,
	};
	const reasons: string[] = [];
	if (baseline.suiteId !== candidate.suiteId) reasons.push("评测套件不一致");
	if (regressions.length > 0) reasons.push(`出现 ${regressions.length} 个案例回退`);
	if (delta.successRate < 0) reasons.push("成功率下降");
	if (baseline.summary.totalTokens > 0 && delta.totalTokens / baseline.summary.totalTokens > 0.05) {
		reasons.push("Token 增幅超过 5%");
	}
	if (baseline.summary.p95DurationMs > 0 && delta.p95DurationMs / baseline.summary.p95DurationMs > 0.1) {
		reasons.push("P95 耗时增幅超过 10%");
	}
	if (delta.toolErrors > 0) reasons.push("工具错误增加");
	if (delta.retries > 0) reasons.push("重试增加");
	return {
		passed: reasons.length === 0,
		baselineId: baseline.id,
		candidateId: candidate.id,
		regressions,
		reasons,
		delta,
	};
}
