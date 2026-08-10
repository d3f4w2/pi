import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryAuthStorageBackend } from "../../src/core/auth-storage.ts";
import type { ExtensionUIContext } from "../../src/core/extensions/types.ts";
import { resolveProjectMemoryScope } from "../../src/extensions/memory/evidence.ts";
import { createMemoryExtension } from "../../src/extensions/memory/index.ts";
import { MemoryStore } from "../../src/extensions/memory/storage.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("memory Agent protocol", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("executes remember through the Agent loop and returns a durable receipt", async () => {
		const store = new MemoryStore(new InMemoryAuthStorageBackend());
		const harness = await createHarness({
			extensionFactories: [createMemoryExtension(store)],
			settings: { tools: { approvalMode: "always-ask" } },
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			mode: "tui",
			uiContext: { select: async () => "本次会话允许相同操作" } as unknown as ExtensionUIContext,
		});
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("memory", {
					operation: "remember",
					kind: "user",
					claim: { subject: "user", predicate: "response_style", value: "concise" },
					content: "回答保持简短。",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("记忆工具已确认保存。"),
		]);

		await harness.session.prompt("以后回答短一点，请记住。");

		const records = (await store.list(resolveProjectMemoryScope(harness.tempDir))).records;
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ status: "active", source: "user" });
		const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
		expect(getMessageText(toolResult)).toContain(records[0]!.id);
		expect(getMessageText(toolResult)).toContain("回答保持简短");
	});
});
