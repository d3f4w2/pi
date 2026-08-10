import type { ChildProcessByStdio } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { spawnProcess } from "../../utils/child-process.ts";
import {
	getShellEnv,
	killProcessTree,
	sanitizeBinaryOutput,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
import type {
	BackgroundProcessService,
	ManagedProcessInfo,
	ManagedProcessSpec,
	ManagedProcessState,
	ProcessLogResult,
} from "./types.ts";

const MAX_RUNNING_PROCESSES = 8;
const MAX_RETAINED_PROCESSES = 32;
const MAX_RETAINED_LOG_BYTES = 256 * 1024;
const MAX_RETURNED_LOG_BYTES = 24 * 1024;
const LOG_CHUNK_CHARACTERS = 4_096;
const STARTUP_OBSERVATION_MS = 100;
const MAX_INPUT_BYTES = 64 * 1024;
const URL_PATTERN = /https?:\/\/[A-Za-z0-9\-._~%:[\]]+(?::\d+)?(?:\/[A-Za-z0-9\-._~%!$&'()*+,;=:@/?#]*)?/g;

interface LogEntry {
	cursor: number;
	text: string;
	bytes: number;
}

interface ManagedEntry {
	id: string;
	spec: ManagedProcessSpec;
	workspaceRoot: string;
	state: ManagedProcessState;
	startedAt: string;
	child?: ChildProcessByStdio<Writable, Readable, Readable>;
	exitCode?: number;
	exitSignal?: NodeJS.Signals;
	error?: string;
	urls: string[];
	logs: LogEntry[];
	logBytes: number;
	nextCursor: number;
	generation: number;
}

function isInside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function validText(value: string, label: string, maximum: number): string {
	const clean = value.trim();
	if (!clean) throw new Error(`${label}不能为空。`);
	if (clean.includes("\0")) throw new Error(`${label}不能包含空字符。`);
	if (clean.length > maximum) throw new Error(`${label}过长。`);
	return clean;
}

async function normalizeWorkingDirectory(workspaceRoot: string, requested: string): Promise<string> {
	const root = path.resolve(workspaceRoot);
	const cwd = path.resolve(root, requested);
	if (!isInside(root, cwd)) throw new Error(`工作目录不在当前项目中：${requested}`);
	try {
		if (!(await stat(cwd)).isDirectory()) throw new Error(`工作目录不是文件夹：${requested}`);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			throw new Error(`工作目录不存在：${requested}`);
		}
		throw error;
	}
	return cwd;
}

function processInfo(entry: ManagedEntry): ManagedProcessInfo {
	return {
		id: entry.id,
		label: entry.spec.label ?? path.basename(entry.spec.command),
		command: entry.spec.command,
		args: [...entry.spec.args],
		cwd: entry.spec.cwd,
		state: entry.state,
		startedAt: entry.startedAt,
		...(entry.state !== "running" || entry.child?.pid === undefined ? {} : { pid: entry.child.pid }),
		...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
		...(entry.exitSignal === undefined ? {} : { exitSignal: entry.exitSignal }),
		...(entry.error === undefined ? {} : { error: entry.error }),
		urls: [...entry.urls],
		logCursor: entry.nextCursor,
	};
}

async function stopChildProcess(child: NonNullable<ManagedEntry["child"]>): Promise<void> {
	if (child.exitCode !== null) return;
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	if (child.pid !== undefined) killProcessTree(child.pid);
	else if (!child.killed) child.kill();
	await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 3_000))]);
}

export class BackgroundProcessManager implements BackgroundProcessService {
	private readonly entries = new Map<string, ManagedEntry>();
	private nextId = 1;

	private entry(id: string): ManagedEntry {
		const entry = this.entries.get(id);
		if (!entry) throw new Error(`托管进程不存在：${id}`);
		return entry;
	}

	private append(entry: ManagedEntry, stream: "stdout" | "stderr" | "system", raw: string): void {
		const safe = sanitizeBinaryOutput(raw);
		if (!safe) return;
		for (const url of safe.match(URL_PATTERN) ?? []) {
			const normalized = url.replace(/[),.;]+$/, "");
			if (!entry.urls.includes(normalized) && entry.urls.length < 10) entry.urls.push(normalized);
		}
		const characters = Array.from(safe);
		for (let offset = 0; offset < characters.length; offset += LOG_CHUNK_CHARACTERS) {
			const body = characters.slice(offset, offset + LOG_CHUNK_CHARACTERS).join("");
			const text = `[${stream}] ${body}`;
			const logEntry = { cursor: entry.nextCursor++, text, bytes: Buffer.byteLength(text) };
			entry.logs.push(logEntry);
			entry.logBytes += logEntry.bytes;
		}
		while (entry.logBytes > MAX_RETAINED_LOG_BYTES && entry.logs.length > 0) {
			const removed = entry.logs.shift();
			if (removed) entry.logBytes -= removed.bytes;
		}
	}

	private trimHistory(): void {
		if (this.entries.size < MAX_RETAINED_PROCESSES) return;
		for (const [id, entry] of this.entries) {
			if (entry.state === "running") continue;
			this.entries.delete(id);
			if (this.entries.size < MAX_RETAINED_PROCESSES) return;
		}
	}

	private async launch(entry: ManagedEntry, signal?: AbortSignal): Promise<ManagedProcessInfo> {
		if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("进程启动已取消。");
		entry.state = "running";
		entry.startedAt = new Date().toISOString();
		entry.exitCode = undefined;
		entry.exitSignal = undefined;
		entry.error = undefined;
		const generation = ++entry.generation;
		this.append(entry, "system", `启动：${entry.spec.command} ${entry.spec.args.join(" ")}\n`);
		const spawned = spawnProcess(entry.spec.command, [...entry.spec.args], {
			cwd: entry.spec.cwd,
			env: getShellEnv(),
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		if (!spawned.stdin || !spawned.stdout || !spawned.stderr) {
			spawned.kill();
			throw new Error("托管进程没有提供完整的标准输入输出管道。");
		}
		const child = spawned as ChildProcessByStdio<Writable, Readable, Readable>;
		entry.child = child;
		if (child.pid !== undefined) trackDetachedChildPid(child.pid);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.append(entry, "stdout", chunk));
		child.stderr.on("data", (chunk: string) => this.append(entry, "stderr", chunk));
		child.once("error", (error: NodeJS.ErrnoException) => {
			if (entry.generation !== generation || entry.child !== child) return;
			entry.state = "failed";
			entry.error = error.code === "ENOENT" ? `没有找到可执行文件：${entry.spec.command}` : error.message;
			this.append(entry, "system", `${entry.error}\n`);
			if (child.pid !== undefined) untrackDetachedChildPid(child.pid);
		});
		child.once("exit", (code, exitSignal) => {
			if (entry.generation !== generation || entry.child !== child) {
				if (child.pid !== undefined) untrackDetachedChildPid(child.pid);
				return;
			}
			if (entry.state !== "stopped") entry.state = code === 0 ? "exited" : "failed";
			entry.exitCode = code ?? undefined;
			entry.exitSignal = exitSignal ?? undefined;
			this.append(entry, "system", `进程已退出：${exitSignal ?? code ?? "unknown"}\n`);
			if (child.pid !== undefined) untrackDetachedChildPid(child.pid);
		});
		await new Promise<void>((resolve) => setTimeout(resolve, STARTUP_OBSERVATION_MS));
		if (signal?.aborted) {
			await this.stop(entry.id);
			throw signal.reason instanceof Error ? signal.reason : new Error("进程启动已取消。");
		}
		if (entry.error) throw new Error(entry.error);
		return processInfo(entry);
	}

	async start(spec: ManagedProcessSpec, workspaceRoot: string, signal?: AbortSignal): Promise<ManagedProcessInfo> {
		if ([...this.entries.values()].filter((entry) => entry.state === "running").length >= MAX_RUNNING_PROCESSES) {
			throw new Error(`当前已有 ${MAX_RUNNING_PROCESSES} 个托管进程，请先停止不需要的进程。`);
		}
		if (spec.args.length > 100) throw new Error("进程参数不能超过 100 个。");
		const command = validText(spec.command, "可执行文件", 4_096);
		const args = spec.args.map((arg) => {
			if (arg.includes("\0")) throw new Error("进程参数不能包含空字符。");
			if (arg.length > 10_000) throw new Error("单个进程参数过长。");
			return arg;
		});
		const cwd = await normalizeWorkingDirectory(workspaceRoot, spec.cwd);
		const label = spec.label === undefined ? undefined : validText(spec.label, "进程名称", 100);
		this.trimHistory();
		const id = `proc-${this.nextId++}`;
		const entry: ManagedEntry = {
			id,
			spec: { command, args, cwd, ...(label === undefined ? {} : { label }) },
			workspaceRoot: path.resolve(workspaceRoot),
			state: "running",
			startedAt: new Date().toISOString(),
			urls: [],
			logs: [],
			logBytes: 0,
			nextCursor: 1,
			generation: 0,
		};
		this.entries.set(id, entry);
		return this.launch(entry, signal);
	}

	async status(id?: string): Promise<ManagedProcessInfo[]> {
		return id ? [processInfo(this.entry(id))] : [...this.entries.values()].map(processInfo);
	}

	async logs(id: string, cursor = 0): Promise<ProcessLogResult> {
		const entry = this.entry(id);
		const firstCursor = entry.logs[0]?.cursor ?? entry.nextCursor;
		let truncated = cursor < firstCursor && firstCursor > 1;
		const selected: string[] = [];
		let bytes = 0;
		let nextCursor = Math.max(cursor, firstCursor);
		for (const log of entry.logs) {
			if (log.cursor < Math.max(cursor, firstCursor)) continue;
			if (bytes + log.bytes > MAX_RETURNED_LOG_BYTES) {
				truncated = true;
				break;
			}
			selected.push(log.text);
			bytes += log.bytes;
			nextCursor = log.cursor + 1;
		}
		return {
			id,
			text: selected.join(""),
			nextCursor,
			truncated,
			state: entry.state,
		};
	}

	async input(id: string, data: string): Promise<ManagedProcessInfo> {
		const entry = this.entry(id);
		if (entry.state !== "running" || !entry.child || entry.child.stdin.destroyed) {
			throw new Error(`托管进程没有可写的标准输入：${id}`);
		}
		if (data.includes("\0")) throw new Error("进程输入不能包含空字符。");
		const bytes = Buffer.byteLength(data, "utf8");
		if (bytes > MAX_INPUT_BYTES) throw new Error(`进程输入过长，最多 ${MAX_INPUT_BYTES} 字节。`);
		await new Promise<void>((resolve, reject) => {
			entry.child?.stdin.write(data, "utf8", (error) => (error ? reject(error) : resolve()));
		});
		this.append(entry, "system", `已写入标准输入：${bytes} 字节。\n`);
		return processInfo(entry);
	}

	async restart(id: string, signal?: AbortSignal): Promise<ManagedProcessInfo> {
		const entry = this.entry(id);
		await this.stop(id);
		this.append(entry, "system", "正在重启。\n");
		return this.launch(entry, signal);
	}

	async stop(id: string): Promise<ManagedProcessInfo> {
		const entry = this.entry(id);
		const child = entry.child;
		if (entry.state === "running" && child) {
			entry.state = "stopped";
			entry.child = undefined;
			this.append(entry, "system", "正在停止。\n");
			await stopChildProcess(child);
			if (child.pid !== undefined) {
				untrackDetachedChildPid(child.pid);
			}
		}
		return processInfo(entry);
	}

	async stopAll(): Promise<void> {
		await Promise.all([...this.entries.keys()].map((id) => this.stop(id)));
	}
}
