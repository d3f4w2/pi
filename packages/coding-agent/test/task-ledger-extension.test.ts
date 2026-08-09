import { describe, expect, it } from "vitest";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionStartEvent,
	SessionTreeEvent,
	ToolDefinition,
} from "../src/core/extensions/types.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import taskLedgerExtension from "../src/extensions/task-ledger/index.ts";
import { TASK_LEDGER_ENTRY_TYPE } from "../src/extensions/task-ledger/types.ts";

interface Harness {
	tool: ToolDefinition;
	entries: SessionEntry[];
	context: ExtensionContext;
	widgets: Array<string[] | undefined>;
	notifications: string[];
	sessionStart?: (event: SessionStartEvent, ctx: ExtensionContext) => unknown;
	sessionTree?: (event: SessionTreeEvent, ctx: ExtensionContext) => unknown;
	beforeAgentStart?: (event: BeforeAgentStartEvent, ctx: ExtensionContext) => BeforeAgentStartEventResult | undefined;
	command?: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

function createHarness(initialEntries: SessionEntry[] = []): Harness {
	const tools: ToolDefinition[] = [];
	const entries = [...initialEntries];
	const widgets: Array<string[] | undefined> = [];
	const notifications: string[] = [];
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	const context = {
		hasUI: true,
		mode: "tui",
		cwd: "C:/repo",
		ui: {
			setWidget: (_key: string, content: string[] | undefined) => widgets.push(content),
			notify: (message: string) => notifications.push(message),
		},
		sessionManager: { getBranch: () => entries },
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
		appendEntry: (customType: string, data: unknown) => {
			entries.push({
				type: "custom",
				id: `entry-${entries.length + 1}`,
				parentId: entries.at(-1)?.id ?? null,
				timestamp: "2026-08-09T00:00:00.000Z",
				customType,
				data,
			});
		},
	} as unknown as ExtensionAPI;
	taskLedgerExtension(api);
	const sessionStartHandler = handlers.get("session_start");
	const sessionTreeHandler = handlers.get("session_tree");
	const beforeAgentStartHandler = handlers.get("before_agent_start");
	return {
		tool: tools[0] as ToolDefinition,
		entries,
		context,
		widgets,
		notifications,
		...(sessionStartHandler === undefined ? {} : { sessionStart: (event, ctx) => sessionStartHandler(event, ctx) }),
		...(sessionTreeHandler === undefined ? {} : { sessionTree: (event, ctx) => sessionTreeHandler(event, ctx) }),
		...(beforeAgentStartHandler === undefined
			? {}
			: {
					beforeAgentStart: (event, ctx) =>
						beforeAgentStartHandler(event, ctx) as BeforeAgentStartEventResult | undefined,
				}),
		...(command === undefined ? {} : { command }),
	};
}

describe("task ledger extension", () => {
	it("registers todo and persists only successful mutations", async () => {
		const harness = createHarness();
		expect(harness.tool.name).toBe("todo");

		const result = await harness.tool.execute(
			"set",
			{
				operation: "set_plan",
				expected_revision: 0,
				phases: [{ title: "实现", tasks: ["状态机", "扩展"] }],
			},
			undefined,
			undefined,
			harness.context,
		);
		expect(harness.entries).toHaveLength(1);
		expect(harness.entries[0]).toMatchObject({ type: "custom", customType: TASK_LEDGER_ENTRY_TYPE });
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("t1 状态机") });
		expect(harness.widgets.at(-1)?.[0]).toContain("当前 t1 状态机");

		await expect(
			harness.tool.execute(
				"stale",
				{ operation: "start", expected_revision: 0, task_id: "t2" },
				undefined,
				undefined,
				harness.context,
			),
		).rejects.toThrow("当前 revision 为 1");
		expect(harness.entries).toHaveLength(1);
	});

	it("restores widgets and appends bounded non-persistent context", async () => {
		const first = createHarness();
		await first.tool.execute(
			"set",
			{
				operation: "set_plan",
				expected_revision: 0,
				phases: [{ title: "长任务", tasks: Array.from({ length: 30 }, (_, index) => `任务 ${index + 1}`) }],
			},
			undefined,
			undefined,
			first.context,
		);
		const resumed = createHarness(first.entries);
		await resumed.sessionStart?.({ type: "session_start", reason: "resume" }, resumed.context);
		expect(resumed.widgets.at(-1)?.[0]).toContain("当前 t1 任务 1");

		const injected = resumed.beforeAgentStart?.(
			{ type: "before_agent_start", prompt: "继续", systemPrompt: "system", systemPromptOptions: {} as never },
			resumed.context,
		);
		const reminder = injected?.systemPrompt?.slice("system\n\n".length) ?? "";
		expect(injected?.message).toBeUndefined();
		expect(reminder.length).toBeLessThanOrEqual(2400);
		expect(reminder).toContain("t1");
		expect(reminder).not.toContain("t30");
	});

	it("views without writing and exposes the full state through /tasks", async () => {
		const harness = createHarness();
		await harness.tool.execute(
			"set",
			{ operation: "set_plan", expected_revision: 0, phases: [{ title: "验证", tasks: ["运行检查"] }] },
			undefined,
			undefined,
			harness.context,
		);
		const beforeView = harness.entries.length;
		await harness.tool.execute("view", { operation: "view" }, undefined, undefined, harness.context);
		expect(harness.entries).toHaveLength(beforeView);

		await harness.command?.("", harness.context as ExtensionCommandContext);
		expect(harness.notifications.at(-1)).toContain("t1 运行检查");
	});

	it("reloads the selected branch after tree navigation", async () => {
		const harness = createHarness();
		await harness.sessionTree?.({ type: "session_tree", oldLeafId: null, newLeafId: null }, harness.context);
		expect(harness.widgets.at(-1)).toBeUndefined();
	});
});
