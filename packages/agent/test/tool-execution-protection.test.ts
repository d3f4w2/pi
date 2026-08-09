import { type AssistantMessage, type AssistantMessageEvent, EventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import { normalizeToolExecutionError } from "../src/tool-failure-guard.ts";
import type { AgentEvent, AgentTool, StreamFn } from "../src/types.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function toolCall(id: string, path: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "unstable", arguments: { path } }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: ZERO_USAGE,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function finalMessage(text = "done"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function sequenceStream(entries: Array<{ message: AssistantMessage; delayMs?: number }>): StreamFn {
	let index = 0;
	return () => {
		const entry = entries[index++];
		if (!entry) throw new Error(`Unexpected provider call ${index}`);
		const stream = new MockAssistantStream();
		setTimeout(() => {
			stream.push({
				type: "done",
				reason: entry.message.stopReason === "toolUse" ? "toolUse" : "stop",
				message: entry.message,
			});
		}, entry.delayMs ?? 0);
		return stream;
	};
}

function resultTexts(events: AgentEvent[]): string[] {
	return events.flatMap((event) => {
		if (event.type !== "message_end" || event.message.role !== "toolResult") return [];
		return event.message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
	});
}

function unstableTool(run: (signal: AbortSignal | undefined, execution: number) => Promise<string>): {
	tool: AgentTool;
	executions(): number;
} {
	let executions = 0;
	const parameters = Type.Object({ path: Type.String() });
	return {
		tool: {
			name: "unstable",
			label: "Unstable",
			description: "Test tool",
			parameters,
			async execute(_toolCallId, _params, signal) {
				executions++;
				const text = await run(signal, executions);
				return { content: [{ type: "text", text }], details: {} };
			},
		},
		executions: () => executions,
	};
}

describe("tool execution protection", () => {
	it("fails safely when a thrown value cannot be stringified", () => {
		expect(
			normalizeToolExecutionError({
				toString() {
					throw new Error("must not escape");
				},
			}),
		).toBe("Tool execution failed");
	});

	it("opens a tool-wide circuit after changed calls fail consecutively", async () => {
		const unstable = unstableTool(async () => {
			throw new Error("service unavailable");
		});
		const events: AgentEvent[] = [];
		const agent = new Agent({
			initialState: { tools: [unstable.tool] },
			streamFn: sequenceStream([
				{ message: toolCall("call-1", "a") },
				{ message: toolCall("call-2", "b") },
				{ message: toolCall("call-3", "c") },
				{ message: toolCall("call-4", "d") },
				{ message: finalMessage() },
			]),
			repeatedToolFailureLimit: 0,
			toolConsecutiveFailureLimit: 3,
			toolFailureCooldownMs: 30_000,
		});
		agent.subscribe((event) => {
			events.push(event);
		});

		await agent.prompt("inspect");

		expect(unstable.executions()).toBe(3);
		expect(resultTexts(events).at(-1)).toContain("temporarily unavailable");
		expect(agent.state.toolFailureGuard.tools).toEqual([
			expect.objectContaining({ name: "unstable", status: "open", consecutiveFailures: 3 }),
		]);
	});

	it("allows one half-open probe after cooldown and closes on success", async () => {
		const unstable = unstableTool(async (_signal, execution) => {
			if (execution === 1) throw new Error("temporary outage");
			return "ok";
		});
		const agent = new Agent({
			initialState: { tools: [unstable.tool] },
			streamFn: sequenceStream([
				{ message: toolCall("call-1", "a") },
				{ message: toolCall("call-2", "blocked") },
				{ message: toolCall("call-3", "probe"), delayMs: 40 },
				{ message: toolCall("call-4", "normal") },
				{ message: finalMessage() },
			]),
			repeatedToolFailureLimit: 0,
			toolConsecutiveFailureLimit: 1,
			toolFailureCooldownMs: 20,
		});

		await agent.prompt("inspect");

		expect(unstable.executions()).toBe(3);
		expect(agent.state.toolFailureGuard.tools).toEqual([]);
	});

	it("times out through a child signal and keeps the agent running", async () => {
		const unstable = unstableTool(
			(signal) =>
				new Promise<string>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new Error("late internal abort")), { once: true });
				}),
		);
		const events: AgentEvent[] = [];
		const agent = new Agent({
			initialState: { tools: [unstable.tool] },
			streamFn: sequenceStream([{ message: toolCall("call-1", "slow") }, { message: finalMessage() }]),
			repeatedToolFailureLimit: 0,
			toolConsecutiveFailureLimit: 1,
			toolFailureCooldownMs: 30_000,
			toolExecutionTimeoutMs: 20,
		});
		agent.subscribe((event) => {
			events.push(event);
		});

		await agent.prompt("inspect");

		expect(resultTexts(events)).toContain(
			"Tool unstable timed out after 20 ms. Use another tool, reduce the scope, or increase the tool timeout.",
		);
		expect(agent.state.messages.at(-1)?.role).toBe("assistant");
		expect(agent.state.toolFailureGuard.tools[0]).toMatchObject({ name: "unstable", status: "open" });
	});

	it("does not count user cancellation as a tool failure", async () => {
		let agent: Agent;
		const unstable = unstableTool(
			(signal) =>
				new Promise<string>((_resolve, reject) => {
					queueMicrotask(() => agent.abort());
					signal?.addEventListener("abort", () => reject(new Error("request aborted with internal detail")), {
						once: true,
					});
				}),
		);
		agent = new Agent({
			initialState: { tools: [unstable.tool] },
			streamFn: sequenceStream([{ message: toolCall("call-1", "cancel") }]),
			repeatedToolFailureLimit: 0,
			toolConsecutiveFailureLimit: 1,
			toolFailureCooldownMs: 30_000,
		});

		await agent.prompt("inspect");

		expect(agent.state.toolFailureGuard.tools).toEqual([]);
		const result = agent.state.messages.find((message) => message.role === "toolResult");
		expect(result?.role === "toolResult" ? result.content[0] : undefined).toEqual({
			type: "text",
			text: "Operation cancelled by the user.",
		});
	});

	it("observes a rejection that arrives after the timeout", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown): void => {
			unhandled.push(error);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const unstable = unstableTool(
				() =>
					new Promise<string>((_resolve, reject) => {
						setTimeout(() => reject(new Error("late rejection")), 40);
					}),
			);
			const agent = new Agent({
				initialState: { tools: [unstable.tool] },
				streamFn: sequenceStream([{ message: toolCall("call-1", "slow") }, { message: finalMessage() }]),
				repeatedToolFailureLimit: 0,
				toolConsecutiveFailureLimit: 1,
				toolFailureCooldownMs: 30_000,
				toolExecutionTimeoutMs: 10,
			});

			await agent.prompt("inspect");
			await new Promise<void>((resolve) => setTimeout(resolve, 60));

			expect(unhandled).toEqual([]);
			expect(agent.state.messages.at(-1)?.role).toBe("assistant");
		} finally {
			process.removeListener("unhandledRejection", onUnhandled);
		}
	});

	it("redacts secrets and caps thrown error text", async () => {
		const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
		const unstable = unstableTool(async () => {
			throw new Error(
				`Bearer top-secret-token https://user:password@example.com OPENAI_API_KEY=${secret} ${"x".repeat(2_000)}`,
			);
		});
		const events: AgentEvent[] = [];
		const agent = new Agent({
			initialState: { tools: [unstable.tool] },
			streamFn: sequenceStream([{ message: toolCall("call-1", "secret") }, { message: finalMessage() }]),
			repeatedToolFailureLimit: 0,
			toolConsecutiveFailureLimit: 0,
		});
		agent.subscribe((event) => {
			events.push(event);
		});

		await agent.prompt("inspect");

		const text = resultTexts(events)[0] ?? "";
		expect(text).not.toContain("top-secret-token");
		expect(text).not.toContain(secret);
		expect(text).not.toContain("password@example.com");
		expect(Array.from(text).length).toBeLessThanOrEqual(800);
		expect(text).toContain("[redacted]");
	});

	it("starts every new user prompt with a clean circuit", async () => {
		const unstable = unstableTool(async () => {
			throw new Error("offline");
		});
		const agent = new Agent({
			initialState: { tools: [unstable.tool] },
			streamFn: sequenceStream([
				{ message: toolCall("call-1", "first") },
				{ message: finalMessage("first done") },
				{ message: toolCall("call-2", "second") },
				{ message: finalMessage("second done") },
			]),
			repeatedToolFailureLimit: 0,
			toolConsecutiveFailureLimit: 1,
			toolFailureCooldownMs: 30_000,
		});

		await agent.prompt("first");
		await agent.prompt("second");

		expect(unstable.executions()).toBe(2);
	});
});
