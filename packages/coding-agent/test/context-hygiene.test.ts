import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_CONTEXT_PRUNING_SETTINGS,
	pruneContextToolOutputs,
	resolveContextPruningSettings,
} from "../src/core/context-hygiene.ts";

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantToolCall(
	id: string,
	name: string,
	argumentsValue: Record<string, unknown>,
	timestamp: number,
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: argumentsValue }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: ZERO_USAGE,
		stopReason: "toolUse",
		timestamp,
	};
}

function toolResult(
	id: string,
	name: string,
	content: string | Array<TextContent | ImageContent>,
	timestamp: number,
	isError = false,
): ToolResultMessage<unknown> {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: typeof content === "string" ? [{ type: "text", text: content }] : content,
		isError,
		timestamp,
	};
}

function exchange(
	id: string,
	name: string,
	args: Record<string, unknown>,
	content: string | Array<TextContent | ImageContent>,
	timestamp: number,
	isError = false,
): AgentMessage[] {
	return [assistantToolCall(id, name, args, timestamp), toolResult(id, name, content, timestamp + 1, isError)];
}

function resultText(message: AgentMessage): string {
	if (message.role !== "toolResult") return "";
	return message.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

const AGGRESSIVE_SETTINGS = resolveContextPruningSettings({
	protectRecentTokens: 1,
	minimumSavingsTokens: 1,
	minimumResultTokens: 1,
	previewCharacters: 24,
});

describe("context hygiene", () => {
	it("uses conservative defaults and normalizes unsafe numeric settings", () => {
		expect(resolveContextPruningSettings()).toEqual(DEFAULT_CONTEXT_PRUNING_SETTINGS);
		expect(
			resolveContextPruningSettings({
				protectRecentTokens: -20,
				minimumSavingsTokens: Number.NaN,
				minimumResultTokens: 0,
				previewCharacters: 50_000,
			}),
		).toEqual({
			...DEFAULT_CONTEXT_PRUNING_SETTINGS,
			protectRecentTokens: 0,
			minimumResultTokens: 1,
			previewCharacters: 1_000,
		});
	});

	it("returns the original array when disabled or when savings are below the floor", () => {
		const messages = exchange("old", "bash", { command: "status" }, "small output", 1);
		const disabled = pruneContextToolOutputs(messages, { ...AGGRESSIVE_SETTINGS, enabled: false });
		const belowFloor = pruneContextToolOutputs(messages, {
			...AGGRESSIVE_SETTINGS,
			minimumSavingsTokens: 10_000,
		});

		expect(disabled.messages).toBe(messages);
		expect(belowFloor.messages).toBe(messages);
		expect(disabled.stats.prunedResults).toBe(0);
		expect(belowFloor.stats.prunedResults).toBe(0);
	});

	it("elides an older exact duplicate while keeping the latest result verbatim", () => {
		const oldOutput = `old-${"a".repeat(8_000)}`;
		const newOutput = `new-${"b".repeat(8_000)}`;
		const messages = [
			...exchange("read-1", "read", { path: "src/app.ts", mode: "full" }, oldOutput, 1),
			...exchange("read-2", "read", { mode: "full", path: "src/app.ts" }, newOutput, 3),
		];
		const result = pruneContextToolOutputs(messages, {
			...AGGRESSIVE_SETTINGS,
			protectRecentTokens: 3_000,
		});

		expect(result.messages).not.toBe(messages);
		expect(resultText(result.messages[1]!)).toContain("newer result for the same read request");
		expect(resultText(result.messages[3]!)).toBe(newOutput);
		expect(result.stats.supersededResults).toBe(1);
		expect(result.stats.prunedTokens).toBeGreaterThan(1_000);
		expect(resultText(messages[1]!)).toBe(oldOutput);
	});

	it("does not treat different focused reads as duplicate requests", () => {
		const messages = [
			...exchange("read-1", "read", { path: "src/app.ts", offset: 1, limit: 50 }, "a".repeat(4_000), 1),
			...exchange("read-2", "read", { path: "src/app.ts", offset: 51, limit: 50 }, "b".repeat(4_000), 3),
		];
		const result = pruneContextToolOutputs(messages, {
			...AGGRESSIVE_SETTINGS,
			protectRecentTokens: 10_000,
		});

		expect(result.messages).toBe(messages);
		expect(result.stats.supersededResults).toBe(0);
	});

	it("protects errors, images, instruction resources, skills, and recent output", () => {
		const protectedText = "p".repeat(5_000);
		const messages = [
			...exchange("error", "bash", { command: "fail" }, protectedText, 1, true),
			...exchange(
				"image",
				"read",
				{ path: "diagram.png" },
				[{ type: "image", data: "abc", mimeType: "image/png" }],
				3,
			),
			...exchange("agents", "read", { path: "AGENTS.md" }, protectedText, 5),
			...exchange("skill-read", "read", { path: "skill://security/SKILL.md" }, protectedText, 7),
			...exchange("skill", "skill", { name: "security" }, protectedText, 9),
			...exchange("old", "bash", { command: "old" }, `HEAD-${"x".repeat(8_000)}-TAIL`, 11),
			...exchange("recent", "grep", { pattern: "needle" }, `recent-${"y".repeat(8_000)}`, 13),
		];
		const result = pruneContextToolOutputs(messages, {
			...AGGRESSIVE_SETTINGS,
			protectRecentTokens: 2_100,
		});

		for (const index of [1, 3, 5, 7, 9, 13]) {
			expect(result.messages[index]).toBe(messages[index]);
		}
		expect(resultText(result.messages[11]!)).toContain("Earlier bash output compacted");
		expect(result.stats.prunedResults).toBe(1);
	});

	it("keeps bounded head and tail evidence for unique old output", () => {
		const oldOutput = `HEAD-IMPORTANT-${"x".repeat(10_000)}-TAIL-IMPORTANT`;
		const messages = [
			...exchange("old", "bash", { command: "inspect" }, oldOutput, 1),
			...exchange("recent", "read", { path: "latest.ts" }, "r".repeat(2_000), 3),
		];
		const result = pruneContextToolOutputs(messages, {
			...AGGRESSIVE_SETTINGS,
			protectRecentTokens: 600,
			previewCharacters: 32,
		});
		const compacted = resultText(result.messages[1]!);

		expect(compacted).toContain("HEAD-IMPORTANT");
		expect(compacted).toContain("TAIL-IMPORTANT");
		expect(compacted).toContain("Original remains in session history");
		expect(compacted.length).toBeLessThan(500);
		expect(result.stats.prunedTokens).toBeGreaterThan(2_000);
	});

	it("is deterministic and leaves caller-owned messages untouched", () => {
		const original = `original-${"z".repeat(8_000)}`;
		const messages = [
			...exchange("old", "grep", { pattern: "x", path: "src" }, original, 1),
			...exchange("recent", "read", { path: "now.ts" }, "n".repeat(2_000), 3),
		];

		const first = pruneContextToolOutputs(messages, AGGRESSIVE_SETTINGS);
		const second = pruneContextToolOutputs(messages, AGGRESSIVE_SETTINGS);

		expect(first).toEqual(second);
		expect(resultText(messages[1]!)).toBe(original);
		expect(first.stats.estimatedTokensAfter).toBeLessThan(first.stats.estimatedTokensBefore);
	});
});
