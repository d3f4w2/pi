import type { RunBudgetContract, RunVerificationContract } from "../../cli/run-contract.ts";
import type { RunVerificationEvidence } from "../../cli/run-receipt.ts";

export const GOAL_LOOP_ENTRY_TYPE = "goal-loop-v1";
export const GOAL_LOOP_SCHEMA_VERSION = 1;
export const MAX_GOAL_LENGTH = 200_000;
export const MAX_GOAL_REPORT_LENGTH = 2_000;
export const MAX_GOAL_QUESTION_LENGTH = 1_000;
export const MAX_GOAL_GAP_LENGTH = 4_000;
export const MAX_GOAL_ITERATION_HISTORY = 64;
export const MAX_GOAL_SCOPE_COUNT = 32;
export const MAX_GOAL_VERIFICATION_COUNT = 16;

export type GoalLoopStatus =
	| "running"
	| "verifying"
	| "paused"
	| "waiting_user"
	| "verified"
	| "budget_exhausted"
	| "stuck"
	| "stopped"
	| "failed";

export type GoalReportStatus = "complete" | "continue" | "needs_user";

export interface GoalLoopReport {
	status: GoalReportStatus;
	summary: string;
	gap?: string;
	question?: string;
}

export interface GoalLoopUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	cost: number;
}

export interface GoalLoopMetrics {
	turns: number;
	toolCalls: Record<string, number>;
	toolErrors: number;
	usage: GoalLoopUsage;
}

export interface GoalLoopIteration {
	number: number;
	startedAt: string;
	finishedAt?: string;
	report?: GoalLoopReport;
	verification: RunVerificationEvidence[];
	workspaceDigest?: string;
	workspaceCompliance?: {
		headChanged: boolean;
		scopeViolations: string[];
	};
	gap?: string;
	gapFingerprint?: string;
}

export interface GoalLoopBudget extends RunBudgetContract {
	maxIterations: number;
}

export interface GoalLoopState {
	schemaVersion: typeof GOAL_LOOP_SCHEMA_VERSION;
	revision: number;
	runId: string;
	goal: string;
	workspaceRoot: string;
	baselinePath: string;
	status: GoalLoopStatus;
	startedAt: string;
	updatedAt: string;
	iteration: number;
	scope: string[];
	verification: RunVerificationContract[];
	budget: GoalLoopBudget;
	metrics: GoalLoopMetrics;
	iterations: GoalLoopIteration[];
	repeatedGapCount: number;
	lastGapFingerprint?: string;
	reason?: string;
	receiptPath?: string;
	receiptError?: string;
	model?: { provider: string; id: string };
	lastResponse?: string;
}

export interface GoalLoopStartArguments {
	goal: string;
	scope: string[];
	verification: RunVerificationContract[];
	budget: GoalLoopBudget;
}

export type GoalLoopCommand = { action: "control" } | { action: "start"; arguments: GoalLoopStartArguments };

export interface GoalVerificationResult {
	evidence: RunVerificationEvidence[];
	workspaceDigest: string;
	workspaceCompliance: {
		headChanged: boolean;
		scopeViolations: string[];
	};
	gap: string;
	finishedAt: string;
}
