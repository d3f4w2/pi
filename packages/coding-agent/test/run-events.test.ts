import { describe, expect, it } from "vitest";
import { RunEventAccumulator } from "../src/cli/run-events.ts";

function assistantMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		role: "assistant",
		provider: "openai",
		model: "gpt-5.6",
		content: [{ type: "text", text: "done" }],
		stopReason: "stop",
		usage: {
			input: 100,
			output: 20,
			cacheRead: 80,
			cacheWrite: 5,
			totalTokens: 205,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.001, total: 0.034 },
		},
		...overrides,
	};
}

describe("pigo run JSON event accumulator", () => {
	it("ignores the session header and aggregates bounded execution evidence", () => {
		const accumulator = new RunEventAccumulator();
		expect(accumulator.consumeLine('{"type":"session","version":3}')).toBe("ok");
		accumulator.consumeLine(
			'{"type":"tool_execution_start","toolCallId":"1","toolName":"read","args":{"path":"secret.ts"}}',
		);
		accumulator.consumeLine(
			'{"type":"tool_execution_end","toolCallId":"1","toolName":"read","result":{"content":"private"},"isError":false}',
		);
		accumulator.consumeLine(
			'{"type":"tool_execution_start","toolCallId":"2","toolName":"edit","args":{"path":"secret.ts"}}',
		);
		accumulator.consumeLine(
			'{"type":"tool_execution_end","toolCallId":"2","toolName":"edit","result":{"content":"private"},"isError":true}',
		);
		accumulator.consumeLine(JSON.stringify({ type: "message_end", message: assistantMessage() }));
		accumulator.consumeLine(JSON.stringify({ type: "turn_end", message: assistantMessage(), toolResults: [] }));
		accumulator.consumeLine('{"type":"agent_end","messages":[]}');

		expect(accumulator.summary()).toEqual({
			turns: 1,
			toolCalls: { edit: 1, read: 1 },
			toolErrors: 1,
			usage: {
				inputTokens: 100,
				outputTokens: 20,
				cacheReadTokens: 80,
				cacheWriteTokens: 5,
				totalTokens: 205,
				cost: 0.034,
			},
			model: { provider: "openai", id: "gpt-5.6" },
			finalResponse: "done",
			protocolErrors: 0,
			agentEnded: true,
			agentFailed: false,
		});
	});

	it("sums usage once per completed assistant turn", () => {
		const accumulator = new RunEventAccumulator();
		const first = assistantMessage({ content: [{ type: "toolCall", id: "1", name: "read", arguments: {} }] });
		const second = assistantMessage({
			usage: {
				input: 100,
				output: 20,
				cacheRead: 80,
				cacheWrite: 5,
				totalTokens: 50,
				cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.001, total: 0.034 },
			},
		});
		accumulator.consumeLine(JSON.stringify({ type: "message_end", message: first }));
		accumulator.consumeLine(JSON.stringify({ type: "turn_end", message: first, toolResults: [] }));
		accumulator.consumeLine(JSON.stringify({ type: "message_end", message: second }));
		accumulator.consumeLine(JSON.stringify({ type: "turn_end", message: second, toolResults: [] }));

		expect(accumulator.summary().turns).toBe(2);
		expect(accumulator.summary().usage.totalTokens).toBe(255);
		expect(accumulator.summary().finalResponse).toBe("done");
	});

	it("marks provider errors without storing their raw message", () => {
		const accumulator = new RunEventAccumulator();
		accumulator.consumeLine(
			JSON.stringify({
				type: "message_end",
				message: assistantMessage({ stopReason: "error", errorMessage: "secret provider credential" }),
			}),
		);

		expect(accumulator.summary().agentFailed).toBe(true);
		expect(JSON.stringify(accumulator.summary())).not.toContain("secret provider credential");
	});

	it("reports malformed protocol lines and never stores them", () => {
		const accumulator = new RunEventAccumulator();

		expect(accumulator.consumeLine("extension printed a secret")).toBe("protocol_error");
		expect(accumulator.summary().protocolErrors).toBe(1);
		expect(JSON.stringify(accumulator.summary())).not.toContain("extension printed a secret");
	});

	it("exposes budget breaches immediately after counted evidence", () => {
		const accumulator = new RunEventAccumulator();
		accumulator.consumeLine('{"type":"tool_execution_start","toolCallId":"1","toolName":"read","args":{}}');
		accumulator.consumeLine('{"type":"tool_execution_start","toolCallId":"2","toolName":"read","args":{}}');
		expect(accumulator.exceededBudget({ maxToolCalls: 1, maxTokens: 1_000 })).toBe("tool_budget");

		const tokenAccumulator = new RunEventAccumulator();
		tokenAccumulator.consumeLine(JSON.stringify({ type: "turn_end", message: assistantMessage(), toolResults: [] }));
		expect(tokenAccumulator.exceededBudget({ maxToolCalls: 10, maxTokens: 200 })).toBe("token_budget");
	});
});
