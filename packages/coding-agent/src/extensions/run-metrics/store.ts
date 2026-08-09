import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunMetricRecord, RunMetricsStoreLike, RunOutcome, ToolRunUsage } from "./types.ts";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const ROTATED_RECORDS = 1000;
const VALID_OUTCOMES = new Set<RunOutcome>(["completed", "verified", "failed", "unverified", "aborted"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validUsage(value: unknown): value is ToolRunUsage {
	return (
		isRecord(value) &&
		typeof value.calls === "number" &&
		Number.isInteger(value.calls) &&
		value.calls >= 0 &&
		typeof value.errors === "number" &&
		Number.isInteger(value.errors) &&
		value.errors >= 0
	);
}

function parseRecord(value: unknown): RunMetricRecord | undefined {
	if (!isRecord(value) || value.version !== 1) return undefined;
	if (
		typeof value.startedAt !== "string" ||
		typeof value.durationMs !== "number" ||
		typeof value.turns !== "number" ||
		(value.taskKind !== "read_only" && value.taskKind !== "code_change") ||
		typeof value.outcome !== "string" ||
		!VALID_OUTCOMES.has(value.outcome as RunOutcome) ||
		!isRecord(value.tools)
	) {
		return undefined;
	}
	const tools: Record<string, ToolRunUsage> = {};
	for (const [name, usage] of Object.entries(value.tools)) {
		if (name.length === 0 || name.length > 100 || !validUsage(usage)) return undefined;
		tools[name] = usage;
	}
	return {
		version: 1,
		startedAt: value.startedAt,
		durationMs: Math.max(0, value.durationMs),
		turns: Math.max(0, Math.trunc(value.turns)),
		taskKind: value.taskKind,
		outcome: value.outcome as RunOutcome,
		tools,
	};
}

function parseLines(content: string): RunMetricRecord[] {
	return content.split(/\r?\n/).flatMap((line) => {
		if (!line.trim()) return [];
		try {
			const record = parseRecord(JSON.parse(line));
			return record ? [record] : [];
		} catch {
			return [];
		}
	});
}

export class RunMetricsStore implements RunMetricsStoreLike {
	private readonly filePath: string;

	constructor(filePath: string) {
		this.filePath = filePath;
	}

	async append(record: RunMetricRecord): Promise<void> {
		await mkdir(path.dirname(this.filePath), { recursive: true });
		try {
			if ((await stat(this.filePath)).size > MAX_FILE_BYTES) {
				const records = parseLines(await readFile(this.filePath, "utf8")).slice(-ROTATED_RECORDS);
				await writeFile(this.filePath, `${records.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
			}
		} catch (error) {
			if (!isRecord(error) || error.code !== "ENOENT") throw error;
		}
		await appendFile(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
	}

	async read(limit = ROTATED_RECORDS): Promise<RunMetricRecord[]> {
		try {
			return parseLines(await readFile(this.filePath, "utf8")).slice(-Math.max(1, Math.min(limit, ROTATED_RECORDS)));
		} catch (error) {
			if (isRecord(error) && error.code === "ENOENT") return [];
			throw error;
		}
	}
}
