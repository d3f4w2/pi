import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionCommandContextActions, ExtensionUIContext } from "../../src/core/extensions/types.ts";
import { createContextLifecycleExtension } from "../../src/extensions/context/index.ts";
import { ContextLifecycleService } from "../../src/extensions/context/service.ts";
import {
	CONTEXT_ACTIVE_VIEW_TYPE,
	type ContextActiveViewData,
	type ContextWorkspaceSnapshot,
} from "../../src/extensions/context/types.ts";
import { createToolsExtension } from "../../src/extensions/tools/index.ts";
import type { ToolPreferencesStore } from "../../src/extensions/tools/storage.ts";
import { createHarness, type Harness } from "./harness.ts";

const workspace = {
	available: true,
	branch: "codex/context-lifecycle",
	staged: 0,
	modified: 0,
	untracked: 0,
	conflicts: 0,
	paths: [],
	statusDigest: "faux-workspace",
	summary: "clean",
} satisfies ContextWorkspaceSnapshot;

const SEARCH_PARAMETERS = Type.Object({ query: Type.String() });

function createUi(notifications: string[], confirm = true): ExtensionUIContext {
	return {
		confirm: async () => confirm,
		select: async () => undefined,
		input: async () => undefined,
		notify: (message: string) => notifications.push(message),
	} as unknown as ExtensionUIContext;
}

function commandActions(harness: Harness): ExtensionCommandContextActions {
	return {
		waitForIdle: () => harness.session.waitForIdle(),
		newSession: async () => ({ cancelled: true }),
		fork: async () => ({ cancelled: true }),
		navigateTree: (targetId, options) => harness.session.navigateTree(targetId, options),
		switchSession: async () => ({ cancelled: true }),
		reload: async () => {},
	};
}

async function bindHarness(harness: Harness, notifications: string[], confirm = true): Promise<void> {
	await harness.session.bindExtensions({
		mode: "tui",
		uiContext: createUi(notifications, confirm),
		commandContextActions: commandActions(harness),
	});
}

const preferences: ToolPreferencesStore = {
	load: async () => ({ enabledTools: [], disabledTools: [] }),
	recordChanges: async () => {},
};

describe("context lifecycle faux-provider long task", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("reduces a long active context by at least 25% and restores it without another model call", async () => {
		const searchTool: AgentTool<typeof SEARCH_PARAMETERS> = {
			name: "local_search",
			label: "Local search",
			description: "Return deterministic local search output",
			parameters: SEARCH_PARAMETERS,
			execute: async (_toolCallId, params) => ({
				content: [
					{
						type: "text",
						text: `No results for ${String(params.query)}. src/generated.ts:42\n${"irrelevant local search output ".repeat(260)}`,
					},
				],
				details: { query: String(params.query) },
			}),
		};
		const service = new ContextLifecycleService({ captureWorkspace: async () => workspace });
		const harness = await createHarness({
			tools: [searchTool],
			initialActiveToolNames: [searchTool.name],
			extensionFactories: [createContextLifecycleExtension(service)],
		});
		harnesses.push(harness);
		const notifications: string[] = [];
		await bindHarness(harness, notifications);
		let providerCalls = 0;
		harness.setResponses([
			() => {
				providerCalls++;
				return fauxAssistantMessage("ready");
			},
		]);
		await harness.session.prompt("Keep this stable prefix before exploration.");
		await harness.session.prompt("/context create long-task-start");
		expect(providerCalls).toBe(1);

		const calls = Array.from({ length: 24 }, (_, index) =>
			fauxToolCall("local_search", { query: `missing-${index}` }, { id: `long-search-${index}` }),
		);
		harness.setResponses([
			() => {
				providerCalls++;
				return fauxAssistantMessage(calls, { stopReason: "toolUse" });
			},
			() => {
				providerCalls++;
				return fauxAssistantMessage(
					"Searches exhausted. TODO: use the evidence instead of repeating identical searches.",
				);
			},
		]);
		await harness.session.prompt(
			"Explore all local searches. New requirement: preserve every failed result and do not write to memory.",
		);
		const originalMessages = structuredClone(harness.session.messages);
		const originalLeafId = harness.sessionManager.getLeafId();
		expect(providerCalls).toBe(3);

		await harness.session.prompt("/context rewind long-task-start");
		expect(providerCalls).toBe(3);
		const viewEntry = [...harness.sessionManager.getEntries()]
			.reverse()
			.find((entry) => entry.type === "custom" && entry.customType === CONTEXT_ACTIVE_VIEW_TYPE);
		expect(viewEntry?.type).toBe("custom");
		const view = viewEntry?.type === "custom" ? (viewEntry.data as ContextActiveViewData) : undefined;
		expect(view?.metrics.tokenReductionPercent).toBeGreaterThanOrEqual(25);
		expect(view?.metrics.deterministicEvidenceRetentionPercent).toBe(100);
		expect(view?.metrics.deterministicEvidenceOmitted).toBe(false);
		expect(view?.metrics.userMessageRetentionPercent).toBe(100);
		expect(view?.metrics.promptCacheReusablePrefixMessages).toBe(2);
		expect(view?.metrics.reportGenerationMs).toBeGreaterThanOrEqual(0);
		expect(harness.session.messages.length).toBeLessThan(originalMessages.length);
		expect(JSON.stringify(harness.session.messages)).toContain("New requirement: preserve every failed result");

		await harness.session.prompt("/context restore");
		expect(providerCalls).toBe(3);
		expect(harness.session.messages).toEqual(originalMessages);
		expect(harness.sessionManager.getEntries().some((entry) => entry.id === originalLeafId)).toBe(true);
		expect(notifications.some((message) => message.includes("上下文操作失败"))).toBe(false);
	});

	it("adds no active provider tool schema or model call when checkpoints are unused", async () => {
		const run = async (includeContext: boolean): Promise<{ calls: number; tools: string[] }> => {
			const factories = [
				createToolsExtension(preferences),
				...(includeContext
					? [
							createContextLifecycleExtension(
								new ContextLifecycleService({ captureWorkspace: async () => workspace }),
							),
						]
					: []),
			];
			const harness = await createHarness({ extensionFactories: factories });
			harnesses.push(harness);
			await bindHarness(harness, []);
			let calls = 0;
			let tools: string[] = [];
			harness.setResponses([
				(context) => {
					calls++;
					tools = (context.tools ?? []).map((tool) => tool.name);
					return fauxAssistantMessage("ok");
				},
			]);
			await harness.session.prompt("ordinary task without checkpoints");
			return { calls, tools };
		};

		const baseline = await run(false);
		const withContext = await run(true);
		expect(withContext.calls).toBe(1);
		expect(withContext.calls).toBe(baseline.calls);
		expect(withContext.tools).toEqual(baseline.tools);
		expect(withContext.tools).not.toContain("context_lifecycle");
	});

	it("keeps the active context unchanged when the user rejects the rewind preview", async () => {
		const service = new ContextLifecycleService({ captureWorkspace: async () => workspace });
		const harness = await createHarness({ extensionFactories: [createContextLifecycleExtension(service)] });
		harnesses.push(harness);
		await bindHarness(harness, [], false);
		let providerCalls = 0;
		harness.setResponses([
			() => {
				providerCalls++;
				return fauxAssistantMessage("checkpoint prefix");
			},
		]);
		await harness.session.prompt("Create a stable prefix.");
		await harness.session.prompt("/context create rejected-preview");
		harness.setResponses([
			() => {
				providerCalls++;
				return fauxAssistantMessage("exploration remains active");
			},
		]);
		await harness.session.prompt("Explore after checkpoint.");
		const originalMessages = structuredClone(harness.session.messages);
		const originalLeafId = harness.sessionManager.getLeafId();
		const originalEntryCount = harness.sessionManager.getEntries().length;

		await harness.session.prompt("/context rewind rejected-preview");

		expect(providerCalls).toBe(2);
		expect(harness.session.messages).toEqual(originalMessages);
		expect(harness.sessionManager.getLeafId()).toBe(originalLeafId);
		expect(harness.sessionManager.getEntries()).toHaveLength(originalEntryCount);
	});
});
