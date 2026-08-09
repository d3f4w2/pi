export type RunOutcome = "completed" | "verified" | "failed" | "unverified" | "aborted";

export interface ToolRunUsage {
	calls: number;
	errors: number;
}

export interface RunUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

export interface RunEvidence {
	verification: "not_needed" | "passed" | "failed" | "missing" | "waived";
	checks: number;
}

export interface RunRecord {
	version: 2;
	id: string;
	startedAt: string;
	durationMs: number;
	turns: number;
	retries: number;
	taskKind: "read_only" | "code_change";
	outcome: RunOutcome;
	tools: Record<string, ToolRunUsage>;
	usage: RunUsage;
	evidence: RunEvidence;
}

export interface RunMetricsStoreLike {
	append(record: RunRecord): Promise<void>;
	read(limit?: number): Promise<RunRecord[]>;
}
