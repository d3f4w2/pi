import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens } from "../../core/compaction/compaction.ts";
import type { ReadonlySessionManager } from "../../core/session-manager.ts";
import type {
	ContextPreviewGuard,
	ContextRuntimeSnapshot,
	ContextStorageGuard,
	ContextWorkspaceSnapshot,
} from "./types.ts";

function canonicalValue(value: unknown, ancestors: Set<object>): string {
	if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
	if (typeof value === "bigint") return JSON.stringify(value.toString());
	if (value === undefined || typeof value === "function" || typeof value === "symbol") return "null";
	if (Array.isArray(value)) {
		if (ancestors.has(value)) return JSON.stringify("[circular]");
		ancestors.add(value);
		const serialized = `[${value.map((item) => canonicalValue(item, ancestors)).join(",")}]`;
		ancestors.delete(value);
		return serialized;
	}
	if (ancestors.has(value)) return JSON.stringify("[circular]");
	ancestors.add(value);
	const record = value as Record<string, unknown>;
	const serialized = `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key], ancestors)}`)
		.join(",")}}`;
	ancestors.delete(value);
	return serialized;
}

export function contextDigest(value: unknown): string {
	return createHash("sha256").update(canonicalValue(value, new Set())).digest("hex");
}

function gitOutput(cwd: string, args: string[]): string | undefined {
	const result = spawnSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		timeout: 2_000,
		windowsHide: true,
		maxBuffer: 2 * 1024 * 1024,
	});
	return result.status === 0 && typeof result.stdout === "string" ? result.stdout : undefined;
}

function isConflictStatus(status: string): boolean {
	return ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(status);
}

export async function captureWorkspaceSnapshot(cwd: string): Promise<ContextWorkspaceSnapshot> {
	const rawStatus = gitOutput(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
	const branchOutput = gitOutput(cwd, ["branch", "--show-current"]);
	if (rawStatus === undefined) {
		return {
			available: false,
			staged: 0,
			modified: 0,
			untracked: 0,
			conflicts: 0,
			paths: [],
			statusDigest: contextDigest({ available: false }),
			summary: "Git workspace unavailable",
		};
	}

	let staged = 0;
	let modified = 0;
	let untracked = 0;
	let conflicts = 0;
	const paths: string[] = [];
	const fields = rawStatus.split("\0").filter((field) => field.length > 0);
	for (let index = 0; index < fields.length; index++) {
		const field = fields[index];
		const status = field.slice(0, 2);
		if (status === "??") untracked++;
		else {
			if (status[0] !== " ") staged++;
			if (status[1] !== " ") modified++;
			if (isConflictStatus(status)) conflicts++;
		}
		const path = field.slice(3);
		if (paths.length < 20 && path) paths.push(path);
		if ((status[0] === "R" || status[0] === "C") && fields[index + 1] !== undefined) index++;
	}
	const branch = branchOutput?.trim() || undefined;
	const changed = new Set(paths).size;
	return {
		available: true,
		branch,
		staged,
		modified,
		untracked,
		conflicts,
		paths,
		statusDigest: contextDigest({ rawStatus, branch }),
		summary: `${changed} listed paths; staged ${staged}, modified ${modified}, untracked ${untracked}, conflicts ${conflicts}`,
	};
}

function captureStorageGuard(sessionFile: string | undefined): ContextStorageGuard | undefined {
	if (!sessionFile || !existsSync(sessionFile)) return undefined;
	const before = statSync(sessionFile);
	const content = readFileSync(sessionFile);
	const after = statSync(sessionFile);
	if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
		throw new Error("Session file changed while its rewind guard was being captured");
	}
	return {
		path: sessionFile,
		size: after.size,
		modifiedMs: after.mtimeMs,
		sha256: createHash("sha256").update(content).digest("hex"),
	};
}

export async function capturePreviewGuard(
	sessionManager: ReadonlySessionManager,
	runtime: ContextRuntimeSnapshot,
	workspace: ContextWorkspaceSnapshot,
): Promise<ContextPreviewGuard> {
	return {
		sessionId: sessionManager.getSessionId(),
		leafId: sessionManager.getLeafId(),
		entryCount: sessionManager.getEntries().length,
		branchDigest: contextDigest(sessionManager.getBranch()),
		storage: captureStorageGuard(sessionManager.getSessionFile()),
		workspaceDigest: workspace.statusDigest,
		runtimeDigest: contextDigest(runtime),
	};
}

export function guardsEqual(expected: ContextPreviewGuard, actual: ContextPreviewGuard): boolean {
	return contextDigest(expected) === contextDigest(actual);
}

export function summarizeContext(messages: readonly AgentMessage[]): string {
	const roles = new Map<string, number>();
	let toolCalls = 0;
	for (const message of messages) {
		roles.set(message.role, (roles.get(message.role) ?? 0) + 1);
		if (message.role === "assistant") {
			toolCalls += message.content.filter((content) => content.type === "toolCall").length;
		}
	}
	const roleSummary = [...roles.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([role, count]) => `${role}:${count}`)
		.join(", ");
	return `${messages.length} active messages (${roleSummary || "empty"}), ${toolCalls} tool calls, ${messages.reduce((sum, message) => sum + estimateTokens(message), 0)} estimated tokens`;
}
