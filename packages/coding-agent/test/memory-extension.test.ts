import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryAuthStorageBackend } from "../src/core/auth-storage.ts";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolDefinition,
} from "../src/core/extensions/types.ts";
import { resolveProjectMemoryScope } from "../src/extensions/memory/evidence.ts";
import { createMemoryExtension } from "../src/extensions/memory/index.ts";
import { MemoryStore } from "../src/extensions/memory/storage.ts";
import { setLanguageSetting } from "../src/modes/interactive/i18n/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

interface Harness {
	tool: ToolDefinition;
	context: ExtensionContext;
	command: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	beforeAgentStart: (
		event: BeforeAgentStartEvent,
		ctx: ExtensionContext,
	) => Promise<BeforeAgentStartEventResult | undefined>;
	agentStart: () => Promise<void>;
	agentSettled: () => Promise<void>;
	notifications: string[];
}

function createHarness(cwd: string, store: MemoryStore, isEnabled: () => Promise<boolean> = async () => true): Harness {
	setLanguageSetting("zh-CN");
	const tools: ToolDefinition[] = [];
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const notifications: string[] = [];
	let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
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
		registerCommand: (
			_name: string,
			options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
		) => {
			command = options.handler;
		},
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
	} as unknown as ExtensionAPI;
	createMemoryExtension(store, isEnabled)(api);
	const beforeAgentStart = handlers.get("before_agent_start");
	const agentStart = handlers.get("agent_start");
	const agentSettled = handlers.get("agent_settled");
	if (!command || !beforeAgentStart || !agentStart || !agentSettled || !tools[0]) {
		throw new Error("memory extension registration failed");
	}
	return {
		tool: tools[0],
		context,
		command,
		beforeAgentStart: async (event, ctx) =>
			(await beforeAgentStart(event, ctx)) as BeforeAgentStartEventResult | undefined,
		agentStart: async () => {
			await agentStart({ type: "agent_start" }, context);
		},
		agentSettled: async () => {
			await agentSettled({ type: "agent_settled" }, context);
		},
		notifications,
	};
}

function beforeEvent(prompt: string): BeforeAgentStartEvent {
	return {
		type: "before_agent_start",
		prompt,
		systemPrompt: "system",
		systemPromptOptions: {} as never,
	};
}

function projectParams(operation: "remember" | "propose") {
	return {
		operation,
		kind: "project",
		claim: { subject: "project", predicate: "check_command", value: "npm run check" },
		content: "提交前运行 npm run check。",
		evidence: [{ path: "AGENTS.md", quote: "Run npm run check before commit." }],
	};
}

describe("evidence learning memory extension", () => {
	it("keeps the memory protocol always visible to the main agent", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-memory-extension-"));
		temporaryDirectories.push(root);
		const harness = createHarness(root, new MemoryStore(new InMemoryAuthStorageBackend()));
		expect(harness.tool.discovery).toBeUndefined();
		expect(harness.tool.promptGuidelines?.join("\n")).toContain("没有成功回执时绝不能说已经记住");
	});

	it("returns a durable receipt for explicit user memory", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-memory-extension-"));
		temporaryDirectories.push(root);
		const store = new MemoryStore(new InMemoryAuthStorageBackend());
		const harness = createHarness(root, store);
		const result = await harness.tool.execute(
			"remember",
			{
				operation: "remember",
				kind: "user",
				claim: { subject: "user", predicate: "response_style", value: "concise" },
				content: "回答保持简短。",
			},
			undefined,
			undefined,
			harness.context,
		);
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("记忆已保存并生效") });

		const nextSession = createHarness(root, store);
		const recalled = await nextSession.beforeAgentStart(beforeEvent("解释一下架构"), nextSession.context);
		expect(recalled?.systemPrompt).toContain("回答保持简短");
		expect(recalled?.systemPrompt).toContain("当前用户指令、代码和测试优先");
	});

	it("keeps agent proposals inactive until /memory approval", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-memory-extension-"));
		temporaryDirectories.push(root);
		await writeFile(join(root, "AGENTS.md"), "Run npm run check before commit.\n");
		const store = new MemoryStore(new InMemoryAuthStorageBackend());
		const harness = createHarness(root, store);
		const proposed = await harness.tool.execute(
			"propose",
			projectParams("propose"),
			undefined,
			undefined,
			harness.context,
		);
		expect(proposed.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("批准前不会使用") });
		expect(await harness.beforeAgentStart(beforeEvent("提交前检查什么"), harness.context)).toBeUndefined();

		await harness.command("", harness.context as ExtensionCommandContext);
		const nextSession = createHarness(root, store);
		expect(
			(await nextSession.beforeAgentStart(beforeEvent("提交前检查什么"), nextSession.context))?.systemPrompt,
		).toContain("npm run check");
	});

	it("offers immediate candidate review and limits proposals to one per run", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-memory-extension-"));
		temporaryDirectories.push(root);
		await writeFile(join(root, "AGENTS.md"), "Run npm run check before commit.\n");
		const store = new MemoryStore(new InMemoryAuthStorageBackend());
		const harness = createHarness(root, store);
		await harness.agentStart();
		const proposed = await harness.tool.execute(
			"propose",
			projectParams("propose"),
			undefined,
			undefined,
			harness.context,
		);
		await expect(
			harness.tool.execute("propose-again", projectParams("propose"), undefined, undefined, harness.context),
		).rejects.toThrow("每个任务最多提出一条");
		await harness.agentSettled();
		const proposedId = (proposed.details as { records: Array<{ id: string }> }).records[0]?.id;
		expect(
			(await store.list(resolveProjectMemoryScope(root))).records.find((record) => record.id === proposedId),
		).toMatchObject({ status: "active" });
		expect(harness.notifications).toContain("记忆已批准并生效。");
	});

	it("recalls on demand and records feedback", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-memory-extension-"));
		temporaryDirectories.push(root);
		await writeFile(join(root, "AGENTS.md"), "Run npm run check before commit.\n");
		const store = new MemoryStore(new InMemoryAuthStorageBackend());
		const harness = createHarness(root, store);
		const remembered = await harness.tool.execute(
			"remember",
			projectParams("remember"),
			undefined,
			undefined,
			harness.context,
		);
		const details = remembered.details as { records: Array<{ id: string }> };
		const id = details.records[0]?.id;
		if (!id) throw new Error("missing memory id");
		const recalled = await harness.tool.execute(
			"recall",
			{ operation: "recall", query: "提交代码前执行什么检查" },
			undefined,
			undefined,
			harness.context,
		);
		expect(recalled.content[0]).toMatchObject({ type: "text", text: expect.stringContaining(id) });
		await harness.tool.execute(
			"feedback",
			{ operation: "feedback", memory_ids: [id], outcome: "helpful" },
			undefined,
			undefined,
			harness.context,
		);
		expect((await store.list(resolveProjectMemoryScope(root))).records[0]?.usage.helpfulCount).toBe(1);
	});

	it("forgets recalled memories through the natural-language tool path", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-memory-extension-"));
		temporaryDirectories.push(root);
		const store = new MemoryStore(new InMemoryAuthStorageBackend());
		const harness = createHarness(root, store);
		const remembered = await harness.tool.execute(
			"remember",
			{
				operation: "remember",
				kind: "user",
				claim: { subject: "user", predicate: "response_style", value: "concise" },
				content: "回答保持简短。",
			},
			undefined,
			undefined,
			harness.context,
		);
		const id = (remembered.details as { records: Array<{ id: string }> }).records[0]?.id;
		if (!id) throw new Error("missing memory id");
		const forgotten = await harness.tool.execute(
			"forget",
			{ operation: "forget", memory_ids: [id] },
			undefined,
			undefined,
			harness.context,
		);
		expect(forgotten.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("已彻底删除") });
		expect((await store.list(resolveProjectMemoryScope(root))).records).toEqual([]);
	});

	it("does not inject unrelated project memory and only auto-recalls once per session", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-memory-extension-"));
		temporaryDirectories.push(root);
		await writeFile(join(root, "AGENTS.md"), "Run npm run check before commit.\n");
		const store = new MemoryStore(new InMemoryAuthStorageBackend());
		const harness = createHarness(root, store);
		await harness.tool.execute("remember", projectParams("remember"), undefined, undefined, harness.context);
		const session = createHarness(root, store);
		expect(await session.beforeAgentStart(beforeEvent("数据库迁移"), session.context)).toBeUndefined();
		expect(await session.beforeAgentStart(beforeEvent("提交前检查什么"), session.context)).toBeUndefined();
	});

	it("skips automatic recall when memory is disabled", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-memory-extension-"));
		temporaryDirectories.push(root);
		const store = new MemoryStore(new InMemoryAuthStorageBackend());
		const enabledHarness = createHarness(root, store);
		await enabledHarness.tool.execute(
			"remember",
			{
				operation: "remember",
				kind: "user",
				claim: { subject: "user", predicate: "language", value: "zh-CN" },
				content: "默认使用中文。",
			},
			undefined,
			undefined,
			enabledHarness.context,
		);
		const disabledHarness = createHarness(root, store, async () => false);
		expect(await disabledHarness.beforeAgentStart(beforeEvent("你好"), disabledHarness.context)).toBeUndefined();
	});
});
