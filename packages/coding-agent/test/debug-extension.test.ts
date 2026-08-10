import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { capDebugResult, createDebugExtension } from "../src/extensions/debug/index.ts";
import { DapMessageParser, encodeDapMessage } from "../src/extensions/debug/protocol.ts";
import { DebugSessionService, inferDebugLanguage } from "../src/extensions/debug/service.ts";
import type {
	DapMessage,
	DapRequest,
	DapTransport,
	DebugResult,
	DebugServiceLike,
} from "../src/extensions/debug/types.ts";

class ScriptedAdapter implements DapTransport {
	private dataListener: ((data: Uint8Array) => void) | undefined;
	private closeListener: ((error?: Error) => void) | undefined;
	private sequence = 100;
	private sessionRequest: DapRequest | undefined;
	readonly commands: string[] = [];
	readonly requests: DapRequest[] = [];

	write(data: Uint8Array): void {
		const message = new DapMessageParser().push(data)[0];
		if (!message || message.type !== "request") return;
		this.commands.push(message.command);
		this.requests.push(message);
		if (message.command === "launch" || message.command === "attach") {
			this.sessionRequest = message;
			this.emit({ seq: this.sequence++, type: "event", event: "initialized" });
			return;
		}
		const body =
			message.command === "initialize"
				? {
						supportsConditionalBreakpoints: true,
						supportsHitConditionalBreakpoints: true,
						supportsLogPoints: true,
						supportsFunctionBreakpoints: true,
						exceptionBreakpointFilters: [{ filter: "raised", label: "Raised" }],
						supportsDataBreakpoints: true,
						supportsLoadedSourcesRequest: true,
						supportsModulesRequest: true,
						supportsRestartRequest: true,
					}
				: message.command === "setBreakpoints"
					? { breakpoints: [{ verified: true, line: 3 }] }
					: message.command === "setFunctionBreakpoints" || message.command === "setDataBreakpoints"
						? { breakpoints: [{ verified: true }] }
						: message.command === "threads"
							? {
									threads: [
										{ id: 7, name: "main" },
										{ id: 8, name: "worker" },
									],
								}
							: message.command === "dataBreakpointInfo"
								? {
										dataId: "watch-1",
										description: "counter",
										accessTypes: ["read", "write"],
										canPersist: true,
									}
								: message.command === "loadedSources"
									? { sources: [{ name: "main.py", path: "C:/repo/main.py" }] }
									: message.command === "modules"
										? { modules: [{ id: 1, name: "app", path: "C:/repo/app" }] }
										: message.command === "stackTrace"
											? {
													stackFrames: [
														{ id: 9, name: "main", line: 3, source: { path: "C:/repo/main.py" } },
													],
												}
											: {};
		this.respond(message, body);
		if (message.command === "pause") {
			this.emit({ seq: this.sequence++, type: "event", event: "stopped", body: { threadId: 7 } });
		}
		if (message.command === "configurationDone" && this.sessionRequest) {
			this.respond(this.sessionRequest, {});
			this.sessionRequest = undefined;
		}
	}

	private respond(request: DapRequest, body: unknown): void {
		this.emit({
			seq: this.sequence++,
			type: "response",
			request_seq: request.seq,
			success: true,
			command: request.command,
			body,
		});
	}

	private emit(message: DapMessage): void {
		this.dataListener?.(encodeDapMessage(message));
	}

	onData(listener: (data: Uint8Array) => void): void {
		this.dataListener = listener;
	}

	onClose(listener: (error?: Error) => void): void {
		this.closeListener = listener;
	}

	async dispose(): Promise<void> {
		this.closeListener?.();
	}
}

describe("debug session service", () => {
	it("follows DAP launch ordering and returns stack frames", async () => {
		const adapter = new ScriptedAdapter();
		const service = new DebugSessionService(async () => ({
			transport: adapter,
			adapterId: "debugpy",
			request: "launch",
			launchArguments: { type: "debugpy", request: "launch", program: "C:/repo/main.py" },
		}));

		const started = await service.start({
			language: "python",
			path: "main.py",
			args: [],
			breakpoints: [3],
			stopOnEntry: true,
			cwd: "C:/repo",
		});
		const stack = await service.action({ operation: "stack", threadId: 1 }, "C:/repo");

		expect(adapter.commands.slice(0, 5)).toEqual([
			"initialize",
			"launch",
			"setBreakpoints",
			"configurationDone",
			"stackTrace",
		]);
		expect(started.details.state).toBe("stopped");
		expect(stack.text).toContain("#9 main");
		await service.stop();
	});

	it("infers the three supported language families", () => {
		expect(inferDebugLanguage("main.py")).toBe("python");
		expect(inferDebugLanguage("main.ts")).toBe("javascript");
		expect(inferDebugLanguage("main.go")).toBe("go");
	});

	it("attaches without terminating the target and exposes threads and pause", async () => {
		const adapter = new ScriptedAdapter();
		const service = new DebugSessionService(async () => ({
			transport: adapter,
			adapterId: "debugpy",
			request: "attach",
			launchArguments: { type: "debugpy", request: "attach", processId: 42 },
		}));

		const attached = await service.attach({
			language: "python",
			processId: 42,
			breakpoints: [],
			cwd: "C:/repo",
		});
		const threads = await service.action({ operation: "threads" }, "C:/repo");
		const paused = await service.action({ operation: "pause", threadId: 7 }, "C:/repo");
		await service.action({ operation: "disconnect" }, "C:/repo");

		expect(attached.text).toContain("PID 42");
		expect(threads.text).toContain("7 · main");
		expect(paused.details.state).toBe("stopped");
		expect(adapter.requests.find((request) => request.command === "disconnect")?.arguments).toMatchObject({
			terminateDebuggee: false,
		});
	});

	it("supports conditional, function, exception, data, source, module, and restart operations", async () => {
		const adapter = new ScriptedAdapter();
		const service = new DebugSessionService(async () => ({
			transport: adapter,
			adapterId: "debugpy",
			request: "launch",
			launchArguments: { type: "debugpy", request: "launch", program: "C:/repo/main.py" },
		}));
		await service.start({
			language: "python",
			path: "main.py",
			args: [],
			breakpoints: [],
			stopOnEntry: false,
			cwd: "C:/repo",
		});

		await service.action(
			{
				operation: "set_breakpoints",
				path: "main.py",
				lines: [3],
				condition: "counter > 2",
				hitCondition: "5",
				logMessage: "counter={counter}",
			},
			"C:/repo",
		);
		await service.action({ operation: "set_function_breakpoints", functionNames: ["main"] }, "C:/repo");
		await service.action({ operation: "set_exception_breakpoints", exceptionFilters: ["raised"] }, "C:/repo");
		const info = await service.action(
			{ operation: "data_breakpoint_info", variablesReference: 11, name: "counter" },
			"C:/repo",
		);
		await service.action({ operation: "set_data_breakpoints", dataIds: ["watch-1"], accessType: "write" }, "C:/repo");
		const sources = await service.action({ operation: "loaded_sources" }, "C:/repo");
		const modules = await service.action({ operation: "modules" }, "C:/repo");
		await service.action({ operation: "restart" }, "C:/repo");

		const lineRequest = adapter.requests.find((request) => request.command === "setBreakpoints");
		expect(lineRequest?.arguments).toMatchObject({
			breakpoints: [{ line: 3, condition: "counter > 2", hitCondition: "5", logMessage: "counter={counter}" }],
		});
		expect(info.text).toContain("data_id=watch-1");
		expect(sources.text).toContain("main.py");
		expect(modules.text).toContain("app");
		expect(adapter.commands).toEqual(
			expect.arrayContaining([
				"setFunctionBreakpoints",
				"setExceptionBreakpoints",
				"dataBreakpointInfo",
				"setDataBreakpoints",
				"loadedSources",
				"modules",
				"restart",
			]),
		);
		await service.stop();
	});
});

describe("debug extension", () => {
	it("caps large variable output before it reaches the model", () => {
		const result = capDebugResult({
			text: "变量".repeat(20_000),
			details: { operation: "variables", state: "stopped", itemCount: 1, truncated: false },
		});
		expect(Buffer.byteLength(result.text, "utf8")).toBeLessThan(25 * 1024);
		expect(result.details.truncated).toBe(true);
	});

	it("registers an approval-aware sequential debug tool", async () => {
		const tools: ToolDefinition[] = [];
		const service: DebugServiceLike = {
			start: vi.fn(
				async (): Promise<DebugResult> => ({
					text: "started",
					details: { operation: "start", language: "python", state: "running", itemCount: 0, truncated: false },
				}),
			),
			attach: vi.fn(
				async (): Promise<DebugResult> => ({
					text: "attached",
					details: {
						operation: "attach",
						language: "python",
						mode: "attach",
						state: "running",
						itemCount: 0,
						truncated: false,
					},
				}),
			),
			action: vi.fn(
				async (): Promise<DebugResult> => ({
					text: "idle",
					details: { operation: "status", state: "idle", itemCount: 0, truncated: false },
				}),
			),
			stop: vi.fn(async () => {}),
		};
		createDebugExtension(service)({
			registerTool: (tool: ToolDefinition) => tools.push(tool),
			on: () => {},
		} as unknown as ExtensionAPI);

		expect(tools[0]).toMatchObject({ name: "debug", executionMode: "sequential" });
		expect(typeof tools[0]?.approval).toBe("function");
		await tools[0]?.execute("start", { operation: "start", path: "main.py", lines: [4] }, undefined, undefined, {
			cwd: "C:/repo",
		} as ExtensionContext);
		expect(service.start).toHaveBeenCalledWith(
			expect.objectContaining({ language: "python", path: "main.py", breakpoints: [4], cwd: "C:/repo" }),
			undefined,
		);
	});
});
