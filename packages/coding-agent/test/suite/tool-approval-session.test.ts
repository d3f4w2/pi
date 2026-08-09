import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionUIContext } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "./harness.ts";

const ECHO_PARAMETERS = Type.Object({ text: Type.String() });

function echoTool(execute: () => void): AgentTool<typeof ECHO_PARAMETERS> {
	return {
		name: "echo",
		label: "Echo",
		description: "Echo text",
		parameters: ECHO_PARAMETERS,
		approval: "exec",
		execute: async (_id, args) => {
			execute();
			return { content: [{ type: "text", text: args.text }], details: {} };
		},
	};
}

describe("AgentSession tool approval", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("fails closed when a headless session requires confirmation", async () => {
		let executions = 0;
		const harness = await createHarness({
			tools: [echoTool(() => executions++)],
			settings: { tools: { approvalMode: "write" } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run");

		expect(executions).toBe(0);
		const result = harness.session.messages.find((message) => message.role === "toolResult");
		expect(result?.role === "toolResult" ? result.content[0] : undefined).toMatchObject({
			type: "text",
			text: expect.stringContaining("没有可用的确认界面"),
		});
	});

	it("can remember one exact operation for the active session", async () => {
		let executions = 0;
		const select = vi.fn(async () => "本次会话允许相同操作");
		const harness = await createHarness({
			tools: [echoTool(() => executions++)],
			settings: { tools: { approvalMode: "always-ask" } },
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			mode: "tui",
			uiContext: { select } as unknown as ExtensionUIContext,
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "same" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("echo", { text: "same" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run twice");

		expect(executions).toBe(2);
		expect(select).toHaveBeenCalledTimes(1);
	});

	it("persists an always-allow decision for the tool", async () => {
		let executions = 0;
		const select = vi.fn(async () => "始终允许此工具");
		const harness = await createHarness({
			tools: [echoTool(() => executions++)],
			settings: { tools: { approvalMode: "always-ask" } },
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			mode: "tui",
			uiContext: { select } as unknown as ExtensionUIContext,
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "first" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("echo", { text: "second" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run twice");

		expect(executions).toBe(2);
		expect(select).toHaveBeenCalledTimes(1);
		expect(harness.settingsManager.getToolApprovalSettings().policies.echo).toBe("allow");
	});

	it("persists an always-deny decision for the tool", async () => {
		let executions = 0;
		const select = vi.fn(async () => "始终禁止此工具");
		const harness = await createHarness({
			tools: [echoTool(() => executions++)],
			settings: { tools: { approvalMode: "always-ask" } },
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			mode: "tui",
			uiContext: { select } as unknown as ExtensionUIContext,
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "first" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("echo", { text: "second" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run twice");

		expect(executions).toBe(0);
		expect(select).toHaveBeenCalledTimes(1);
		expect(harness.settingsManager.getToolApprovalSettings().policies.echo).toBe("deny");
	});
});
