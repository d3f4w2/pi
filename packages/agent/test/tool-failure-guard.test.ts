import { type AssistantMessage, type AssistantMessageEvent, EventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
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

function toolCall(id: string, args: Record<string, unknown>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "probe", arguments: args }],
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

function sequenceStream(messages: AssistantMessage[]): { streamFn: StreamFn; calls: () => number } {
	let index = 0;
	return {
		streamFn: () => {
			const message = messages[index++];
			if (!message) throw new Error(`Unexpected provider call ${index}`);
			const reason =
				message.stopReason === "toolUse" || message.stopReason === "length" || message.stopReason === "deferred"
					? message.stopReason
					: "stop";
			const stream = new MockAssistantStream();
			queueMicrotask(() => stream.push({ type: "done", reason, message }));
			return stream;
		},
		calls: () => index,
	};
}

function resultText(event: AgentEvent): string {
	if (event.type !== "message_end" || event.message.role !== "toolResult") return "";
	return event.message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function createProbeTool(run: (call: number) => string): { tool: AgentTool; executions: () => number } {
	let executions = 0;
	const schema = Type.Object({
		path: Type.String(),
		options: Type.Optional(Type.Record(Type.String(), Type.Number())),
	});
	const tool: AgentTool<typeof schema> = {
		name: "probe",
		label: "Probe",
		description: "Test probe",
		parameters: schema,
		async execute() {
			executions++;
			const outcome = run(executions);
			if (outcome.startsWith("error:")) throw new Error(outcome.slice("error:".length));
			return { content: [{ type: "text", text: outcome }], details: {} };
		},
	};
	return { tool, executions: () => executions };
}

describe("repeated tool failure guard", () => {
	it("blocks the third unchanged call after two identical failures", async () => {
		const probe = createProbeTool(() => "error:ENOENT: missing file");
		const provider = sequenceStream([
			toolCall("call-1", { path: "missing.ts" }),
			toolCall("call-2", { path: "missing.ts" }),
			toolCall("call-3", { path: "missing.ts" }),
			finalMessage(),
		]);
		const events: AgentEvent[] = [];
		const agent = new Agent({
			initialState: { tools: [probe.tool] },
			streamFn: provider.streamFn,
			repeatedToolFailureLimit: 2,
		});
		agent.subscribe((event) => {
			events.push(event);
		});

		await agent.prompt("inspect");

		expect(probe.executions()).toBe(2);
		expect(provider.calls()).toBe(4);
		const results = events.filter((event) => event.type === "message_end" && event.message.role === "toolResult");
		expect(results).toHaveLength(3);
		expect(resultText(results[2]!)).toContain("Repeated tool call blocked");
		expect(resultText(results[2]!)).toContain("ENOENT: missing file");
		expect(events.filter((event) => event.type === "tool_execution_start")).toHaveLength(3);
		expect(events.filter((event) => event.type === "tool_execution_end")).toHaveLength(3);
	});

	it("stops the run when the model ignores the first block instruction", async () => {
		const probe = createProbeTool(() => "error:ENOENT: missing file");
		const provider = sequenceStream([
			toolCall("call-1", { path: "missing.ts" }),
			toolCall("call-2", { path: "missing.ts" }),
			toolCall("call-3", { path: "missing.ts" }),
			toolCall("call-4", { path: "missing.ts" }),
			finalMessage("must not run"),
		]);
		const events: AgentEvent[] = [];
		const agent = new Agent({
			initialState: { tools: [probe.tool] },
			streamFn: provider.streamFn,
			repeatedToolFailureLimit: 2,
		});
		agent.subscribe((event) => {
			events.push(event);
		});

		await agent.prompt("inspect");

		expect(probe.executions()).toBe(2);
		expect(provider.calls()).toBe(4);
		const lastEnd = events.filter((event) => event.type === "tool_execution_end").at(-1);
		expect(lastEnd?.type === "tool_execution_end" ? lastEnd.result.terminate : undefined).toBe(true);
		expect(agent.state.messages.at(-1)?.role).toBe("toolResult");
	});

	it("canonicalizes argument key order but allows changed arguments", async () => {
		const probe = createProbeTool(() => "error:not found");
		const provider = sequenceStream([
			toolCall("call-1", { path: "a.ts", options: { z: 2, a: 1 } }),
			toolCall("call-2", { options: { a: 1, z: 2 }, path: "a.ts" }),
			toolCall("call-3", { path: "b.ts", options: { a: 1, z: 2 } }),
			toolCall("call-4", { path: "a.ts", options: { a: 1, z: 2 } }),
			finalMessage(),
		]);
		const agent = new Agent({
			initialState: { tools: [probe.tool] },
			streamFn: provider.streamFn,
			repeatedToolFailureLimit: 2,
		});

		await agent.prompt("inspect");

		expect(probe.executions()).toBe(3);
		const lastToolResult = agent.state.messages.filter((message) => message.role === "toolResult").at(-1);
		expect(lastToolResult?.role === "toolResult" ? lastToolResult.content[0] : undefined).toMatchObject({
			type: "text",
			text: expect.stringContaining("Repeated tool call blocked"),
		});
	});

	it("requires the same error text before blocking", async () => {
		const outcomes = ["error:first", "error:second", "error:second"];
		const probe = createProbeTool((call) => outcomes[call - 1] ?? "error:second");
		const provider = sequenceStream([
			toolCall("call-1", { path: "same.ts" }),
			toolCall("call-2", { path: "same.ts" }),
			toolCall("call-3", { path: "same.ts" }),
			toolCall("call-4", { path: "same.ts" }),
			finalMessage(),
		]);
		const agent = new Agent({
			initialState: { tools: [probe.tool] },
			streamFn: provider.streamFn,
			repeatedToolFailureLimit: 2,
		});

		await agent.prompt("inspect");

		expect(probe.executions()).toBe(3);
	});

	it("clears prior failures after a successful execution", async () => {
		const outcomes = ["error:failed", "ok", "error:failed", "error:failed"];
		const probe = createProbeTool((call) => outcomes[call - 1] ?? "error:failed");
		const provider = sequenceStream([
			toolCall("call-1", { path: "same.ts" }),
			toolCall("call-2", { path: "same.ts" }),
			toolCall("call-3", { path: "same.ts" }),
			toolCall("call-4", { path: "same.ts" }),
			toolCall("call-5", { path: "same.ts" }),
			finalMessage(),
		]);
		const agent = new Agent({
			initialState: { tools: [probe.tool] },
			streamFn: provider.streamFn,
			repeatedToolFailureLimit: 2,
		});

		await agent.prompt("inspect");

		expect(probe.executions()).toBe(4);
	});

	it("stays disabled when the limit is zero", async () => {
		const probe = createProbeTool(() => "error:failed");
		const provider = sequenceStream([
			toolCall("call-1", { path: "same.ts" }),
			toolCall("call-2", { path: "same.ts" }),
			toolCall("call-3", { path: "same.ts" }),
			finalMessage(),
		]);
		const agent = new Agent({
			initialState: { tools: [probe.tool] },
			streamFn: provider.streamFn,
			repeatedToolFailureLimit: 0,
		});

		await agent.prompt("inspect");

		expect(probe.executions()).toBe(3);
	});

	it("applies in sequential execution mode", async () => {
		const probe = createProbeTool(() => "error:failed");
		const provider = sequenceStream([
			toolCall("call-1", { path: "same.ts" }),
			toolCall("call-2", { path: "same.ts" }),
			finalMessage(),
		]);
		const agent = new Agent({
			initialState: { tools: [probe.tool] },
			streamFn: provider.streamFn,
			toolExecution: "sequential",
			repeatedToolFailureLimit: 1,
		});

		await agent.prompt("inspect");

		expect(probe.executions()).toBe(1);
	});

	it("does not count aborted or cancelled outcomes", async () => {
		const probe = createProbeTool(() => "error:Operation aborted");
		const provider = sequenceStream([
			toolCall("call-1", { path: "same.ts" }),
			toolCall("call-2", { path: "same.ts" }),
			toolCall("call-3", { path: "same.ts" }),
			finalMessage(),
		]);
		const agent = new Agent({
			initialState: { tools: [probe.tool] },
			streamFn: provider.streamFn,
			repeatedToolFailureLimit: 1,
		});

		await agent.prompt("inspect");

		expect(probe.executions()).toBe(3);
	});

	it("fails open when arguments exceed the fingerprint budget", async () => {
		const path = "x".repeat(20_000);
		const probe = createProbeTool(() => "error:failed");
		const provider = sequenceStream([
			toolCall("call-1", { path }),
			toolCall("call-2", { path }),
			toolCall("call-3", { path }),
			finalMessage(),
		]);
		const agent = new Agent({
			initialState: { tools: [probe.tool] },
			streamFn: provider.streamFn,
			repeatedToolFailureLimit: 1,
		});

		await agent.prompt("inspect");

		expect(probe.executions()).toBe(3);
	});

	it("starts clean for a new prompt", async () => {
		const probe = createProbeTool(() => "error:failed");
		const provider = sequenceStream([
			toolCall("call-1", { path: "same.ts" }),
			toolCall("call-2", { path: "same.ts" }),
			finalMessage("first done"),
			toolCall("call-3", { path: "same.ts" }),
			finalMessage("second done"),
		]);
		const agent = new Agent({
			initialState: { tools: [probe.tool] },
			streamFn: provider.streamFn,
			repeatedToolFailureLimit: 2,
		});

		await agent.prompt("first");
		await agent.prompt("second");

		expect(probe.executions()).toBe(3);
	});

	it("resets when queued user input starts another turn in the same run", async () => {
		const probe = createProbeTool(() => "error:failed");
		const provider = sequenceStream([
			toolCall("call-1", { path: "same.ts" }),
			toolCall("call-2", { path: "same.ts" }),
			finalMessage("first done"),
			toolCall("call-3", { path: "same.ts" }),
			finalMessage("follow-up done"),
		]);
		const agent = new Agent({
			initialState: { tools: [probe.tool] },
			streamFn: provider.streamFn,
			repeatedToolFailureLimit: 2,
		});
		agent.followUp({ role: "user", content: "try again", timestamp: Date.now() });

		await agent.prompt("first");

		expect(probe.executions()).toBe(3);
	});
});
