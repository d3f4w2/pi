import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { spawnProcess, waitForChildProcess } from "../../utils/child-process.ts";
import { getShellEnv, killProcessTree, sanitizeBinaryOutput } from "../../utils/shell.ts";
import type { LanguageAdapter, LspToolResult } from "./types.ts";

const require = createRequire(import.meta.url);
let bundledTscPath: string | undefined;
try {
	bundledTscPath = require.resolve("typescript/bin/tsc");
} catch {
	// Standalone binaries may rely on a project-local or PATH tsc instead.
}
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESULTS = 50;
const MAX_RESULTS = 100;
const MAX_CAPTURE_BYTES = 256 * 1024;
const MAX_LINE_LENGTH = 1_000;

export interface WorkspaceCommandResult {
	kind: "exited" | "not_found" | "timed_out" | "aborted";
	code?: number;
	stdout: string;
	stderr: string;
	outputTruncated?: boolean;
}

export type WorkspaceCommandRunner = (
	command: string,
	args: string[],
	cwd: string,
	signal: AbortSignal | undefined,
	timeoutMs: number,
) => Promise<WorkspaceCommandResult>;

export interface WorkspaceDiagnosticsOptions {
	runner?: WorkspaceCommandRunner;
	maxResults?: number;
	timeoutMs?: number;
}

interface WorkspaceCommand {
	language: LanguageAdapter["id"];
	label: string;
	command: string;
	args: string[];
	fallbackCommands?: Array<{ command: string; args: string[] }>;
	missingHint: string;
	goWorkspace?: boolean;
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function appendChunk(current: string, chunk: Buffer): { text: string; truncated: boolean } {
	const remaining = MAX_CAPTURE_BYTES - Buffer.byteLength(current);
	if (remaining <= 0) return { text: current, truncated: true };
	if (chunk.byteLength <= remaining) return { text: current + chunk.toString("utf8"), truncated: false };
	return { text: current + chunk.subarray(0, remaining).toString("utf8"), truncated: true };
}

const defaultRunner: WorkspaceCommandRunner = async (command, args, cwd, signal, timeoutMs) =>
	new Promise((resolve) => {
		if (signal?.aborted) {
			resolve({ kind: "aborted", stdout: "", stderr: "" });
			return;
		}
		const child = spawnProcess(command, args, {
			cwd,
			detached: process.platform !== "win32",
			env: getShellEnv(),
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		let outputTruncated = false;
		let settled = false;
		let timedOut = false;
		let aborted = false;
		const stop = () => {
			if (child.pid) killProcessTree(child.pid);
			else if (!child.killed) child.kill();
		};
		const onAbort = () => {
			aborted = true;
			stop();
		};
		const finish = (result: WorkspaceCommandResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			resolve({
				...result,
				stdout: stdout || result.stdout,
				stderr: stderr || result.stderr,
				...(outputTruncated ? { outputTruncated: true } : {}),
			});
		};
		const timeout = setTimeout(() => {
			timedOut = true;
			stop();
		}, timeoutMs);
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (chunk: Buffer) => {
			const appended = appendChunk(stdout, chunk);
			stdout = appended.text;
			outputTruncated ||= appended.truncated;
		});
		child.stderr.on("data", (chunk: Buffer) => {
			const appended = appendChunk(stderr, chunk);
			stderr = appended.text;
			outputTruncated ||= appended.truncated;
		});
		child.once("error", (error: NodeJS.ErrnoException) => {
			finish({
				kind: error.code === "ENOENT" ? "not_found" : "exited",
				code: 1,
				stdout: "",
				stderr: error.message,
			});
		});
		void waitForChildProcess(child).then(
			(code) => {
				if (aborted) finish({ kind: "aborted", stdout: "", stderr: "" });
				else if (timedOut) finish({ kind: "timed_out", stdout: "", stderr: "" });
				else finish({ kind: "exited", code: code ?? 1, stdout: "", stderr: "" });
			},
			(error: Error) => finish({ kind: "exited", code: 1, stdout: "", stderr: error.message }),
		);
	});

async function detectWorkspaceCommand(projectRoot: string): Promise<WorkspaceCommand | undefined> {
	if (
		(await fileExists(path.join(projectRoot, "tsconfig.json"))) ||
		(await fileExists(path.join(projectRoot, "jsconfig.json")))
	) {
		const localTscPath = path.join(projectRoot, "node_modules", "typescript", "bin", "tsc");
		const tscPath = (await fileExists(localTscPath)) ? localTscPath : bundledTscPath;
		return {
			language: "typescript",
			label: "TypeScript (tsc --noEmit)",
			command: tscPath ? process.execPath : "tsc",
			args: [...(tscPath ? [tscPath] : []), "--noEmit", "--pretty", "false"],
			missingHint: "没有找到 TypeScript 检查器。请先安装项目依赖。",
		};
	}
	const hasGoWorkspace = await fileExists(path.join(projectRoot, "go.work"));
	if (hasGoWorkspace || (await fileExists(path.join(projectRoot, "go.mod")))) {
		return {
			language: "go",
			label: "Go (go build ./...)",
			command: "go",
			args: ["build", "./..."],
			missingHint: "没有找到 go 命令。请先安装 Go，并确认 go 已加入 PATH。",
			...(hasGoWorkspace ? { goWorkspace: true } : {}),
		};
	}
	if (
		(await fileExists(path.join(projectRoot, "pyproject.toml"))) ||
		(await fileExists(path.join(projectRoot, "requirements.txt"))) ||
		(await fileExists(path.join(projectRoot, "setup.cfg"))) ||
		(await fileExists(path.join(projectRoot, "setup.py")))
	) {
		return {
			language: "python",
			label: "Python (basedpyright/pyright)",
			command: "basedpyright",
			args: [],
			fallbackCommands: [{ command: "pyright", args: [] }],
			missingHint: "没有找到 Python 检查器。请在项目环境运行：pip install basedpyright",
		};
	}
	return undefined;
}

function goWorkspaceBuildPatterns(projectRoot: string, output: string): string[] {
	try {
		const metadata: unknown = JSON.parse(output);
		if (typeof metadata !== "object" || metadata === null) return [];
		const uses = Reflect.get(metadata, "Use");
		if (!Array.isArray(uses)) return [];
		return uses.flatMap((entry): string[] => {
			if (typeof entry !== "object" || entry === null) return [];
			const diskPath = Reflect.get(entry, "DiskPath");
			if (typeof diskPath !== "string" || !diskPath.trim()) return [];
			const relative = path.relative(projectRoot, path.resolve(projectRoot, diskPath));
			if (relative.startsWith("..") || path.isAbsolute(relative)) return [];
			const normalized = relative.replaceAll("\\", "/");
			return [normalized ? `./${normalized}/...` : "./..."];
		});
	} catch {
		return [];
	}
}

function resultDetails(
	projectRoot: string,
	language: LanguageAdapter["id"] | "unknown",
	resultCount: number,
	truncated: boolean,
): LspToolResult["details"] {
	return {
		operation: "diagnostics",
		language,
		workspaceRoot: projectRoot,
		truncated,
		resultCount,
	};
}

export async function runWorkspaceDiagnostics(
	cwd: string,
	signal?: AbortSignal,
	options: WorkspaceDiagnosticsOptions = {},
): Promise<LspToolResult> {
	const projectRoot = await realpath(cwd);
	const workspaceCommand = await detectWorkspaceCommand(projectRoot);
	if (!workspaceCommand) {
		return {
			text: "没有识别到可执行项目检查的配置。当前支持 tsconfig.json、jsconfig.json、go.mod、go.work 和常见 Python 项目标记。",
			details: resultDetails(projectRoot, "unknown", 0, false),
		};
	}

	const runner = options.runner ?? defaultRunner;
	const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	if (workspaceCommand.goWorkspace) {
		const metadata = await runner("go", ["work", "edit", "-json"], projectRoot, signal, timeoutMs);
		if (metadata.kind === "not_found") {
			return {
				text: workspaceCommand.missingHint,
				details: resultDetails(projectRoot, workspaceCommand.language, 0, false),
			};
		}
		if (metadata.kind === "aborted") throw new Error("项目检查已取消。");
		if (metadata.kind === "timed_out") {
			return {
				text: `读取 Go 工作区超过 ${timeoutMs}ms，已停止；任务可以继续。`,
				details: resultDetails(projectRoot, workspaceCommand.language, 0, false),
			};
		}
		if (metadata.code === 0) {
			const patterns = goWorkspaceBuildPatterns(projectRoot, metadata.stdout);
			if (patterns.length > 0) workspaceCommand.args = ["build", ...patterns];
		}
	}
	const commands = [
		{ command: workspaceCommand.command, args: workspaceCommand.args },
		...(workspaceCommand.fallbackCommands ?? []),
	];
	let commandResult: WorkspaceCommandResult | undefined;
	for (const command of commands) {
		commandResult = await runner(command.command, command.args, projectRoot, signal, timeoutMs);
		if (commandResult.kind !== "not_found") break;
	}
	if (!commandResult || commandResult.kind === "not_found") {
		return {
			text: workspaceCommand.missingHint,
			details: resultDetails(projectRoot, workspaceCommand.language, 0, false),
		};
	}
	if (commandResult.kind === "aborted") throw new Error("项目检查已取消。");
	if (commandResult.kind === "timed_out") {
		return {
			text: `项目检查超过 ${timeoutMs}ms，已停止；任务可以继续。`,
			details: resultDetails(projectRoot, workspaceCommand.language, 0, false),
		};
	}
	if (commandResult.code === 0) {
		return {
			text: `项目检查通过：${workspaceCommand.label}。`,
			details: resultDetails(projectRoot, workspaceCommand.language, 0, false),
		};
	}

	const output = sanitizeBinaryOutput([commandResult.stdout, commandResult.stderr].filter(Boolean).join("\n"));
	const lines = output
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter((line) => line.trim().length > 0);
	const maxResults = Math.min(MAX_RESULTS, Math.max(1, options.maxResults ?? DEFAULT_MAX_RESULTS));
	const shown = lines
		.slice(0, maxResults)
		.map((line) => (line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line));
	const truncated = commandResult.outputTruncated === true || lines.length > shown.length;
	const detail = shown.length > 0 ? shown.join("\n") : `检查命令退出码：${commandResult.code ?? 1}，没有错误详情。`;
	return {
		text: `项目检查发现问题：${workspaceCommand.label}\n${detail}${truncated ? "\n[输出已截断，请缩小检查范围后重试。]" : ""}`,
		details: resultDetails(projectRoot, workspaceCommand.language, lines.length, truncated),
	};
}
