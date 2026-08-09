import path from "node:path";
import { type LaunchedAdapter, launchDebugAdapter } from "./adapters.ts";
import { DapClient } from "./protocol.ts";
import type {
	DapEvent,
	DapResponse,
	DebugActionRequest,
	DebugLanguage,
	DebugResult,
	DebugServiceLike,
	DebugStartRequest,
	DebugToolDetails,
} from "./types.ts";

const MAX_ITEMS = 50;
const MAX_OUTPUT_CHARACTERS = 8_000;

export type DebugAdapterLauncher = (request: DebugStartRequest) => Promise<LaunchedAdapter>;

interface ActiveDebugSession {
	client: DapClient;
	language: DebugLanguage;
	cwd: string;
	state: DebugToolDetails["state"];
	threadId?: number;
	output: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bodyOf(response: DapResponse): Record<string, unknown> {
	return isRecord(response.body) ? response.body : {};
}

function projectFile(cwd: string, requestedPath: string): string {
	const root = path.resolve(cwd);
	const candidate = path.resolve(root, requestedPath);
	const relative = path.relative(root, candidate);
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("调试路径必须位于当前项目中。");
	return candidate;
}

export function inferDebugLanguage(filePath: string): DebugLanguage {
	const extension = path.extname(filePath).toLowerCase();
	if (extension === ".py" || extension === ".pyi") return "python";
	if (extension === ".go") return "go";
	if ([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"].includes(extension)) return "javascript";
	throw new Error("无法从文件扩展名判断调试语言，请明确指定 language。");
}

function eventThreadId(event: DapEvent): number | undefined {
	return isRecord(event.body) && typeof event.body.threadId === "number" ? event.body.threadId : undefined;
}

function waitForPauseOrTermination(client: DapClient, timeoutMs: number): Promise<DapEvent | undefined> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			dispose();
			resolve(undefined);
		}, timeoutMs);
		const dispose = client.onEvent((event) => {
			if (event.event !== "stopped" && event.event !== "terminated" && event.event !== "exited") return;
			clearTimeout(timer);
			dispose();
			resolve(event);
		});
	});
}

function cappedItems(value: unknown): { items: Record<string, unknown>[]; truncated: boolean } {
	if (!Array.isArray(value)) return { items: [], truncated: false };
	const records = value.filter(isRecord);
	return { items: records.slice(0, MAX_ITEMS), truncated: records.length > MAX_ITEMS };
}

function detail(
	operation: DebugToolDetails["operation"],
	session: ActiveDebugSession | undefined,
	itemCount = 0,
	truncated = false,
): DebugToolDetails {
	return {
		operation,
		...(session ? { language: session.language } : {}),
		state: session?.state ?? "idle",
		...(session?.threadId === undefined ? {} : { threadId: session.threadId }),
		itemCount,
		truncated,
	};
}

export class DebugSessionService implements DebugServiceLike {
	private readonly launcher: DebugAdapterLauncher;
	private session: ActiveDebugSession | undefined;

	constructor(launcher: DebugAdapterLauncher = launchDebugAdapter) {
		this.launcher = launcher;
	}

	private observe(session: ActiveDebugSession): void {
		session.client.onEvent((event) => {
			if (event.event === "stopped") {
				session.state = "stopped";
				session.threadId = eventThreadId(event) ?? session.threadId;
			} else if (event.event === "continued") session.state = "running";
			else if (event.event === "terminated" || event.event === "exited") session.state = "terminated";
			else if (event.event === "output" && isRecord(event.body) && typeof event.body.output === "string") {
				session.output = `${session.output}${event.body.output}`.slice(-MAX_OUTPUT_CHARACTERS);
			}
		});
	}

	private async setBreakpoints(
		session: ActiveDebugSession,
		filePath: string,
		lines: readonly number[],
	): Promise<DebugResult> {
		const response = await session.client.request("setBreakpoints", {
			source: { path: projectFile(session.cwd, filePath) },
			breakpoints: [...new Set(lines)].sort((a, b) => a - b).map((line) => ({ line })),
			sourceModified: false,
		});
		const breakpoints = cappedItems(bodyOf(response).breakpoints);
		const text = breakpoints.items.length
			? breakpoints.items
					.map((item) => {
						const line = typeof item.line === "number" ? item.line : "?";
						const verified = item.verified === true ? "已确认" : "待确认";
						const message = typeof item.message === "string" ? `：${item.message}` : "";
						return `${line} 行 · ${verified}${message}`;
					})
					.join("\n")
			: "没有设置断点。";
		return { text, details: detail("set_breakpoints", session, breakpoints.items.length, breakpoints.truncated) };
	}

	async start(request: DebugStartRequest, signal?: AbortSignal): Promise<DebugResult> {
		await this.stop();
		const normalized: DebugStartRequest = { ...request, path: projectFile(request.cwd, request.path) };
		if (signal?.aborted) throw signal.reason;
		const launched = await this.launcher(normalized);
		const client = new DapClient(launched.transport);
		const session: ActiveDebugSession = {
			client,
			language: request.language,
			cwd: request.cwd,
			state: "starting",
			output: "",
		};
		this.session = session;
		this.observe(session);
		const onAbort = (): void => {
			void this.stop();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			await client.request("initialize", {
				clientID: "pi",
				clientName: "Pi Coding Agent",
				adapterID: launched.adapterId,
				locale: "zh-CN",
				linesStartAt1: true,
				columnsStartAt1: true,
				pathFormat: "path",
				supportsVariableType: true,
				supportsVariablePaging: true,
			});
			const initialized = client.waitForEvent("initialized", 15_000);
			const launch = client.request("launch", launched.launchArguments, 30_000);
			await initialized;
			if (request.breakpoints.length > 0) await this.setBreakpoints(session, normalized.path, request.breakpoints);
			await client.request("configurationDone", {});
			await launch;
			session.state = request.stopOnEntry ? "stopped" : "running";
			return {
				text: `调试会话已启动：${request.language} · ${path.relative(request.cwd, normalized.path) || path.basename(normalized.path)}${request.breakpoints.length > 0 ? ` · ${request.breakpoints.length} 个断点` : ""}`,
				details: detail("start", session, request.breakpoints.length),
			};
		} catch (error) {
			await this.stop();
			throw error;
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	}

	private requireSession(): ActiveDebugSession {
		if (!this.session) throw new Error("当前没有调试会话，请先使用 operation=start。");
		return this.session;
	}

	private async threadId(session: ActiveDebugSession, requested?: number): Promise<number> {
		if (requested !== undefined) return requested;
		if (session.threadId !== undefined) return session.threadId;
		const response = await session.client.request("threads", {});
		const threads = cappedItems(bodyOf(response).threads).items;
		const id = threads.find((thread) => typeof thread.id === "number")?.id;
		if (typeof id !== "number") throw new Error("调试器没有返回可用线程。");
		return id;
	}

	private async resume(
		session: ActiveDebugSession,
		operation: "continue" | "next" | "step_in" | "step_out",
		threadId: number,
	): Promise<DebugResult> {
		const command = operation === "step_in" ? "stepIn" : operation === "step_out" ? "stepOut" : operation;
		const stopped = waitForPauseOrTermination(session.client, 10_000);
		await session.client.request(command, { threadId });
		session.state = "running";
		const event = await stopped;
		if (event?.event === "stopped") {
			session.state = "stopped";
			session.threadId = eventThreadId(event) ?? threadId;
			return { text: `程序已暂停在线程 ${session.threadId}。`, details: detail(operation, session) };
		}
		if (event) session.state = "terminated";
		return {
			text: event ? "程序已经结束。" : "程序仍在运行；到达断点后可查看调用栈。",
			details: detail(operation, session),
		};
	}

	async action(request: DebugActionRequest, cwd: string, signal?: AbortSignal): Promise<DebugResult> {
		if (request.operation === "status") {
			const session = this.session;
			if (!session) return { text: "当前没有调试会话。", details: detail("status", undefined) };
			const output = session.output.trim() ? `\n\n最近输出：\n${session.output.trim()}` : "";
			return { text: `调试状态：${session.state}${output}`, details: detail("status", session) };
		}
		if (request.operation === "stop") {
			const session = this.session;
			await this.stop();
			return { text: session ? "调试会话已结束。" : "当前没有调试会话。", details: detail("stop", undefined) };
		}
		if (signal?.aborted) throw signal.reason;
		const session = this.requireSession();
		if (path.resolve(cwd) !== path.resolve(session.cwd)) throw new Error("调试会话属于另一个项目，请先 stop。");
		if (request.operation === "set_breakpoints") {
			if (!request.path || !request.lines) throw new Error("set_breakpoints 需要 path 和 lines。");
			return this.setBreakpoints(session, request.path, request.lines);
		}
		if (["continue", "next", "step_in", "step_out"].includes(request.operation)) {
			return this.resume(
				session,
				request.operation as "continue" | "next" | "step_in" | "step_out",
				await this.threadId(session, request.threadId),
			);
		}
		if (request.operation === "stack") {
			const threadId = await this.threadId(session, request.threadId);
			const response = await session.client.request("stackTrace", { threadId, startFrame: 0, levels: MAX_ITEMS });
			const frames = cappedItems(bodyOf(response).stackFrames);
			const text = frames.items
				.map((frame) => {
					const source =
						isRecord(frame.source) && typeof frame.source.path === "string" ? frame.source.path : "unknown";
					return `#${frame.id ?? "?"} ${frame.name ?? "frame"} · ${path.relative(session.cwd, source)}:${frame.line ?? "?"}`;
				})
				.join("\n");
			return {
				text: text || "调用栈为空。",
				details: detail("stack", session, frames.items.length, frames.truncated),
			};
		}
		if (request.operation === "scopes") {
			if (request.frameId === undefined) throw new Error("scopes 需要 stack 返回的 frame_id。");
			const response = await session.client.request("scopes", { frameId: request.frameId });
			const scopes = cappedItems(bodyOf(response).scopes);
			const text = scopes.items
				.map((scope) => `${scope.name ?? "scope"} · variables_reference=${scope.variablesReference ?? 0}`)
				.join("\n");
			return {
				text: text || "没有可用作用域。",
				details: detail("scopes", session, scopes.items.length, scopes.truncated),
			};
		}
		if (request.operation === "variables") {
			if (request.variablesReference === undefined) throw new Error("variables 需要 variables_reference。");
			const response = await session.client.request("variables", {
				variablesReference: request.variablesReference,
				start: 0,
				count: MAX_ITEMS,
			});
			const variables = cappedItems(bodyOf(response).variables);
			const text = variables.items
				.map(
					(variable) =>
						`${variable.name ?? "?"}${variable.type ? `: ${variable.type}` : ""} = ${variable.value ?? ""} · ref=${variable.variablesReference ?? 0}`,
				)
				.join("\n");
			return {
				text: text || "没有变量。",
				details: detail("variables", session, variables.items.length, variables.truncated),
			};
		}
		if (request.operation === "evaluate") {
			if (!request.expression) throw new Error("evaluate 需要 expression。");
			const response = await session.client.request("evaluate", {
				expression: request.expression,
				...(request.frameId === undefined ? {} : { frameId: request.frameId }),
				context: "repl",
			});
			const body = bodyOf(response);
			return {
				text: `${body.result ?? ""}${body.type ? `\n类型：${body.type}` : ""}${body.variablesReference ? `\nvariables_reference=${body.variablesReference}` : ""}`,
				details: detail("evaluate", session, 1),
			};
		}
		throw new Error(`不支持的调试操作：${request.operation}`);
	}

	async stop(): Promise<void> {
		const session = this.session;
		this.session = undefined;
		if (!session) return;
		try {
			await session.client.request("disconnect", { terminateDebuggee: true }, 2_000);
		} catch {
			// The adapter or debuggee may already have exited.
		}
		await session.client.dispose();
	}
}
