import type { ChildProcess } from "node:child_process";
import { spawnProcess, waitForChildProcess } from "../../utils/child-process.ts";
import { getShellEnv, killProcessTree } from "../../utils/shell.ts";
import type { VerifyCommandResult, VerifyCommandRunner } from "./types.ts";

const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

function appendChunk(current: string, chunk: Buffer): { text: string; truncated: boolean } {
	const remaining = MAX_CAPTURE_BYTES - Buffer.byteLength(current);
	if (remaining <= 0) return { text: current, truncated: true };
	if (chunk.byteLength <= remaining) return { text: current + chunk.toString("utf8"), truncated: false };
	return { text: current + chunk.subarray(0, remaining).toString("utf8"), truncated: true };
}

function stopProcess(child: ChildProcess): void {
	if (child.pid) killProcessTree(child.pid);
	else if (!child.killed) child.kill();
}

export const runVerifyCommand: VerifyCommandRunner = async (command, signal, timeoutMs) =>
	new Promise((resolve) => {
		if (signal.aborted) {
			resolve({ kind: "aborted", output: "", outputTruncated: false });
			return;
		}
		const startedAt = Date.now();
		const child = spawnProcess(command.command, command.args, {
			cwd: command.cwd,
			detached: process.platform !== "win32",
			env: { ...getShellEnv(), CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let output = "";
		let outputTruncated = false;
		let settled = false;
		let timedOut = false;
		let aborted = false;
		const onAbort = () => {
			aborted = true;
			stopProcess(child);
		};
		const finish = (result: VerifyCommandResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			signal.removeEventListener("abort", onAbort);
			resolve({
				...result,
				output: output || result.output,
				outputTruncated: outputTruncated || result.outputTruncated,
				durationMs: Date.now() - startedAt,
			});
		};
		const timeout = setTimeout(() => {
			timedOut = true;
			stopProcess(child);
		}, timeoutMs);
		signal.addEventListener("abort", onAbort, { once: true });
		const onData = (chunk: Buffer) => {
			const appended = appendChunk(output, chunk);
			output = appended.text;
			outputTruncated ||= appended.truncated;
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.once("error", (error: NodeJS.ErrnoException) => {
			finish({
				kind: error.code === "ENOENT" ? "not_found" : "exited",
				code: 1,
				output: error.message,
				outputTruncated: false,
			});
		});
		void waitForChildProcess(child).then(
			(code) => {
				if (aborted) finish({ kind: "aborted", output: "", outputTruncated: false });
				else if (timedOut) finish({ kind: "timed_out", output: "", outputTruncated: false });
				else finish({ kind: "exited", code: code ?? 1, output: "", outputTruncated: false });
			},
			(error: Error) => finish({ kind: "exited", code: 1, output: error.message, outputTruncated: false }),
		);
	});

export function commandDisplay(command: string, args: readonly string[]): string {
	return [command, ...args].map((part) => (/^[\w@./:\\=-]+$/.test(part) ? part : JSON.stringify(part))).join(" ");
}
