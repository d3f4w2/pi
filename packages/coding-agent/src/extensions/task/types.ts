import type { ExtensionContext } from "../../core/extensions/types.ts";

export type TaskWorkerProfile = "research" | "coding";
export type TaskWorkerStatus = "running" | "completed" | "failed" | "cancelled";

export interface TaskWorkerStartRequest {
	prompt: string;
	profile: TaskWorkerProfile;
	timeoutMs: number;
}

export interface TaskWorkerLaunchContext {
	cwd: string;
	model: ExtensionContext["model"];
	thinkingLevel: ExtensionContext["thinkingLevel"];
}

export interface TaskWorkerUsage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	toolCalls: number;
}

export interface TaskWorkerRunResult {
	output: string;
	changedFiles: string[];
	verification: string[];
	usage: TaskWorkerUsage;
	workspacePath: string;
	truncated?: boolean;
}

export interface TaskWorkerSnapshot {
	id: string;
	status: TaskWorkerStatus;
	profile: TaskWorkerProfile;
	prompt: string;
	startedAt: string;
	endedAt?: string;
	result?: TaskWorkerRunResult;
	error?: string;
}

export interface TaskWorkerService {
	start(request: TaskWorkerStartRequest, context: TaskWorkerLaunchContext): TaskWorkerSnapshot;
	status(id?: string): TaskWorkerSnapshot[];
	result(id: string): TaskWorkerSnapshot;
	cancel(id: string): Promise<TaskWorkerSnapshot>;
	stopAll(): Promise<void>;
}
