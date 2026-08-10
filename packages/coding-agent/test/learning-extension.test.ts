import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryAuthStorageBackend } from "../src/core/auth-storage.ts";
import type { EventBus } from "../src/core/event-bus.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import type { AgentEvalResult } from "../src/extensions/evals/types.ts";
import { createLearningExtension } from "../src/extensions/learning/index.ts";
import { EvolutionStore } from "../src/extensions/learning/storage.ts";
import { resolveProjectMemoryScope } from "../src/extensions/memory/evidence.ts";
import { RUN_METRICS_RECORDED_EVENT, type RunRecord } from "../src/extensions/run-metrics/types.ts";
import { setLanguageSetting } from "../src/modes/interactive/i18n/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

interface LearningHarness {
	tool: ToolDefinition;
	context: ExtensionContext;
	activeTools: () => string[];
	sentMessages: string[];
	notifications: string[];
	emitMetric(record: RunRecord): void;
	sessionStart(): Promise<void>;
	agentStart(): Promise<void>;
	agentEnd(): Promise<void>;
	agentSettled(): Promise<void>;
	beforeAgentStart(prompt: string): Promise<unknown>;
	toolCall(toolName: string): Promise<unknown>;
}

function failedRun(id: string): RunRecord {
	return {
		version: 2,
		id,
		startedAt: "2026-08-10T00:00:00.000Z",
		durationMs: 100,
		turns: 2,
		retries: 1,
		taskKind: "read_only",
		outcome: "failed",
		tools: { grep: { calls: 1, errors: 1, errorFingerprints: ["c".repeat(64)] } },
		usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: 0 },
		evidence: { verification: "not_needed", checks: 0 },
	};
}

function evalResult(id: string): AgentEvalResult {
	return {
		version: 1,
		id,
		caseId: "navigation-find-definition",
		title: "找到真实定义",
		category: "navigation",
		createdAt: "2026-08-10T00:00:00.000Z",
		provider: "test-provider",
		model: "test-model",
		thinkingLevel: "medium",
		passed: true,
		verificationPassed: true,
		budgetPassed: true,
		timedOut: false,
		durationMs: 100,
		totalTokens: 100,
		outputTokens: 20,
		toolCalls: 1,
		toolErrors: 0,
	};
}

function createHarness(cwd: string, store: EvolutionStore): LearningHarness {
	setLanguageSetting("zh-CN");
	const tools: ToolDefinition[] = [];
	const extensionHandlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const eventHandlers = new Map<string, (data: unknown) => void>();
	const sentMessages: string[] = [];
	const notifications: string[] = [];
	let activeTools = ["read", "grep"];
	const events: EventBus = {
		emit: (channel, data) => eventHandlers.get(channel)?.(data),
		on: (channel, handler) => {
			eventHandlers.set(channel, handler);
			return () => eventHandlers.delete(channel);
		},
	};
	const context = {
		cwd,
		hasUI: true,
		mode: "tui",
		sessionManager: {},
		ui: {
			select: async (_title: string, options: string[]) => options[0],
			confirm: async () => true,
			notify: (message: string) => notifications.push(message),
		},
	} as unknown as ExtensionContext;
	const api = {
		registerTool: (tool: ToolDefinition) => tools.push(tool),
		registerCommand: () => {},
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
			extensionHandlers.set(event, handler),
		events,
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => {
			activeTools = [...names];
		},
		sendUserMessage: (content: string | Array<{ type: string; text?: string }>) => {
			sentMessages.push(typeof content === "string" ? content : content.map((item) => item.text ?? "").join(""));
		},
	} as unknown as ExtensionAPI;
	createLearningExtension(
		store,
		{ run: async () => Promise.reject(new Error("runner should not be called")) },
		{ append: async () => {}, read: async () => [] },
	)(api);
	const tool = tools[0];
	if (!tool) throw new Error("learning tool was not registered");
	const invoke = async (name: string, event: unknown): Promise<unknown> => {
		const handler = extensionHandlers.get(name);
		if (!handler) throw new Error(`missing ${name} handler`);
		return handler(event, context);
	};
	return {
		tool,
		context,
		activeTools: () => [...activeTools],
		sentMessages,
		notifications,
		emitMetric: (record) => events.emit(RUN_METRICS_RECORDED_EVENT, record),
		sessionStart: async () => {
			await invoke("session_start", { type: "session_start", reason: "startup" });
		},
		agentStart: async () => {
			await invoke("agent_start", { type: "agent_start" });
		},
		agentEnd: async () => {
			await invoke("agent_end", { type: "agent_end", messages: [] });
		},
		agentSettled: async () => {
			await invoke("agent_settled", { type: "agent_settled" });
		},
		beforeAgentStart: (prompt) =>
			invoke("before_agent_start", {
				type: "before_agent_start",
				prompt,
				systemPrompt: "system",
				systemPromptOptions: {},
			}),
		toolCall: (toolName) => invoke("tool_call", { type: "tool_call", toolName }),
	};
}

describe("controlled self-evolution extension", () => {
	it("asks only after a repeated signal and keeps the generation grant isolated", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "pi-learning-extension-"));
		temporaryDirectories.push(root);
		const store = new EvolutionStore(new InMemoryAuthStorageBackend());
		const harness = createHarness(root, store);
		await harness.sessionStart();

		harness.emitMetric(failedRun("run-1"));
		await harness.agentSettled();
		expect(harness.sentMessages).toEqual([]);

		harness.emitMetric(failedRun("run-2"));
		await harness.agentSettled();
		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.activeTools()).toContain("improvement_candidate");
		const grantId = /grantId：([^\n]+)/u.exec(harness.sentMessages[0] ?? "")?.[1];
		if (!grantId) throw new Error("generation grant id missing");

		await harness.agentStart();
		expect(await harness.toolCall("read")).toMatchObject({ block: true });
		const result = await harness.tool.execute(
			"candidate",
			{
				grantId,
				title: "优先使用专用搜索",
				problem: "相同的终端搜索错误重复出现。",
				hypothesis: "专用搜索不依赖终端兼容性。",
				kind: "strategy",
				instruction: "需要精确找代码时，先使用专用 grep。",
				triggerTerms: ["找代码", "搜索"],
				expectedEffect: "减少终端搜索失败和重试。",
				risk: "不适用于需要执行程序的任务。",
				evalCaseId: "navigation-find-definition",
			},
			undefined,
			undefined,
			harness.context,
		);
		expect(result.details).toMatchObject({ status: "proposed" });
		expect(harness.activeTools()).not.toContain("improvement_candidate");
		expect(await harness.toolCall("read")).toMatchObject({ block: true });
		await harness.agentEnd();
		expect(await harness.toolCall("read")).toBeUndefined();
		const scope = { projectId: resolveProjectMemoryScope(root).projectId };
		const candidate = (await store.snapshot(scope)).candidates[0];
		if (!candidate) throw new Error("candidate was not saved");
		await store.saveEvaluation(
			candidate.id,
			candidate.digest,
			evalResult("baseline"),
			evalResult("candidate"),
			scope,
		);
		await store.startCanary(candidate.id, candidate.digest, scope);

		const canaryHarness = createHarness(root, store);
		await canaryHarness.sessionStart();
		expect(await canaryHarness.beforeAgentStart("帮我找代码")).toMatchObject({
			systemPrompt: expect.stringContaining("先使用专用 grep"),
		});
		expect(await canaryHarness.toolCall("bash")).toMatchObject({ block: true });
		expect(await canaryHarness.toolCall("read")).toBeUndefined();
	});
});
