import path from "node:path";
import { type LaunchedAdapter, launchDebugAdapter } from "./adapters.ts";
import { DapClient } from "./protocol.ts";
import type {
	DapEvent,
	DapResponse,
	DebugActionRequest,
	DebugAdapterRequest,
	DebugAttachRequest,
	DebugLanguage,
	DebugResult,
	DebugServiceLike,
	DebugStartRequest,
	DebugToolDetails,
} from "./types.ts";

const MAX_ITEMS = 50;
const MAX_OUTPUT_CHARACTERS = 8_000;

export type DebugAdapterLauncher = (request: DebugAdapterRequest) => Promise<LaunchedAdapter>;

interface ActiveDebugSession {
	client: DapClient;
	capabilities: Record<string, unknown>;
	language: DebugLanguage;
	mode: "launch" | "attach";
	cwd: string;
	state: DebugToolDetails["state"];
	threadId?: number;
	output: string;
}

function requireCapability(session: ActiveDebugSession, key: string, operation: string): void {
	if (session.capabilities[key] !== true) {
		throw new Error(`当前调试器不支持 ${operation}。`);
	}
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
		...(session ? { mode: session.mode } : {}),
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
		options: Pick<DebugActionRequest, "condition" | "hitCondition" | "logMessage"> = {},
	): Promise<DebugResult> {
		if (options.condition) requireCapability(session, "supportsConditionalBreakpoints", "条件断点");
		if (options.hitCondition) requireCapability(session, "supportsHitConditionalBreakpoints", "命中次数断点");
		if (options.logMessage) requireCapability(session, "supportsLogPoints", "日志断点");
		const response = await session.client.request("setBreakpoints", {
			source: { path: projectFile(session.cwd, filePath) },
			breakpoints: [...new Set(lines)]
				.sort((a, b) => a - b)
				.map((line) => ({
					line,
					...(options.condition ? { condition: options.condition } : {}),
					...(options.hitCondition ? { hitCondition: options.hitCondition } : {}),
					...(options.logMessage ? { logMessage: options.logMessage } : {}),
				})),
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

	private async setFunctionBreakpoints(
		session: ActiveDebugSession,
		request: DebugActionRequest,
	): Promise<DebugResult> {
		if (!request.functionNames?.length) throw new Error("set_function_breakpoints 需要 function_names。");
		requireCapability(session, "supportsFunctionBreakpoints", "函数断点");
		const response = await session.client.request("setFunctionBreakpoints", {
			breakpoints: [...new Set(request.functionNames)].map((name) => ({
				name,
				...(request.condition ? { condition: request.condition } : {}),
				...(request.hitCondition ? { hitCondition: request.hitCondition } : {}),
			})),
		});
		const breakpoints = cappedItems(bodyOf(response).breakpoints);
		const text = breakpoints.items
			.map((item, index) => {
				const name = request.functionNames?.[index] ?? `#${index + 1}`;
				return `${name} · ${item.verified === true ? "已确认" : "待确认"}${typeof item.message === "string" ? `：${item.message}` : ""}`;
			})
			.join("\n");
		return {
			text: text || "没有设置函数断点。",
			details: detail("set_function_breakpoints", session, breakpoints.items.length, breakpoints.truncated),
		};
	}

	private async setExceptionBreakpoints(
		session: ActiveDebugSession,
		request: DebugActionRequest,
	): Promise<DebugResult> {
		if (!request.exceptionFilters?.length) throw new Error("set_exception_breakpoints 需要 exception_filters。");
		const filters = [...new Set(request.exceptionFilters)];
		const advertisedFilters = Array.isArray(session.capabilities.exceptionBreakpointFilters)
			? session.capabilities.exceptionBreakpointFilters
					.filter(isRecord)
					.map((filter) => filter.filter)
					.filter((filter): filter is string => typeof filter === "string")
			: [];
		const invalid = filters.filter((filter) => !advertisedFilters.includes(filter));
		if (invalid.length > 0 && advertisedFilters.length > 0) {
			throw new Error(
				`当前调试器不支持这些异常过滤器：${invalid.join("、")}。可用：${advertisedFilters.join("、")}`,
			);
		}
		const response = await session.client.request("setExceptionBreakpoints", {
			filters,
			...(request.condition
				? { filterOptions: filters.map((filterId) => ({ filterId, condition: request.condition })) }
				: {}),
		});
		const breakpoints = cappedItems(bodyOf(response).breakpoints);
		return {
			text: `异常断点已更新：${filters.join("、")}`,
			details: detail(
				"set_exception_breakpoints",
				session,
				breakpoints.items.length || filters.length,
				breakpoints.truncated,
			),
		};
	}

	async start(request: DebugStartRequest, signal?: AbortSignal): Promise<DebugResult> {
		return this.begin({ ...request, mode: "launch" }, "start", signal);
	}

	async attach(request: DebugAttachRequest, signal?: AbortSignal): Promise<DebugResult> {
		if (request.processId === undefined && request.port === undefined)
			throw new Error("attach 需要 process_id，或者 host + port。");
		if (request.language === "go" && request.processId === undefined) throw new Error("Go attach 需要 process_id。");
		return this.begin({ ...request, mode: "attach" }, "attach", signal);
	}

	private async begin(
		request: DebugAdapterRequest,
		operation: "start" | "attach",
		signal?: AbortSignal,
	): Promise<DebugResult> {
		await this.end(false);
		const normalized: DebugAdapterRequest =
			request.path === undefined ? request : { ...request, path: projectFile(request.cwd, request.path) };
		if (signal?.aborted) throw signal.reason;
		const launched = await this.launcher(normalized);
		const client = new DapClient(launched.transport);
		const session: ActiveDebugSession = {
			client,
			capabilities: {},
			language: request.language,
			mode: request.mode,
			cwd: request.cwd,
			state: "starting",
			output: "",
		};
		this.session = session;
		this.observe(session);
		const onAbort = (): void => {
			void this.end(false);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const initializeResponse = await client.request("initialize", {
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
			session.capabilities = bodyOf(initializeResponse);
			const initialized = client.waitForEvent("initialized", 15_000);
			const launch = client.request(launched.request, launched.launchArguments, 30_000);
			await initialized;
			if (request.breakpoints.length > 0 && normalized.path)
				await this.setBreakpoints(session, normalized.path, request.breakpoints);
			await client.request("configurationDone", {});
			await launch;
			session.state = request.mode === "launch" && request.stopOnEntry ? "stopped" : "running";
			const target = normalized.path
				? path.relative(request.cwd, normalized.path) || path.basename(normalized.path)
				: normalized.mode === "attach" && normalized.processId !== undefined
					? `PID ${normalized.processId}`
					: normalized.mode === "attach"
						? `${normalized.host ?? "127.0.0.1"}:${normalized.port}`
						: "unknown";
			return {
				text: `${operation === "start" ? "调试会话已启动" : "已附加到运行中目标"}：${request.language} · ${target}${request.breakpoints.length > 0 ? ` · ${request.breakpoints.length} 个断点` : ""}`,
				details: detail(operation, session, request.breakpoints.length),
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
			return {
				text: `调试状态：${session.state} · ${session.mode}${session.threadId === undefined ? "" : ` · 线程 ${session.threadId}`}${output}`,
				details: detail("status", session),
			};
		}
		if (request.operation === "disconnect") {
			const session = this.session;
			await this.end(false);
			return {
				text: session ? "已断开调试器；目标进程继续运行。" : "当前没有调试会话。",
				details: detail("disconnect", undefined),
			};
		}
		if (request.operation === "stop") {
			const session = this.session;
			await this.end(true);
			return { text: session ? "调试会话已结束。" : "当前没有调试会话。", details: detail("stop", undefined) };
		}
		if (signal?.aborted) throw signal.reason;
		const session = this.requireSession();
		if (path.resolve(cwd) !== path.resolve(session.cwd)) throw new Error("调试会话属于另一个项目，请先 stop。");
		if (request.operation === "set_breakpoints") {
			if (!request.path || !request.lines) throw new Error("set_breakpoints 需要 path 和 lines。");
			return this.setBreakpoints(session, request.path, request.lines, request);
		}
		if (request.operation === "set_function_breakpoints") {
			return this.setFunctionBreakpoints(session, request);
		}
		if (request.operation === "set_exception_breakpoints") {
			return this.setExceptionBreakpoints(session, request);
		}
		if (request.operation === "threads") {
			const response = await session.client.request("threads", {});
			const threads = cappedItems(bodyOf(response).threads);
			const text = threads.items.map((thread) => `${thread.id ?? "?"} · ${thread.name ?? "thread"}`).join("\n");
			return {
				text: text || "没有可用线程。",
				details: detail("threads", session, threads.items.length, threads.truncated),
			};
		}
		if (request.operation === "pause") {
			const threadId = await this.threadId(session, request.threadId);
			const stopped = waitForPauseOrTermination(session.client, 5_000);
			await session.client.request("pause", { threadId });
			const event = await stopped;
			if (event?.event === "stopped") {
				session.state = "stopped";
				session.threadId = eventThreadId(event) ?? threadId;
				return { text: `程序已暂停在线程 ${session.threadId}。`, details: detail("pause", session) };
			}
			return { text: "已发送暂停请求；调试器尚未确认暂停。", details: detail("pause", session) };
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
		if (request.operation === "data_breakpoint_info") {
			requireCapability(session, "supportsDataBreakpoints", "数据断点");
			if (!request.name) throw new Error("data_breakpoint_info 需要 name。");
			const response = await session.client.request("dataBreakpointInfo", {
				name: request.name,
				...(request.variablesReference === undefined
					? request.frameId === undefined
						? {}
						: { frameId: request.frameId }
					: { variablesReference: request.variablesReference }),
			});
			const body = bodyOf(response);
			const accessTypes = Array.isArray(body.accessTypes) ? body.accessTypes.join("、") : "default";
			return {
				text: body.dataId
					? `data_id=${body.dataId}\n说明：${body.description ?? request.name}\n访问类型：${accessTypes}\n可持久：${body.canPersist === true ? "是" : "否"}`
					: `该变量不支持数据断点${body.description ? `：${body.description}` : "。"}`,
				details: detail("data_breakpoint_info", session, body.dataId ? 1 : 0),
			};
		}
		if (request.operation === "set_data_breakpoints") {
			requireCapability(session, "supportsDataBreakpoints", "数据断点");
			if (!request.dataIds?.length) throw new Error("set_data_breakpoints 需要 data_ids。");
			const response = await session.client.request("setDataBreakpoints", {
				breakpoints: [...new Set(request.dataIds)].map((dataId) => ({
					dataId,
					...(request.accessType ? { accessType: request.accessType } : {}),
					...(request.condition ? { condition: request.condition } : {}),
					...(request.hitCondition ? { hitCondition: request.hitCondition } : {}),
				})),
			});
			const breakpoints = cappedItems(bodyOf(response).breakpoints);
			return {
				text: breakpoints.items
					.map(
						(item, index) =>
							`${request.dataIds?.[index] ?? index + 1} · ${item.verified === true ? "已确认" : "待确认"}`,
					)
					.join("\n"),
				details: detail("set_data_breakpoints", session, breakpoints.items.length, breakpoints.truncated),
			};
		}
		if (request.operation === "loaded_sources") {
			requireCapability(session, "supportsLoadedSourcesRequest", "已加载源码查询");
			const response = await session.client.request("loadedSources", {});
			const sources = cappedItems(bodyOf(response).sources);
			const text = sources.items
				.map((source) => {
					const sourcePath = typeof source.path === "string" ? source.path : undefined;
					return `${source.name ?? (sourcePath ? path.basename(sourcePath) : "source")}${sourcePath ? ` · ${path.relative(session.cwd, sourcePath)}` : ""}`;
				})
				.join("\n");
			return {
				text: text || "没有已加载源码。",
				details: detail("loaded_sources", session, sources.items.length, sources.truncated),
			};
		}
		if (request.operation === "modules") {
			requireCapability(session, "supportsModulesRequest", "模块查询");
			const response = await session.client.request("modules", { startModule: 0, moduleCount: MAX_ITEMS });
			const modules = cappedItems(bodyOf(response).modules);
			const text = modules.items
				.map(
					(module) => `${module.id ?? "?"} · ${module.name ?? "module"}${module.path ? ` · ${module.path}` : ""}`,
				)
				.join("\n");
			return {
				text: text || "没有模块。",
				details: detail("modules", session, modules.items.length, modules.truncated),
			};
		}
		if (request.operation === "restart") {
			requireCapability(session, "supportsRestartRequest", "重启调试目标");
			await session.client.request("restart", {});
			session.state = "running";
			session.threadId = undefined;
			return { text: "调试目标已重启。", details: detail("restart", session) };
		}
		throw new Error(`不支持的调试操作：${request.operation}`);
	}

	async stop(): Promise<void> {
		await this.end(true);
	}

	private async end(terminateDebuggee: boolean): Promise<void> {
		const session = this.session;
		this.session = undefined;
		if (!session) return;
		try {
			await session.client.request("disconnect", { terminateDebuggee }, 2_000);
		} catch {
			// The adapter or debuggee may already have exited.
		}
		await session.client.dispose();
	}
}
