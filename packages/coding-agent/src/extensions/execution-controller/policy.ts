const MAX_TRACKED_PATHS = 16;
const MAX_REMINDERS = 2;

const CODE_SUFFIXES = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py", ".pyi", ".go"] as const;

const BUILD_CONFIG_NAMES = new Set([
	"biome.json",
	"biome.jsonc",
	"deno.json",
	"deno.jsonc",
	"go.mod",
	"go.sum",
	"jsconfig.json",
	"package.json",
	"pyproject.toml",
	"setup.cfg",
	"setup.py",
	"tsconfig.json",
]);

const MUTATING_TOOLS = new Set(["edit", "write", "ast_edit"]);

export type VerificationOutcome = "passed" | "failed" | "waived";
export type ReminderReason = "missing" | "failed";

export interface ObservedToolResult {
	toolName: string;
	input: Readonly<Record<string, unknown>>;
	details: unknown;
	isError: boolean;
	/** Optional rendered result blocks; consumers must not persist their raw content. */
	content?: readonly unknown[];
}

export interface ExecutionPolicySnapshot {
	revision: number;
	verifiedRevision: number;
	waivedRevision: number;
	verificationAttempts: number;
	reminderCount: number;
	changedPaths: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function changedFiles(details: unknown): string[] {
	if (!isRecord(details) || !Array.isArray(details.changedFiles)) return [];
	return details.changedFiles.filter((value): value is string => typeof value === "string" && value.length > 0);
}

export function needsCodeVerification(filePath: string): boolean {
	const normalized = filePath.replaceAll("\\", "/").toLowerCase();
	const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
	if (CODE_SUFFIXES.some((suffix) => basename.endsWith(suffix))) return true;
	if (BUILD_CONFIG_NAMES.has(basename)) return true;
	return (
		basename.startsWith("tsconfig.") ||
		basename.startsWith("vitest.config.") ||
		basename.startsWith("vite.config.") ||
		basename.startsWith("eslint.config.") ||
		basename.startsWith("requirements")
	);
}

export function mutationPaths(event: ObservedToolResult): string[] {
	if (event.isError) return [];
	if (MUTATING_TOOLS.has(event.toolName)) {
		const paths = changedFiles(event.details);
		const inputPath = stringValue(event.input, "path") ?? stringValue(event.input, "filePath");
		if (paths.length === 0 && inputPath) paths.push(inputPath);
		return paths.filter(needsCodeVerification).slice(0, MAX_TRACKED_PATHS);
	}
	if (event.toolName !== "lsp" || event.input.operation !== "rename") return [];
	const paths = changedFiles(event.details);
	const inputPath = stringValue(event.input, "path");
	if (paths.length === 0 && inputPath) paths.push(inputPath);
	return paths.filter(needsCodeVerification).slice(0, MAX_TRACKED_PATHS);
}

export function verificationOutcome(event: ObservedToolResult): VerificationOutcome | undefined {
	if (event.toolName === "verify") {
		if (event.isError || !isRecord(event.details)) return "waived";
		if (event.details.passed === true) return "passed";
		if (!Array.isArray(event.details.checks)) return "failed";
		const statuses = event.details.checks.flatMap((check) =>
			isRecord(check) && typeof check.status === "string" ? [check.status] : [],
		);
		return statuses.length > 0 && statuses.every((status) => status === "unavailable" || status === "timed_out")
			? "waived"
			: "failed";
	}
	if (event.toolName !== "lsp" || event.input.operation !== "diagnostics") return undefined;
	if (event.isError || !isRecord(event.details)) return "waived";
	return event.details.resultCount === 0 ? "passed" : "failed";
}

export class ExecutionPolicy {
	private revision = 0;
	private verifiedRevision = 0;
	private waivedRevision = 0;
	private verificationAttempts = 0;
	private reminderCount = 0;
	private reminderSignature: string | undefined;
	private changedPaths: string[] = [];
	private lastVerification: VerificationOutcome | undefined;

	reset(): void {
		this.revision = 0;
		this.verifiedRevision = 0;
		this.waivedRevision = 0;
		this.verificationAttempts = 0;
		this.reminderCount = 0;
		this.reminderSignature = undefined;
		this.changedPaths = [];
		this.lastVerification = undefined;
	}

	recordToolResult(event: ObservedToolResult): void {
		const paths = mutationPaths(event);
		if (paths.length > 0) {
			this.revision++;
			this.changedPaths = [...new Set([...this.changedPaths, ...paths])].slice(-MAX_TRACKED_PATHS);
			this.lastVerification = undefined;
		}

		const outcome = verificationOutcome(event);
		if (outcome === undefined || this.revision === 0) return;
		this.verificationAttempts++;
		this.lastVerification = outcome;
		if (outcome === "passed") this.verifiedRevision = this.revision;
		if (outcome === "waived") this.waivedRevision = this.revision;
	}

	takeReminder(): ReminderReason | undefined {
		if (this.revision === 0 || this.verifiedRevision === this.revision || this.waivedRevision === this.revision) {
			return undefined;
		}
		if (this.reminderCount >= MAX_REMINDERS) return undefined;
		const reason: ReminderReason = this.lastVerification === "failed" ? "failed" : "missing";
		const signature = `${this.revision}:${this.verificationAttempts}:${reason}`;
		if (signature === this.reminderSignature) return undefined;
		this.reminderSignature = signature;
		this.reminderCount++;
		return reason;
	}

	snapshot(): ExecutionPolicySnapshot {
		return {
			revision: this.revision,
			verifiedRevision: this.verifiedRevision,
			waivedRevision: this.waivedRevision,
			verificationAttempts: this.verificationAttempts,
			reminderCount: this.reminderCount,
			changedPaths: [...this.changedPaths],
		};
	}
}
