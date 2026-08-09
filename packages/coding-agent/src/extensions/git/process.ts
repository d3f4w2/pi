import type { ChildProcess } from "node:child_process";
import { spawnProcess, waitForChildProcess } from "../../utils/child-process.ts";
import { getShellEnv, killProcessTree } from "../../utils/shell.ts";
import type { GitCommandResult, GitCommandRunner } from "./types.ts";

const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

function appendBounded(current: string, chunk: Buffer): { text: string; truncated: boolean } {
	const remaining = MAX_CAPTURE_BYTES - Buffer.byteLength(current);
	if (remaining <= 0) return { text: current, truncated: true };
	if (chunk.byteLength <= remaining) return { text: current + chunk.toString("utf8"), truncated: false };
	return { text: current + chunk.subarray(0, remaining).toString("utf8"), truncated: true };
}

function stopProcess(child: ChildProcess): void {
	if (child.pid) killProcessTree(child.pid);
	else if (!child.killed) child.kill();
}

export class DirectGitCommandRunner implements GitCommandRunner {
	async run(
		args: readonly string[],
		cwd: string,
		options: { signal?: AbortSignal; timeoutMs?: number } = {},
	): Promise<GitCommandResult> {
		return new Promise((resolve, reject) => {
			const startedAt = Date.now();
			const child = spawnProcess("git", [...args], {
				cwd,
				detached: process.platform !== "win32",
				env: {
					...getShellEnv(),
					GIT_PAGER: "cat",
					PAGER: "cat",
					GIT_TERMINAL_PROMPT: "0",
					LC_ALL: "C",
					NO_COLOR: "1",
				},
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			let stdout = "";
			let stderr = "";
			let truncated = false;
			let timedOut = false;
			let aborted = false;
			let settled = false;
			const signal = options.signal;
			const finish = (code: number): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				signal?.removeEventListener("abort", onAbort);
				resolve({
					code: aborted ? 130 : timedOut ? 124 : code,
					stdout,
					stderr: timedOut ? `${stderr}\nGit 操作超时。`.trim() : stderr,
					truncated,
					durationMs: Date.now() - startedAt,
				});
			};
			const onAbort = (): void => {
				aborted = true;
				stopProcess(child);
			};
			const timeout = setTimeout(() => {
				timedOut = true;
				stopProcess(child);
			}, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
			child.stdout.on("data", (chunk: Buffer) => {
				const appended = appendBounded(stdout, chunk);
				stdout = appended.text;
				truncated ||= appended.truncated;
			});
			child.stderr.on("data", (chunk: Buffer) => {
				const appended = appendBounded(stderr, chunk);
				stderr = appended.text;
				truncated ||= appended.truncated;
			});
			child.once("error", (error: NodeJS.ErrnoException) => {
				clearTimeout(timeout);
				signal?.removeEventListener("abort", onAbort);
				if (error.code === "ENOENT") reject(new Error("没有找到 Git。请先安装 Git，并确认 git 命令可用。"));
				else reject(error);
			});
			void waitForChildProcess(child).then((code) => finish(code ?? 1), reject);
		});
	}
}
