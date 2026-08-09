export type RunOutcome = "completed" | "verified" | "failed" | "unverified" | "aborted";

export interface ToolRunUsage {
	calls: number;
	errors: number;
}

export interface RunMetricRecord {
	version: 1;
	startedAt: string;
	durationMs: number;
	turns: number;
	taskKind: "read_only" | "code_change";
	outcome: RunOutcome;
	tools: Record<string, ToolRunUsage>;
}

export interface RunMetricsStoreLike {
	append(record: RunMetricRecord): Promise<void>;
	read(limit?: number): Promise<RunMetricRecord[]>;
}
