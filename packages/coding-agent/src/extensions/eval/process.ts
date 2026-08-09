import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { EvalExecutionResult, EvalLanguage, EvalRuntimeService, EvalWorkerResponse } from "./types.ts";
import { BUN_WORKER, PYTHON_WORKER, WORKER_PREFIX } from "./workers.ts";

const MAX_OUTPUT_BYTES = 32 * 1024;
const STARTUP_TIMEOUT_MS = 5_000;
const SENSITIVE_ENVIRONMENT = /(api.?key|token|secret|password|credential|authorization|auth$)/i;

interface WorkerCandidate {
	command: string;
	args: string[];
}

interface PendingRequest {
	resolve(response: EvalWorkerResponse): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

export interface EvalWorkerLike {
	execute(code: string, timeoutMs: number, signal?: AbortSignal): Promise<EvalWorkerResponse>;
	stop(): Promise<void>;
	isRunning(): boolean;
}

export type EvalWorkerFactory = (language: EvalLanguage, cwd: string) => EvalWorkerLike;

export function sanitizedEvalEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(environment).filter(([name]) => !SENSITIVE_ENVIRONMENT.test(name)));
}

export function bunExecutableCandidates(
	environment: NodeJS.ProcessEnv,
	platform: NodeJS.Platform = process.platform,
	userHome = homedir(),
	fileExists: (candidate: string) => boolean = existsSync,
): string[] {
	const configured = environment.PI_BUN?.trim();
	const windowsExecutables =
		platform === "win32"
			? [
					...(environment.BUN_INSTALL ? [path.join(environment.BUN_INSTALL, "bin", "bun.exe")] : []),
					path.join(userHome, ".bun", "bin", "bun.exe"),
					...(environment.APPDATA
						? [path.join(environment.APPDATA, "npm", "node_modules", "bun", "bin", "bun.exe")]
						: []),
				].filter(fileExists)
			: [];
	return [...new Set([...(configured ? [configured] : []), ...windowsExecutables, "bun.exe", "bun"])];
}

function executableCandidates(language: EvalLanguage): WorkerCandidate[] {
	if (language === "python") {
		const configured = process.env.PI_PYTHON?.trim();
		return [
			...(configured ? [{ command: configured, args: ["-u", "-c", PYTHON_WORKER] }] : []),
			{ command: "python", args: ["-u", "-c", PYTHON_WORKER] },
			{ command: "python3", args: ["-u", "-c", PYTHON_WORKER] },
			...(process.platform === "win32" ? [{ command: "py", args: ["-3", "-u", "-c", PYTHON_WORKER] }] : []),
		];
	}
	return bunExecutableCandidates(process.env).map((command) => ({ command, args: ["--eval", BUN_WORKER] }));
}

function conciseProcessError(language: EvalLanguage, errors: readonly string[]): Error {
	const hint =
		language === "python"
			? "没有找到可用的 Python。请安装 Python，或设置 PI_PYTHON。"
			: "没有找到可用的 Bun。请安装 Bun，或设置 PI_BUN。";
	return new Error(`${hint}${errors.length > 0 ? `\n${errors.at(-1)}` : ""}`);
}

function capUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
	const source = Buffer.from(value, "utf8");
	if (source.length <= maxBytes) return { text: value, truncated: false };
	if (maxBytes === 0) return { text: "", truncated: source.length > 0 };
	let text = new TextDecoder().decode(source.subarray(0, maxBytes));
	if (text.endsWith("\uFFFD")) text = text.slice(0, -1);
	return { text, truncated: true };
}

export function capEvalResponse(
	response: EvalWorkerResponse,
	maxBytes = MAX_OUTPUT_BYTES,
): EvalWorkerResponse & { truncated: boolean } {
	const sections = [response.stdout, response.stderr, response.value ?? "", response.error ?? ""];
	let remaining = maxBytes;
	let truncated = false;
	const capped = sections.map((section) => {
		const result = capUtf8(section, Math.max(0, remaining));
		remaining = Math.max(0, remaining - Buffer.byteLength(result.text, "utf8"));
		truncated ||= result.truncated;
		return result.text;
	});
	return {
		ok: response.ok,
		stdout: capped[0] ?? "",
		stderr: capped[1] ?? "",
		...(response.value === undefined ? {} : { value: capped[2] ?? "" }),
		...(response.error === undefined ? {} : { error: capped[3] ?? "" }),
		truncated,
	};
}

class PersistentEvalWorker implements EvalWorkerLike {
	private readonly language: EvalLanguage;
	private readonly cwd: string;
	private process: ChildProcessWithoutNullStreams | undefined;
	private buffer = "";
	private nextId = 1;
	private pending = new Map<number, PendingRequest>();
	private readyPromise: Promise<void> | undefined;
	private readyResolve: (() => void) | undefined;
	private readyReject: ((error: Error) => void) | undefined;

	constructor(language: EvalLanguage, cwd: string) {
		this.language = language;
		this.cwd = cwd;
	}

	isRunning(): boolean {
		return this.process !== undefined && this.process.exitCode === null && !this.process.killed;
	}

	private attach(child: ChildProcessWithoutNullStreams): void {
		this.process = child;
		this.buffer = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (this.process === child) this.consume(chunk);
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (_chunk: string) => {});
		child.once("error", (error) => {
			if (this.process === child) this.fail(error);
		});
		child.once("exit", (code, signal) => {
			if (this.process === child) this.fail(new Error(`运行环境已退出：${signal ?? code ?? "unknown"}`));
		});
	}

	private consume(chunk: string): void {
		this.buffer += chunk;
		for (;;) {
			const newline = this.buffer.indexOf("\n");
			if (newline === -1) return;
			const line = this.buffer.slice(0, newline).trimEnd();
			this.buffer = this.buffer.slice(newline + 1);
			if (!line.startsWith(WORKER_PREFIX)) continue;
			let message: unknown;
			try {
				message = JSON.parse(line.slice(WORKER_PREFIX.length));
			} catch {
				this.fail(new Error("运行环境返回了无法解析的数据。"));
				continue;
			}
			if (typeof message !== "object" || message === null) continue;
			const record = message as Record<string, unknown>;
			if (record.type === "ready") {
				this.readyResolve?.();
				this.readyResolve = undefined;
				this.readyReject = undefined;
				continue;
			}
			if (typeof record.id !== "number") continue;
			const request = this.pending.get(record.id);
			if (!request) continue;
			this.pending.delete(record.id);
			clearTimeout(request.timer);
			request.resolve({
				ok: record.ok === true,
				stdout: typeof record.stdout === "string" ? record.stdout : "",
				stderr: typeof record.stderr === "string" ? record.stderr : "",
				...(typeof record.value === "string" ? { value: record.value } : {}),
				...(typeof record.error === "string" ? { error: record.error } : {}),
			});
		}
	}

	private fail(error: Error): void {
		this.readyReject?.(error);
		this.readyResolve = undefined;
		this.readyReject = undefined;
		for (const request of this.pending.values()) {
			clearTimeout(request.timer);
			request.reject(error);
		}
		this.pending.clear();
		this.process = undefined;
		this.readyPromise = undefined;
	}

	private async start(): Promise<void> {
		if (this.isRunning()) return;
		const errors: string[] = [];
		for (const candidate of executableCandidates(this.language)) {
			const child = spawn(candidate.command, candidate.args, {
				cwd: this.cwd,
				env: sanitizedEvalEnvironment(process.env),
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
			this.readyPromise = new Promise<void>((resolve, reject) => {
				this.readyResolve = resolve;
				this.readyReject = reject;
			});
			this.attach(child);
			const timer = setTimeout(() => this.readyReject?.(new Error("运行环境启动超时。")), STARTUP_TIMEOUT_MS);
			try {
				await this.readyPromise;
				clearTimeout(timer);
				return;
			} catch (error) {
				clearTimeout(timer);
				errors.push(error instanceof Error ? error.message : String(error));
				child.kill();
				this.process = undefined;
				this.readyPromise = undefined;
			}
		}
		throw conciseProcessError(this.language, errors);
	}

	async execute(code: string, timeoutMs: number, signal?: AbortSignal): Promise<EvalWorkerResponse> {
		await this.start();
		const child = this.process;
		if (!child) throw new Error("运行环境没有成功启动。");
		const id = this.nextId++;
		return new Promise<EvalWorkerResponse>((resolve, reject) => {
			const onAbort = (): void => {
				void this.stop();
				reject(signal?.reason instanceof Error ? signal.reason : new Error("代码执行已取消。"));
			};
			if (signal?.aborted) {
				onAbort();
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			const timer = setTimeout(() => {
				this.pending.delete(id);
				signal?.removeEventListener("abort", onAbort);
				void this.stop();
				reject(new Error(`代码执行超过 ${Math.ceil(timeoutMs / 1000)} 秒，运行环境已重置。`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (response) => {
					signal?.removeEventListener("abort", onAbort);
					resolve(response);
				},
				reject: (error) => {
					signal?.removeEventListener("abort", onAbort);
					reject(error);
				},
				timer,
			});
			child.stdin.write(`${JSON.stringify({ id, code })}\n`, "utf8", (error) => {
				if (!error) return;
				const request = this.pending.get(id);
				if (!request) return;
				this.pending.delete(id);
				clearTimeout(request.timer);
				request.reject(error);
			});
		});
	}

	async stop(): Promise<void> {
		const child = this.process;
		if (!child) return;
		this.fail(new Error("运行环境已重置。"));
		child.kill();
	}
}

export class PersistentEvalManager implements EvalRuntimeService {
	private readonly factory: EvalWorkerFactory;
	private readonly workers = new Map<EvalLanguage, { cwd: string; worker: EvalWorkerLike }>();

	constructor(factory: EvalWorkerFactory = (language, cwd) => new PersistentEvalWorker(language, cwd)) {
		this.factory = factory;
	}

	async execute(
		language: EvalLanguage,
		code: string,
		cwd: string,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<EvalExecutionResult> {
		const existing = this.workers.get(language);
		let restarted = false;
		if (existing && existing.cwd !== cwd) {
			await existing.worker.stop();
			this.workers.delete(language);
			restarted = true;
		}
		let entry = this.workers.get(language);
		if (!entry) {
			entry = { cwd, worker: this.factory(language, cwd) };
			this.workers.set(language, entry);
			restarted = true;
		}
		const startedAt = Date.now();
		try {
			const response = capEvalResponse(await entry.worker.execute(code, timeoutMs, signal));
			return { ...response, language, durationMs: Date.now() - startedAt, restarted };
		} catch (error) {
			if (!entry.worker.isRunning()) this.workers.delete(language);
			throw error;
		}
	}

	async reset(language?: EvalLanguage): Promise<EvalLanguage[]> {
		const targets = language ? [[language, this.workers.get(language)] as const] : [...this.workers.entries()];
		const stopped: EvalLanguage[] = [];
		for (const [name, entry] of targets) {
			if (!entry) continue;
			await entry.worker.stop();
			this.workers.delete(name);
			stopped.push(name);
		}
		return stopped;
	}

	status(): EvalLanguage[] {
		return [...this.workers.entries()].flatMap(([language, entry]) => (entry.worker.isRunning() ? [language] : []));
	}

	async stopAll(): Promise<void> {
		await this.reset();
	}
}
