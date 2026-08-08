import type { ChildProcess } from "node:child_process";
import { stripAnsi } from "../../utils/ansi.ts";
import { spawnProcess } from "../../utils/child-process.ts";
import type {
	MgrepErrorKind,
	MgrepOperations,
	MgrepSearchOptions,
	MgrepWatchHandle,
	MgrepWatchOptions,
} from "./types.ts";

const MAX_CAPTURE_BYTES = 512 * 1024;
const COMMAND_TIMEOUT_MS = 2 * 60 * 1000;
const SEARCH_TIMEOUT_MS = 15 * 1000;
const READY_PATTERN = /Initial sync complete/i;
const LOGIN_PATTERN = /not logged in|would you like to login|device authorization required/i;
const DEFAULT_MAX_FILE_COUNT = 5000;
const FILE_LIMIT_PATTERN = /Files to sync \((\d+)\) exceeds the maximum allowed \((\d+)\)/i;

export function resolveMgrepMaxFileCount(value = process.env.MGREP_MAX_FILE_COUNT): number {
	if (value === undefined) return DEFAULT_MAX_FILE_COUNT;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_FILE_COUNT;
}

export class MgrepProcessError extends Error {
	readonly kind: MgrepErrorKind;
	readonly fileCount: number | undefined;
	readonly maxFileCount: number | undefined;

	constructor(kind: MgrepErrorKind, message: string) {
		super(message);
		this.name = "MgrepProcessError";
		this.kind = kind;
		const fileLimit = kind === "file-limit" ? FILE_LIMIT_PATTERN.exec(message) : null;
		this.fileCount = fileLimit?.[1] === undefined ? undefined : Number(fileLimit[1]);
		this.maxFileCount = fileLimit?.[2] === undefined ? undefined : Number(fileLimit[2]);
	}
}

export function cleanMgrepOutput(value: string): string {
	return stripAnsi(value)
		.replace(/\r\n?/g, "\n")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function isMgrepWatchReady(output: string): boolean {
	return READY_PATTERN.test(cleanMgrepOutput(output));
}

function classifyFailure(message: string, error?: Error): MgrepProcessError {
	const code = error && "code" in error ? String(error.code) : "";
	const normalized = message.toLowerCase();
	if (code === "ENOENT" || normalized.includes("enoent") || normalized.includes("not recognized")) {
		return new MgrepProcessError("not-installed", message);
	}
	if (LOGIN_PATTERN.test(message)) return new MgrepProcessError("login-required", message);
	if (normalized.includes("quota") || normalized.includes("monthly limit")) {
		return new MgrepProcessError("quota", message);
	}
	if (normalized.includes("maximum allowed") || normalized.includes("max-file-count")) {
		return new MgrepProcessError("file-limit", message);
	}
	return new MgrepProcessError("failed", message || "mgrep exited without an error message");
}

function conciseFailure(message: string): string {
	const cleaned = cleanMgrepOutput(message).replace(/\s+/g, " ");
	return cleaned.length <= 400 ? cleaned : `${cleaned.slice(0, 399)}…`;
}

export function formatMgrepError(error: unknown): string {
	if (!(error instanceof MgrepProcessError)) {
		const message = error instanceof Error ? error.message : String(error);
		return `代码搜索失败：${conciseFailure(message)}`;
	}
	switch (error.kind) {
		case "not-installed":
			return [
				"首次使用需要准备 mgrep，通常需要 1–2 分钟：",
				"1. npm install -g @mixedbread/mgrep",
				"2. mgrep login",
				"浏览器登录完成后，再试一次代码搜索。",
			].join("\n");
		case "login-required":
			return "mgrep 尚未登录。请在 PowerShell 运行 `mgrep login`，通常需要 1–2 分钟；浏览器登录完成后再试。";
		case "quota":
			return "Mixedbread 本月免费额度已用完。请在 Mixedbread 平台查看用量或升级后再试。";
		case "file-limit":
			if (error.message.startsWith("code_search 已停止：")) return error.message;
			return "code_search 已停止：索引文件超过安全上限。本次没有上传文件。请指定更小的 path，或改用内置 grep；不要通过 bash 运行 rg。";
		case "warming":
			return "语义索引仍在后台准备，本次跳过 code_search。请立即使用内置 grep 继续任务，不要等待或立即重试。";
		case "cancelled":
			return "代码搜索已取消。";
		case "timeout":
			return "mgrep 搜索超过 15 秒，本次已停止。请立即使用内置 grep 继续任务，不要等待或立即重试。";
		case "failed":
			return `mgrep 运行失败：${conciseFailure(error.message)}`;
	}
}

function mgrepEnvironment(): NodeJS.ProcessEnv {
	return { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
}

function stopChild(child: ChildProcess): void {
	if (!child.killed) child.kill();
}

async function runMgrep(
	args: string[],
	cwd: string,
	signal?: AbortSignal,
	timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<string> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new MgrepProcessError("cancelled", "Operation aborted"));
			return;
		}
		const child = spawnProcess("mgrep", args, {
			cwd,
			env: mgrepEnvironment(),
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		let capturedBytes = 0;
		let settled = false;
		const timeout = setTimeout(() => {
			stopChild(child);
			finish(() => reject(new MgrepProcessError("timeout", "mgrep command timed out")));
		}, timeoutMs);

		const cleanup = (): void => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
		};
		const finish = (action: () => void): void => {
			if (settled) return;
			settled = true;
			cleanup();
			action();
		};
		const append = (target: "stdout" | "stderr", chunk: Buffer | string): void => {
			const text = chunk.toString();
			capturedBytes += Buffer.byteLength(text, "utf8");
			if (capturedBytes > MAX_CAPTURE_BYTES) {
				stopChild(child);
				finish(() => reject(new MgrepProcessError("failed", "mgrep output exceeded 512 KB")));
				return;
			}
			if (target === "stdout") stdout += text;
			else stderr += text;
		};
		const onAbort = (): void => {
			stopChild(child);
			finish(() => reject(new MgrepProcessError("cancelled", "Operation aborted")));
		};

		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout?.on("data", (chunk: Buffer | string) => append("stdout", chunk));
		child.stderr?.on("data", (chunk: Buffer | string) => append("stderr", chunk));
		child.once("error", (error) => finish(() => reject(classifyFailure(error.message, error))));
		child.once("close", (code) => {
			if (settled) return;
			const output = cleanMgrepOutput(stdout);
			const errors = cleanMgrepOutput(stderr);
			if (code === 0) finish(() => resolve(output || errors));
			else finish(() => reject(classifyFailure(errors || output || `mgrep exited with code ${code}`)));
		});
	});
}

function startMgrepWatch(options: MgrepWatchOptions, onOutput: (output: string) => void): MgrepWatchHandle {
	const child = spawnProcess("mgrep", ["watch", "--max-file-count", String(options.maxFileCount)], {
		cwd: options.cwd,
		env: mgrepEnvironment(),
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	let running = true;
	let settled = false;
	let rawOutput = "";
	let resolveReady: () => void = () => {};
	let rejectReady: (error: Error) => void = () => {};
	const ready = new Promise<void>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});

	const succeed = (): void => {
		if (settled) return;
		settled = true;
		resolveReady();
	};
	const fail = (error: MgrepProcessError): void => {
		if (settled) return;
		settled = true;
		stopChild(child);
		rejectReady(error);
	};
	const handleOutput = (chunk: Buffer | string): void => {
		const rawChunk = chunk.toString();
		const output = cleanMgrepOutput(rawChunk);
		if (!output) return;
		rawOutput = `${rawOutput}${rawChunk}`.slice(-MAX_CAPTURE_BYTES);
		const combinedOutput = cleanMgrepOutput(rawOutput);
		onOutput(output);
		if (LOGIN_PATTERN.test(combinedOutput)) fail(new MgrepProcessError("login-required", combinedOutput));
		else if (isMgrepWatchReady(combinedOutput)) succeed();
	};

	child.stdout?.on("data", handleOutput);
	child.stderr?.on("data", handleOutput);
	child.once("error", (error) => {
		running = false;
		fail(classifyFailure(error.message, error));
	});
	child.once("exit", (code) => {
		running = false;
		if (!settled) fail(classifyFailure(cleanMgrepOutput(rawOutput) || `mgrep watch exited with code ${code}`));
	});

	return {
		ready,
		isRunning: () => running,
		stop: () => {
			running = false;
			stopChild(child);
			if (!settled) {
				settled = true;
				rejectReady(new MgrepProcessError("cancelled", "mgrep watcher stopped"));
			}
		},
	};
}

export const defaultMgrepOperations: MgrepOperations = {
	maxFileCount: resolveMgrepMaxFileCount(),
	startWatch: startMgrepWatch,
	search: async (options: MgrepSearchOptions) =>
		runMgrep(
			["search", "--content", "--max-count", String(options.maxResults), "--", options.query, options.path],
			options.cwd,
			options.signal,
			SEARCH_TIMEOUT_MS,
		),
};
