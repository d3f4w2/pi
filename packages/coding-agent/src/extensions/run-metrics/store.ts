import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunEvidence, RunMetricsStoreLike, RunOutcome, RunRecord, RunUsage, ToolRunUsage } from "./types.ts";

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
		value.errors >= 0 &&
		(value.errorFingerprints === undefined ||
			(Array.isArray(value.errorFingerprints) &&
				value.errorFingerprints.length <= 5 &&
				value.errorFingerprints.every((item) => typeof item === "string" && /^[a-f0-9]{64}$/u.test(item))))
	);
}

function validNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseRunUsage(value: unknown): RunUsage | undefined {
	if (!isRecord(value)) return undefined;
	if (
		!validNumber(value.input) ||
		!validNumber(value.output) ||
		!validNumber(value.cacheRead) ||
		!validNumber(value.cacheWrite) ||
		!validNumber(value.totalTokens) ||
		!validNumber(value.cost)
	) {
		return undefined;
	}
	return {
		input: value.input,
		output: value.output,
		cacheRead: value.cacheRead,
		cacheWrite: value.cacheWrite,
		totalTokens: value.totalTokens,
		cost: value.cost,
	};
}

const VALID_VERIFICATION = new Set<RunEvidence["verification"]>([
	"not_needed",
	"passed",
	"failed",
	"missing",
	"waived",
]);

function parseEvidence(value: unknown): RunEvidence | undefined {
	if (
		!isRecord(value) ||
		typeof value.verification !== "string" ||
		!VALID_VERIFICATION.has(value.verification as RunEvidence["verification"]) ||
		!validNumber(value.checks)
	) {
		return undefined;
	}
	return {
		verification: value.verification as RunEvidence["verification"],
		checks: Math.trunc(value.checks),
	};
}

function parseRecord(value: unknown): RunRecord | undefined {
	if (!isRecord(value) || (value.version !== 1 && value.version !== 2)) return undefined;
	if (
		typeof value.startedAt !== "string" ||
		!validNumber(value.durationMs) ||
		!validNumber(value.turns) ||
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
		tools[name] = {
			calls: usage.calls,
			errors: usage.errors,
			...(usage.errorFingerprints ? { errorFingerprints: [...usage.errorFingerprints] } : {}),
		};
	}
	if (value.version === 1) {
		const digest = createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20);
		return {
			version: 2,
			id: `legacy-${digest}`,
			startedAt: value.startedAt,
			durationMs: value.durationMs,
			turns: Math.trunc(value.turns),
			retries: 0,
			taskKind: value.taskKind,
			outcome: value.outcome as RunOutcome,
			tools,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
			evidence: {
				verification:
					value.taskKind === "read_only"
						? "not_needed"
						: value.outcome === "verified"
							? "passed"
							: value.outcome === "failed"
								? "failed"
								: "missing",
				checks: 0,
			},
		};
	}
	const usage = parseRunUsage(value.usage);
	const evidence = parseEvidence(value.evidence);
	if (
		typeof value.id !== "string" ||
		value.id.length === 0 ||
		value.id.length > 100 ||
		!validNumber(value.retries) ||
		!usage ||
		!evidence
	) {
		return undefined;
	}
	return {
		version: 2,
		id: value.id,
		startedAt: value.startedAt,
		durationMs: value.durationMs,
		turns: Math.trunc(value.turns),
		retries: Math.trunc(value.retries),
		taskKind: value.taskKind,
		outcome: value.outcome as RunOutcome,
		tools,
		usage,
		evidence,
	};
}

function parseLines(content: string): RunRecord[] {
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

	async append(record: RunRecord): Promise<void> {
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

	async read(limit = ROTATED_RECORDS): Promise<RunRecord[]> {
		try {
			return parseLines(await readFile(this.filePath, "utf8")).slice(-Math.max(1, Math.min(limit, ROTATED_RECORDS)));
		} catch (error) {
			if (isRecord(error) && error.code === "ENOENT") return [];
			throw error;
		}
	}
}
