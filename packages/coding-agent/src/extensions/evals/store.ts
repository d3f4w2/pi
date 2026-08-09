import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
	EvalCaseMetrics,
	EvalCaseResult,
	EvalCategory,
	EvalReport,
	EvalReportStoreLike,
	EvalReportSummary,
} from "./types.ts";

const MAX_REPORT_BYTES = 2 * 1024 * 1024;
const MAX_REPORTS = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

const CATEGORIES = new Set<EvalCategory>([
	"navigation",
	"editing",
	"verification",
	"testing",
	"web",
	"process",
	"browser",
	"debugging",
	"fallback",
]);

function parseMetrics(value: unknown): EvalCaseMetrics | undefined {
	if (
		!isRecord(value) ||
		!validNumber(value.durationMs) ||
		!validNumber(value.totalTokens) ||
		!validNumber(value.toolCalls) ||
		!validNumber(value.toolErrors) ||
		!validNumber(value.retries)
	) {
		return undefined;
	}
	return {
		durationMs: value.durationMs,
		totalTokens: value.totalTokens,
		toolCalls: Math.trunc(value.toolCalls),
		toolErrors: Math.trunc(value.toolErrors),
		retries: Math.trunc(value.retries),
	};
}

function parseCaseResult(value: unknown): EvalCaseResult | undefined {
	if (
		!isRecord(value) ||
		typeof value.id !== "string" ||
		typeof value.title !== "string" ||
		typeof value.category !== "string" ||
		!CATEGORIES.has(value.category as EvalCategory) ||
		typeof value.passed !== "boolean" ||
		!Array.isArray(value.failures) ||
		!value.failures.every((failure) => typeof failure === "string")
	) {
		return undefined;
	}
	const metrics = parseMetrics(value.metrics);
	if (!metrics) return undefined;
	return {
		id: value.id,
		title: value.title,
		category: value.category as EvalCategory,
		passed: value.passed,
		failures: value.failures,
		metrics,
	};
}

function parseSummary(value: unknown): EvalReportSummary | undefined {
	const metrics = parseMetrics(value);
	if (
		!metrics ||
		!isRecord(value) ||
		!validNumber(value.total) ||
		!validNumber(value.passed) ||
		!validNumber(value.failed) ||
		!validNumber(value.successRate) ||
		value.successRate > 1 ||
		!validNumber(value.p50DurationMs) ||
		!validNumber(value.p95DurationMs)
	) {
		return undefined;
	}
	return {
		...metrics,
		total: Math.trunc(value.total),
		passed: Math.trunc(value.passed),
		failed: Math.trunc(value.failed),
		successRate: value.successRate,
		p50DurationMs: value.p50DurationMs,
		p95DurationMs: value.p95DurationMs,
	};
}

function parseReport(value: unknown): EvalReport | undefined {
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		typeof value.id !== "string" ||
		typeof value.createdAt !== "string" ||
		typeof value.suiteId !== "string" ||
		!isRecord(value.candidate) ||
		typeof value.candidate.label !== "string" ||
		typeof value.candidate.digest !== "string" ||
		!isRecord(value.environment) ||
		typeof value.environment.platform !== "string" ||
		typeof value.environment.arch !== "string" ||
		typeof value.environment.node !== "string" ||
		!Array.isArray(value.cases) ||
		!isRecord(value.summary)
	) {
		return undefined;
	}
	const cases = value.cases.map(parseCaseResult);
	const summary = parseSummary(value.summary);
	if (cases.some((result) => result === undefined) || !summary) return undefined;
	return {
		version: 1,
		id: value.id,
		createdAt: value.createdAt,
		suiteId: value.suiteId,
		candidate: { label: value.candidate.label, digest: value.candidate.digest },
		environment: {
			platform: value.environment.platform as NodeJS.Platform,
			arch: value.environment.arch,
			node: value.environment.node,
		},
		cases: cases as EvalCaseResult[],
		summary,
	};
}

function parseLines(content: string): EvalReport[] {
	return content.split(/\r?\n/).flatMap((line) => {
		if (!line.trim()) return [];
		try {
			const report = parseReport(JSON.parse(line));
			return report ? [report] : [];
		} catch {
			return [];
		}
	});
}

export class EvalReportStore implements EvalReportStoreLike {
	private readonly directory: string;
	private readonly reportPath: string;
	private readonly baselinePath: string;

	constructor(directory: string) {
		this.directory = directory;
		this.reportPath = path.join(directory, "reports.jsonl");
		this.baselinePath = path.join(directory, "baseline.json");
	}

	async append(report: EvalReport): Promise<void> {
		await mkdir(this.directory, { recursive: true });
		try {
			if ((await stat(this.reportPath)).size > MAX_REPORT_BYTES) {
				const reports = parseLines(await readFile(this.reportPath, "utf8")).slice(-MAX_REPORTS);
				await writeFile(this.reportPath, `${reports.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
			}
		} catch (error) {
			if (!isRecord(error) || error.code !== "ENOENT") throw error;
		}
		await appendFile(this.reportPath, `${JSON.stringify(report)}\n`, "utf8");
	}

	async read(limit = MAX_REPORTS): Promise<EvalReport[]> {
		try {
			return parseLines(await readFile(this.reportPath, "utf8")).slice(-Math.max(1, Math.min(limit, MAX_REPORTS)));
		} catch (error) {
			if (isRecord(error) && error.code === "ENOENT") return [];
			throw error;
		}
	}

	async saveBaseline(report: EvalReport): Promise<void> {
		await mkdir(this.directory, { recursive: true });
		const temporaryPath = path.join(this.directory, `.baseline-${process.pid}-${Date.now()}.tmp`);
		try {
			await writeFile(temporaryPath, `${JSON.stringify(report)}\n`, "utf8");
			await rename(temporaryPath, this.baselinePath);
		} catch (error) {
			await rm(temporaryPath, { force: true });
			throw error;
		}
	}

	async readBaseline(): Promise<EvalReport | undefined> {
		try {
			return parseReport(JSON.parse(await readFile(this.baselinePath, "utf8")));
		} catch (error) {
			if (isRecord(error) && error.code === "ENOENT") return undefined;
			if (error instanceof SyntaxError) return undefined;
			throw error;
		}
	}
}
