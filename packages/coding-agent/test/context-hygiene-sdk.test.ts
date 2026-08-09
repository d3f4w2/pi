import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function exchange(
	id: string,
	name: string,
	args: Record<string, unknown>,
	output: string,
	timestamp: number,
): AgentMessage[] {
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: ZERO_USAGE,
		stopReason: "toolUse",
		timestamp,
	};
	const result: ToolResultMessage<unknown> = {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text: output }],
		isError: false,
		timestamp: timestamp + 1,
	};
	return [assistant, result];
}

function messageText(message: AgentMessage): string {
	if (message.role !== "toolResult") return "";
	return message.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

describe("SDK context hygiene", () => {
	const sessions: Array<{ dispose(): void }> = [];

	afterEach(() => {
		while (sessions.length > 0) sessions.pop()?.dispose();
	});

	it("runs after extension transforms and keeps session history unchanged", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("test model unavailable");
		const settingsManager = SettingsManager.inMemory({
			contextPruning: {
				protectRecentTokens: 600,
				minimumSavingsTokens: 1,
				minimumResultTokens: 1,
				previewCharacters: 16,
			},
		});
		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				pi.on("context", async (event) => ({
					messages: event.messages.map((message) =>
						message.role === "toolResult" && message.toolCallId === "old"
							? { ...message, content: [{ type: "text", text: `extension-${"x".repeat(8_000)}` }] }
							: message,
					),
				}));
			},
		]);
		const sessionManager = SessionManager.inMemory(process.cwd());
		const { session } = await createAgentSession({
			model,
			settingsManager,
			sessionManager,
			resourceLoader: createTestResourceLoader({ extensionsResult }),
		});
		sessions.push(session);
		const messages = [
			...exchange("old", "bash", { command: "inspect" }, "original-small", 1),
			...exchange("recent", "read", { path: "current.ts" }, "r".repeat(2_000), 3),
		];
		session.agent.state.messages = messages;

		const transformed = await session.agent.transformContext?.(session.messages);
		if (!transformed) throw new Error("context transform unavailable");

		expect(messageText(transformed[1]!)).toContain("Earlier bash output compacted");
		expect(messageText(transformed[1]!)).toContain("extension-");
		expect(messageText(session.messages[1]!)).toBe("original-small");
		expect(session.messages).toEqual(messages);
	});

	it("removes a stale read only from the provider-visible context", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("test model unavailable");
		const settingsManager = SettingsManager.inMemory({
			contextPruning: {
				protectRecentTokens: 100_000,
				minimumSavingsTokens: 1,
				minimumResultTokens: 1,
			},
		});
		const { session } = await createAgentSession({
			model,
			settingsManager,
			sessionManager: SessionManager.inMemory(process.cwd()),
			resourceLoader: createTestResourceLoader(),
		});
		sessions.push(session);
		const originalRead = `old-source-${"x".repeat(8_000)}`;
		const messages = [
			...exchange("read", "read", { path: "src/app.ts" }, originalRead, 1),
			...exchange("edit", "edit", { path: "src/app.ts", oldText: "old", newText: "new" }, "updated", 3),
		];
		session.agent.state.messages = messages;

		const transformed = await session.agent.transformContext?.(session.messages);
		if (!transformed) throw new Error("context transform unavailable");

		expect(messageText(transformed[1]!)).toContain("modified by a later edit");
		expect(messageText(transformed[3]!)).toBe("updated");
		expect(messageText(session.messages[1]!)).toBe(originalRead);
	});

	it("fails open when custom tool arguments cannot be inspected", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("test model unavailable");
		const { session } = await createAgentSession({
			model,
			settingsManager: SettingsManager.inMemory(),
			sessionManager: SessionManager.inMemory(process.cwd()),
			resourceLoader: createTestResourceLoader(),
		});
		sessions.push(session);
		const hostileArguments: Record<string, unknown> = {};
		Object.defineProperty(hostileArguments, "value", {
			enumerable: true,
			get() {
				throw new Error("custom getter failed");
			},
		});
		const messages = exchange("hostile", "custom", hostileArguments, "original", 1);
		session.agent.state.messages = messages;

		const transformed = await session.agent.transformContext?.(session.messages);

		expect(transformed).toEqual(messages);
		expect(messageText(session.messages[1]!)).toBe("original");
	});
});
