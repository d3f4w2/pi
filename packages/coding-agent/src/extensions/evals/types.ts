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

export type RecoveredFailureKind = "tool_error" | "verification_failure" | "agent_error";

export interface RecoveredFailureSignal {
	fingerprint: string;
	kind: RecoveredFailureKind;
	toolName?: string;
	summary: string;
	detectedAt: string;
	recoveredAt: string;
}

export interface RegressionTestFileDraft {
	path: string;
	content: string;
}

export interface RegressionTestDraft {
	title: string;
	category: EvalCategory;
	reproduction: string[];
	expectedFailure: string;
	expectedSuccess: string;
	files: RegressionTestFileDraft[];
}

export type RegressionTestFramework = "node:test" | "vitest" | "pytest" | "go test";
export type RegressionQualityIssue = "missing_framework" | "missing_assertion" | "missing_product_reference";

export interface RegressionCaseQualityEvidence {
	version: 1;
	framework: RegressionTestFramework;
	assertionCount: number;
	productReferences: string[];
}

export interface RegressionDraftQuality {
	passed: boolean;
	issues: RegressionQualityIssue[];
	evidence?: RegressionCaseQualityEvidence;
}

export interface ApprovedRegressionCase {
	version: 1;
	id: string;
	title: string;
	category: EvalCategory;
	approvedAt: string;
	source: RecoveredFailureSignal;
	reproduction: string[];
	expectedFailure: string;
	expectedSuccess: string;
	quality?: RegressionCaseQualityEvidence;
	files: Array<{
		path: string;
		bytes: number;
		digest: string;
	}>;
}

export interface RegressionCaseStoreLike {
	isSuppressed(fingerprint: string): Promise<boolean>;
	suppress(fingerprint: string): Promise<void>;
	saveApproved(testCase: ApprovedRegressionCase): Promise<void>;
	listApproved(): Promise<ApprovedRegressionCase[]>;
}

export interface RegressionCaseWriterLike {
	write(
		workspace: string,
		draft: RegressionTestDraft,
		source: RecoveredFailureSignal,
		now?: Date,
	): Promise<ApprovedRegressionCase>;
}

export type AgentEvalCategory = "navigation" | "bug_fix" | "verification" | "recovery" | "scope_control";

export interface AgentEvalCase {
	id: string;
	title: string;
	category: AgentEvalCategory;
	task: string;
	publicFiles: Readonly<Record<string, string>>;
	hiddenFiles: Readonly<Record<string, string>>;
	timeoutMs: number;
	maxOutputTokens: number;
	maxToolCalls: number;
}

export type AgentEvalProgressStage = "preparing" | "starting" | "working" | "tool" | "verifying" | "cleanup";

export type AgentEvalTraceStatus = "running" | "passed" | "failed";

export interface AgentEvalTraceEntry {
	kind: "phase" | "tool";
	name: string;
	startedAtMs: number;
	durationMs: number;
	status: AgentEvalTraceStatus;
	input?: string;
	output?: string;
}

export interface AgentEvalTiming {
	preparingMs: number;
	startupMs: number;
	agentMs: number;
	verificationMs: number;
	cleanupMs: number;
}

export interface AgentEvalProgress {
	stage: AgentEvalProgressStage;
	toolName?: string;
	toolCalls: number;
	detail?: string;
}

export interface AgentEvalRunOptions {
	provider: string;
	model: string;
	thinkingLevel: string;
	tools: string[];
	onProgress?: (progress: AgentEvalProgress) => void;
}

export interface AgentEvalResult {
	version: 1;
	id: string;
	caseId: string;
	title: string;
	category: AgentEvalCategory;
	createdAt: string;
	provider: string;
	model: string;
	thinkingLevel: string;
	passed: boolean;
	verificationPassed?: boolean;
	budgetPassed?: boolean;
	timedOut: boolean;
	durationMs: number;
	totalTokens: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	toolCalls: number;
	toolErrors: number;
	timing?: AgentEvalTiming;
	trace?: AgentEvalTraceEntry[];
	assistantSummary?: string;
	failure?: string;
}

export interface AgentEvalRunnerLike {
	run(testCase: AgentEvalCase, options: AgentEvalRunOptions, signal?: AbortSignal): Promise<AgentEvalResult>;
}

export interface AgentEvalResultStoreLike {
	append(result: AgentEvalResult): Promise<void>;
	read(limit?: number): Promise<AgentEvalResult[]>;
}
