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
	private launchRequest: DapRequest | undefined;
	readonly commands: string[] = [];

	write(data: Uint8Array): void {
		const message = new DapMessageParser().push(data)[0];
		if (!message || message.type !== "request") return;
		this.commands.push(message.command);
		if (message.command === "launch") {
			this.launchRequest = message;
			this.emit({ seq: this.sequence++, type: "event", event: "initialized" });
			return;
		}
		const body =
			message.command === "setBreakpoints"
				? { breakpoints: [{ verified: true, line: 3 }] }
				: message.command === "stackTrace"
					? { stackFrames: [{ id: 9, name: "main", line: 3, source: { path: "C:/repo/main.py" } }] }
					: {};
		this.respond(message, body);
		if (message.command === "configurationDone" && this.launchRequest) {
			this.respond(this.launchRequest, {});
			this.launchRequest = undefined;
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
