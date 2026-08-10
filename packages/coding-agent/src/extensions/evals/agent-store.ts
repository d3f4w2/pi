import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type {
	AgentEvalCategory,
	AgentEvalResult,
	AgentEvalResultStoreLike,
	AgentEvalTiming,
	AgentEvalTraceEntry,
} from "./types.ts";

const CATEGORIES = new Set<AgentEvalCategory>(["navigation", "bug_fix", "verification", "recovery", "scope_control"]);
const MAX_RESULTS = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTraceEntry(value: unknown): value is AgentEvalTraceEntry {
	return (
		isRecord(value) &&
		(value.kind === "phase" || value.kind === "tool") &&
		typeof value.name === "string" &&
		typeof value.startedAtMs === "number" &&
		typeof value.durationMs === "number" &&
		(value.status === "running" || value.status === "passed" || value.status === "failed") &&
		(value.input === undefined || typeof value.input === "string") &&
		(value.output === undefined || typeof value.output === "string")
	);
}

function isTiming(value: unknown): value is AgentEvalTiming {
	return (
		isRecord(value) &&
		typeof value.preparingMs === "number" &&
		typeof value.startupMs === "number" &&
		typeof value.agentMs === "number" &&
		typeof value.verificationMs === "number" &&
		typeof value.cleanupMs === "number"
	);
}

function parseResult(value: unknown): AgentEvalResult | undefined {
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		typeof value.id !== "string" ||
		typeof value.caseId !== "string" ||
		typeof value.title !== "string" ||
		typeof value.category !== "string" ||
		!CATEGORIES.has(value.category as AgentEvalCategory) ||
		typeof value.createdAt !== "string" ||
		typeof value.provider !== "string" ||
		typeof value.model !== "string" ||
		typeof value.thinkingLevel !== "string" ||
		typeof value.passed !== "boolean" ||
		(value.verificationPassed !== undefined && typeof value.verificationPassed !== "boolean") ||
		(value.budgetPassed !== undefined && typeof value.budgetPassed !== "boolean") ||
		typeof value.timedOut !== "boolean" ||
		typeof value.durationMs !== "number" ||
		typeof value.totalTokens !== "number" ||
		(value.inputTokens !== undefined && typeof value.inputTokens !== "number") ||
		(value.outputTokens !== undefined && typeof value.outputTokens !== "number") ||
		(value.cacheReadTokens !== undefined && typeof value.cacheReadTokens !== "number") ||
		typeof value.toolCalls !== "number" ||
		typeof value.toolErrors !== "number" ||
		(value.timing !== undefined && !isTiming(value.timing)) ||
		(value.trace !== undefined && (!Array.isArray(value.trace) || !value.trace.every(isTraceEntry))) ||
		(value.assistantSummary !== undefined && typeof value.assistantSummary !== "string") ||
		(value.failure !== undefined && typeof value.failure !== "string")
	) {
		return undefined;
	}
	return value as unknown as AgentEvalResult;
}

export class AgentEvalResultStore implements AgentEvalResultStoreLike {
	private readonly filePath: string;

	constructor(directory: string) {
		this.filePath = path.join(directory, "agent-results.jsonl");
	}

	async append(result: AgentEvalResult): Promise<void> {
		await mkdir(path.dirname(this.filePath), { recursive: true });
		await appendFile(this.filePath, `${JSON.stringify(result)}\n`, "utf8");
	}

	async read(limit = MAX_RESULTS): Promise<AgentEvalResult[]> {
		try {
			return (await readFile(this.filePath, "utf8"))
				.split(/\r?\n/)
				.flatMap((line) => {
					if (!line.trim()) return [];
					try {
						const result = parseResult(JSON.parse(line));
						return result ? [result] : [];
					} catch {
						return [];
					}
				})
				.slice(-Math.max(1, Math.min(limit, MAX_RESULTS)));
		} catch (error) {
			if (isRecord(error) && error.code === "ENOENT") return [];
			throw error;
		}
	}
}
