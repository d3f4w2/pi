import type { RunEvidence, RunOutcome, RunRecord } from "../run-metrics/types.ts";

export type EvalCategory =
	| "navigation"
	| "editing"
	| "verification"
	| "testing"
	| "web"
	| "process"
	| "browser"
	| "debugging"
	| "fallback";

export interface EvalExpectation {
	outcomes: RunOutcome[];
	verification?: RunEvidence["verification"];
	maxDurationMs?: number;
	maxTokens?: number;
	maxToolErrors?: number;
	maxRetries?: number;
	requiredTools?: string[];
}

export interface EvalCase {
	id: string;
	title: string;
	category: EvalCategory;
	expect: EvalExpectation;
}

export interface EvalObservation {
	caseId: string;
	run: RunRecord;
}

export interface EvalCaseMetrics {
	durationMs: number;
	totalTokens: number;
	toolCalls: number;
	toolErrors: number;
	retries: number;
}

export interface EvalCaseResult {
	id: string;
	title: string;
	category: EvalCategory;
	passed: boolean;
	failures: string[];
	metrics: EvalCaseMetrics;
}

export interface EvalReportSummary extends EvalCaseMetrics {
	total: number;
	passed: number;
	failed: number;
	successRate: number;
	p50DurationMs: number;
	p95DurationMs: number;
}

export interface EvalReport {
	version: 1;
	id: string;
	createdAt: string;
	suiteId: string;
	candidate: {
		label: string;
		digest: string;
	};
	environment: {
		platform: NodeJS.Platform;
		arch: string;
		node: string;
	};
	cases: EvalCaseResult[];
	summary: EvalReportSummary;
}

export interface EvalComparison {
	passed: boolean;
	baselineId: string;
	candidateId: string;
	regressions: string[];
	reasons: string[];
	delta: {
		successRate: number;
		totalTokens: number;
		p95DurationMs: number;
		toolCalls: number;
		toolErrors: number;
		retries: number;
	};
}

export interface EvalReportStoreLike {
	append(report: EvalReport): Promise<void>;
	read(limit?: number): Promise<EvalReport[]>;
	saveBaseline(report: EvalReport): Promise<void>;
	readBaseline(): Promise<EvalReport | undefined>;
}
