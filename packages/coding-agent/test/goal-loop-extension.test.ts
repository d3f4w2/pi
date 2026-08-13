import { describe, expect, it, vi } from "vitest";
import type { WorkspaceSnapshot } from "../src/cli/run-workspace.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolDefinition,
} from "../src/core/extensions/types.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { createGoalLoopExtension, type GoalLoopDependencies } from "../src/extensions/goal-loop/index.ts";
import { createGoalLoopState, loadLatestGoalLoopState } from "../src/extensions/goal-loop/state.ts";
import { GOAL_LOOP_ENTRY_TYPE } from "../src/extensions/goal-loop/types.ts";
import type { VerifyResult } from "../src/extensions/verify/types.ts";

type EventHandler = (event: never, ctx: ExtensionContext) => unknown;

interface Harness {
	commands: Map<string, (input: string, ctx: ExtensionCommandContext) => Promise<void>>;
	context: ExtensionCommandContext;
	entries: SessionEntry[];
	handlers: Map<string, EventHandler>;
	notifications: Array<{ message: string; level: string }>;
	sentUserMessages: string[];
	tool: ToolDefinition;
	widgets: Array<string[] | undefined>;
	dependencies: GoalLoopDependencies;
	selections: string[];
	inputs: string[];
	idle: { value: boolean };
}

interface HarnessUiOptions {
	selections?: string[];
	inputs?: string[];
	idle?: boolean;
}

function workspaceSnapshot(digest = "a".repeat(64)): WorkspaceSnapshot {
	return {
		root: "C:/repo",
		head: "b".repeat(40),
		digest,
		coverage: "git-tracked-and-unignored",
		index: new Map([["src/main.ts", "100644:blob"]]),
		dirty: new Map(),
	};
}

function passingVerifyResult(): VerifyResult {
	return {
		text: "1 项验证全部通过。",
		details: {
			operation: "auto" as const,
			language: "typescript" as const,
			workspaceRoot: "C:/repo",
			passed: true,
			checks: [{ id: "test" as const, label: "相关测试", status: "passed" as const, durationMs: 10 }],
			truncated: false,
			durationMs: 10,
		},
	};
}

function terminalState(runId: string, receiptPath: string) {
	const state = createGoalLoopState(
		{
			goal: `terminal ${runId}`,
			scope: ["."],
			verification: [{ operation: "auto", path: ".", timeoutSeconds: 60 }],
			budget: { timeoutSeconds: 7200, maxTokens: 400_000, maxToolCalls: 400, maxIterations: 12 },
		},
		{ runId, workspaceRoot: "C:/repo", baselinePath: `C:/state/${runId}.json`, now: "2026-08-12T00:00:00.000Z" },
	);
	state.status = "verified";
	state.receiptPath = receiptPath;
	return state;
}

function createHarness(
	initialEntries: SessionEntry[] = [],
	verifyResult = passingVerifyResult(),
	uiOptions: HarnessUiOptions = {},
): Harness {
	const commands = new Map<string, (input: string, ctx: ExtensionCommandContext) => Promise<void>>();
	const entries = [...initialEntries];
	const handlers = new Map<string, EventHandler>();
	const notifications: Array<{ message: string; level: string }> = [];
	const sentUserMessages: string[] = [];
	const tools: ToolDefinition[] = [];
	const widgets: Array<string[] | undefined> = [];
	const selections = [...(uiOptions.selections ?? [])];
	const inputs = [...(uiOptions.inputs ?? [])];
	const idle = { value: uiOptions.idle ?? true };
	const dependencies: GoalLoopDependencies = {
		now: () => new Date("2026-08-12T00:00:10.000Z"),
		randomUUID: () => "goal-run-12345678",
		getWorkspaceRoot: vi.fn(async () => "C:/repo"),
		takeSnapshot: vi.fn(async () => workspaceSnapshot()),
		readBaseline: vi.fn(async () => workspaceSnapshot()),
		writeBaseline: vi.fn(async () => "C:/agent/goal-runs/goal-run-12345678/baseline.json"),
		verify: vi.fn(async () => verifyResult),
		writeReceipt: vi.fn(async () => "C:/agent/runs/receipt.json"),
		runCi: vi.fn(async () => ({ exitCode: 0, stdout: "Pigo CI gate: PASS\n", stderr: "" })),
	};
	const context = {
		hasUI: true,
		mode: "tui",
		cwd: "C:/repo",
		model: { provider: "openai", id: "gpt-test" },
		isIdle: () => idle.value,
		abort: vi.fn(),
		ui: {
			select: async () => selections.shift(),
			input: async () => inputs.shift(),
			notify: (message: string, level: string) => notifications.push({ message, level }),
			setWidget: (_key: string, content: string[] | undefined) => widgets.push(content),
		},
		sessionManager: { getBranch: () => entries },
	} as unknown as ExtensionCommandContext;
	const api = {
		registerTool: (tool: ToolDefinition) => tools.push(tool),
		registerCommand: (
			name: string,
			options: { handler: (input: string, ctx: ExtensionCommandContext) => Promise<void> },
		) => commands.set(name, options.handler),
		on: (event: string, handler: EventHandler) => handlers.set(event, handler),
		appendEntry: (customType: string, data: unknown) => {
			entries.push({
				type: "custom",
				id: `entry-${entries.length + 1}`,
				parentId: entries.at(-1)?.id ?? null,
				timestamp: "2026-08-12T00:00:10.000Z",
				customType,
				data,
			});
		},
		sendUserMessage: (message: string) => sentUserMessages.push(message),
	} as unknown as ExtensionAPI;
	createGoalLoopExtension(dependencies)(api);
	return {
		commands,
		context,
		entries,
		handlers,
		notifications,
		sentUserMessages,
		tool: tools[0] as ToolDefinition,
		widgets,
		dependencies,
		selections,
		inputs,
		idle,
	};
}

function assistantTurn(text = "done", stopReason = "stop") {
	return {
		type: "turn_end",
		turnIndex: 0,
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			stopReason,
			usage: {
				input: 100,
				output: 50,
				cacheRead: 20,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
		toolResults: [],
	};
}

async function report(harness: Harness, value: Record<string, string>): Promise<void> {
	await harness.tool.execute("report", value, undefined, undefined, harness.context);
}

async function settle(harness: Harness): Promise<void> {
	await harness.handlers.get("turn_end")?.(assistantTurn() as never, harness.context);
	await harness.handlers.get("agent_settled")?.({ type: "agent_settled" } as never, harness.context);
}

describe("goal loop extension", () => {
	it("serializes direct starts so rapid duplicate submission cannot create two goals", async () => {
		let resolveWorkspace: ((value: string) => void) | undefined;
		const workspace = new Promise<string>((resolve) => {
			resolveWorkspace = resolve;
		});
		const harness = createHarness();
		vi.mocked(harness.dependencies.getWorkspaceRoot).mockImplementation(async () => workspace);

		const first = harness.commands.get("run")?.("第一个目标", harness.context);
		await vi.waitFor(() => expect(harness.dependencies.getWorkspaceRoot).toHaveBeenCalledOnce());
		const second = harness.commands.get("run")?.("重复提交的目标", harness.context);
		resolveWorkspace?.("C:/repo");
		await Promise.all([first, second]);

		expect(harness.sentUserMessages).toHaveLength(1);
		expect(loadLatestGoalLoopState(harness.entries)?.goal).toBe("第一个目标");
	});

	it("runs an interactive goal, independently verifies it, and writes a CI-compatible receipt", async () => {
		const harness = createHarness();
		await harness.commands.get("run")?.("--scope src 修复解析器并补测试", harness.context);

		expect(harness.sentUserMessages).toHaveLength(1);
		expect(harness.sentUserMessages[0]).toContain("不可变目标");
		expect(harness.sentUserMessages[0]).toContain("修复解析器并补测试");
		expect(harness.entries.at(-1)).toMatchObject({ customType: GOAL_LOOP_ENTRY_TYPE });

		await report(harness, { status: "complete", summary: "实现和测试已完成" });
		await settle(harness);

		const state = loadLatestGoalLoopState(harness.entries);
		expect(state).toMatchObject({
			status: "verified",
			receiptPath: "C:/agent/runs/receipt.json",
			metrics: { turns: 1, usage: { totalTokens: 150 } },
			model: { provider: "openai", id: "gpt-test" },
		});
		expect(harness.dependencies.verify).toHaveBeenCalledOnce();
		expect(harness.dependencies.readBaseline).toHaveBeenCalledOnce();
		expect(harness.dependencies.writeReceipt).toHaveBeenCalledOnce();
		expect(harness.notifications.at(-1)?.message).toContain("输入 /run 进行独立验收");
	});

	it("feeds a failed independent check into the next turn and stops after unchanged repeated evidence", async () => {
		const failed = passingVerifyResult();
		failed.text = "test/parser.test.ts:20 expected 2 received 1";
		failed.details.passed = false;
		failed.details.checks[0]!.status = "failed";
		const harness = createHarness([], failed);
		await harness.commands.get("run")?.("修复解析器", harness.context);

		await report(harness, { status: "continue", summary: "继续修复", gap: "测试失败" });
		await settle(harness);
		expect(harness.sentUserMessages).toHaveLength(2);
		expect(harness.sentUserMessages[1]).toContain("expected 2 received 1");

		await report(harness, { status: "continue", summary: "再次修复", gap: "测试仍失败" });
		await settle(harness);
		const state = loadLatestGoalLoopState(harness.entries);
		expect(state?.status).toBe("stuck");
		expect(state?.repeatedGapCount).toBe(2);
		expect(harness.dependencies.writeReceipt).not.toHaveBeenCalled();

		vi.mocked(harness.dependencies.verify).mockResolvedValue(passingVerifyResult());
		harness.selections.push("提供决策并继续");
		harness.inputs.push("采用兼容实现");
		await harness.commands.get("run")?.("", harness.context);
		await report(harness, { status: "complete", summary: "兼容实现与测试完成" });
		await settle(harness);
		expect(loadLatestGoalLoopState(harness.entries)?.status).toBe("verified");
		expect(harness.dependencies.writeReceipt).toHaveBeenCalledOnce();
	});

	it("restores an interrupted active checkpoint as explicitly paused", async () => {
		const state = createGoalLoopState(
			{
				goal: "长任务",
				scope: ["."],
				verification: [{ operation: "auto", path: ".", timeoutSeconds: 60 }],
				budget: { timeoutSeconds: 7200, maxTokens: 400_000, maxToolCalls: 400, maxIterations: 12 },
			},
			{
				runId: "interrupted",
				workspaceRoot: "C:/repo",
				baselinePath: "C:/state/baseline.json",
				now: "2026-08-12T00:00:00.000Z",
			},
		);
		const entries = [
			{
				type: "custom",
				id: "entry-1",
				parentId: null,
				timestamp: "2026-08-12T00:00:00.000Z",
				customType: GOAL_LOOP_ENTRY_TYPE,
				data: state,
			},
		] as SessionEntry[];
		const harness = createHarness(entries);
		await harness.handlers.get("session_start")?.(
			{ type: "session_start", reason: "resume" } as never,
			harness.context,
		);

		expect(loadLatestGoalLoopState(harness.entries)).toMatchObject({
			status: "paused",
			reason: expect.stringContaining("显式打开 /run"),
		});
		expect(harness.sentUserMessages).toHaveLength(0);
	});

	it("starts a bounded long-run goal through the bare /run wizard", async () => {
		const harness = createHarness([], passingVerifyResult(), {
			selections: ["开始新目标", "长跑 · 8 小时 · 迁移、重构与跨模块目标"],
			inputs: ["完成跨模块迁移并补齐验证"],
		});

		await harness.commands.get("run")?.("", harness.context);

		expect(loadLatestGoalLoopState(harness.entries)).toMatchObject({
			goal: "完成跨模块迁移并补齐验证",
			status: "running",
			budget: { timeoutSeconds: 28_800, maxTokens: 1_000_000, maxToolCalls: 1_000, maxIterations: 32 },
		});
		expect(harness.sentUserMessages).toHaveLength(1);
	});

	it("cancels the bare /run control center without changing state", async () => {
		const harness = createHarness();
		await harness.commands.get("run")?.("", harness.context);

		expect(harness.entries).toHaveLength(0);
		expect(harness.sentUserMessages).toHaveLength(0);
	});

	it("moves offline receipt acceptance inside /run and registers no internal /ci", async () => {
		const harness = createHarness();
		await harness.commands.get("run")?.("修复解析器", harness.context);
		await report(harness, { status: "complete", summary: "已经完成" });
		await settle(harness);
		harness.selections.push("独立验收回执", "关闭");

		await harness.commands.get("run")?.("", harness.context);

		expect(harness.commands.has("ci")).toBe(false);
		expect(harness.dependencies.runCi).toHaveBeenCalledWith('"C:/agent/runs/receipt.json"', "C:/repo");
		expect(harness.notifications.at(-1)).toEqual({ message: "Pigo CI gate: PASS", level: "info" });
	});

	it("aborts an active Agent turn before persisting a requested pause", async () => {
		const harness = createHarness();
		await harness.commands.get("run")?.("长时间修复", harness.context);
		harness.idle.value = false;
		harness.selections.push("暂停执行");

		await harness.commands.get("run")?.("", harness.context);

		expect(harness.context.abort).toHaveBeenCalledOnce();
		expect(loadLatestGoalLoopState(harness.entries)?.status).toBe("running");

		await harness.handlers.get("turn_end")?.(assistantTurn("paused", "aborted") as never, harness.context);
		expect(loadLatestGoalLoopState(harness.entries)?.status).toBe("paused");
		expect(harness.dependencies.writeReceipt).not.toHaveBeenCalled();
	});

	it("resumes a paused reported turn directly at independent verification", async () => {
		const harness = createHarness();
		await harness.commands.get("run")?.("修复后必须验证", harness.context);
		await report(harness, { status: "continue", summary: "实现已经写完", gap: "等待独立验证" });
		harness.idle.value = false;
		harness.selections.push("暂停执行");
		await harness.commands.get("run")?.("", harness.context);
		await harness.handlers.get("turn_end")?.(assistantTurn("paused", "aborted") as never, harness.context);
		expect(loadLatestGoalLoopState(harness.entries)?.status).toBe("paused");

		harness.idle.value = true;
		harness.selections.push("继续执行");
		await harness.commands.get("run")?.("", harness.context);

		const state = loadLatestGoalLoopState(harness.entries);
		expect(harness.dependencies.verify).toHaveBeenCalledOnce();
		expect(state?.iterations[0]?.verification).toHaveLength(1);
		expect(state).toMatchObject({ status: "running", iteration: 2 });
		expect(harness.sentUserMessages).toHaveLength(2);
	});

	it("aborts an active Agent turn before stopping and writes the receipt only after settlement", async () => {
		const harness = createHarness();
		await harness.commands.get("run")?.("长时间修复", harness.context);
		harness.idle.value = false;
		harness.selections.push("停止并生成回执");

		await harness.commands.get("run")?.("", harness.context);

		expect(harness.context.abort).toHaveBeenCalledOnce();
		expect(loadLatestGoalLoopState(harness.entries)?.status).toBe("running");
		expect(harness.dependencies.writeReceipt).not.toHaveBeenCalled();

		await harness.handlers.get("turn_end")?.(assistantTurn("stopped", "aborted") as never, harness.context);
		expect(loadLatestGoalLoopState(harness.entries)?.status).toBe("stopped");
		expect(harness.dependencies.writeReceipt).toHaveBeenCalledOnce();
	});

	it("applies stop after an active verifier returns and never replans", async () => {
		let resolveVerification: ((result: VerifyResult) => void) | undefined;
		const verification = new Promise<VerifyResult>((resolve) => {
			resolveVerification = resolve;
		});
		const harness = createHarness();
		vi.mocked(harness.dependencies.verify).mockImplementation(async () => verification);
		await harness.commands.get("run")?.("验证期间可安全停止", harness.context);
		await report(harness, { status: "continue", summary: "等待验证", gap: "仍需检查" });
		await harness.handlers.get("turn_end")?.(assistantTurn() as never, harness.context);
		const settling = harness.handlers.get("agent_settled")?.(
			{ type: "agent_settled" } as never,
			harness.context,
		) as Promise<void>;
		await vi.waitFor(() => expect(loadLatestGoalLoopState(harness.entries)?.status).toBe("verifying"));
		harness.selections.push("验证后停止并生成回执");

		await harness.commands.get("run")?.("", harness.context);
		expect(harness.dependencies.writeReceipt).not.toHaveBeenCalled();
		resolveVerification?.(passingVerifyResult());
		await settling;

		expect(loadLatestGoalLoopState(harness.entries)?.status).toBe("stopped");
		expect(harness.dependencies.writeReceipt).toHaveBeenCalledOnce();
		expect(harness.sentUserMessages).toHaveLength(1);
	});

	it("preserves verifier evidence when pausing at the verification boundary", async () => {
		let resolveVerification: ((result: VerifyResult) => void) | undefined;
		const verification = new Promise<VerifyResult>((resolve) => {
			resolveVerification = resolve;
		});
		const harness = createHarness();
		vi.mocked(harness.dependencies.verify).mockImplementation(async () => verification);
		await harness.commands.get("run")?.("验证期间可安全暂停", harness.context);
		await report(harness, { status: "continue", summary: "等待验证", gap: "仍需检查" });
		await harness.handlers.get("turn_end")?.(assistantTurn() as never, harness.context);
		const settling = harness.handlers.get("agent_settled")?.(
			{ type: "agent_settled" } as never,
			harness.context,
		) as Promise<void>;
		await vi.waitFor(() => expect(loadLatestGoalLoopState(harness.entries)?.status).toBe("verifying"));
		harness.selections.push("验证后暂停");

		await harness.commands.get("run")?.("", harness.context);
		resolveVerification?.(passingVerifyResult());
		await settling;

		const state = loadLatestGoalLoopState(harness.entries);
		expect(state?.status).toBe("paused");
		expect(state?.iterations[0]?.verification).toHaveLength(1);
		expect(harness.sentUserMessages).toHaveLength(1);
	});

	it("keeps a verified result when receipt persistence fails and retries on the next /run", async () => {
		const harness = createHarness();
		vi.mocked(harness.dependencies.writeReceipt).mockRejectedValueOnce(new Error("disk temporarily busy"));
		await harness.commands.get("run")?.("修复解析器", harness.context);
		await report(harness, { status: "complete", summary: "已经完成" });
		await settle(harness);

		expect(loadLatestGoalLoopState(harness.entries)).toMatchObject({
			status: "verified",
			receiptError: expect.stringContaining("disk temporarily busy"),
		});

		await harness.commands.get("run")?.("", harness.context);

		expect(loadLatestGoalLoopState(harness.entries)).toMatchObject({
			status: "verified",
			receiptPath: "C:/agent/runs/receipt.json",
		});
		expect(harness.dependencies.writeReceipt).toHaveBeenCalledTimes(2);
	});

	it("discards a stale verifier result after the session branch changes", async () => {
		let resolveVerification: ((result: VerifyResult) => void) | undefined;
		const verification = new Promise<VerifyResult>((resolve) => {
			resolveVerification = resolve;
		});
		const harness = createHarness();
		vi.mocked(harness.dependencies.verify).mockImplementation(async () => verification);
		await harness.commands.get("run")?.("分支 A 的目标", harness.context);
		await report(harness, { status: "complete", summary: "分支 A 已完成" });
		await harness.handlers.get("turn_end")?.(assistantTurn() as never, harness.context);
		const settling = harness.handlers.get("agent_settled")?.(
			{ type: "agent_settled" } as never,
			harness.context,
		) as Promise<void>;
		await vi.waitFor(() => expect(loadLatestGoalLoopState(harness.entries)?.status).toBe("verifying"));

		const branchB = terminalState("branch-b", "C:/agent/runs/branch-b.json");
		harness.entries.push({
			type: "custom",
			id: "branch-b-entry",
			parentId: harness.entries.at(-1)?.id ?? null,
			timestamp: "2026-08-12T00:00:20.000Z",
			customType: GOAL_LOOP_ENTRY_TYPE,
			data: branchB,
		});
		await harness.handlers.get("session_tree")?.({ type: "session_tree" } as never, harness.context);
		resolveVerification?.(passingVerifyResult());
		await settling;

		expect(loadLatestGoalLoopState(harness.entries)).toMatchObject({
			runId: "branch-b",
			status: "verified",
			receiptPath: "C:/agent/runs/branch-b.json",
		});
		expect(harness.dependencies.writeReceipt).not.toHaveBeenCalled();
	});

	it("does not attach a stale receipt completion to a newly selected branch", async () => {
		let resolveReceipt: ((value: string) => void) | undefined;
		const receipt = new Promise<string>((resolve) => {
			resolveReceipt = resolve;
		});
		const harness = createHarness();
		vi.mocked(harness.dependencies.writeReceipt).mockImplementation(async () => receipt);
		await harness.commands.get("run")?.("分支 A 的目标", harness.context);
		await report(harness, { status: "complete", summary: "分支 A 已完成" });
		await harness.handlers.get("turn_end")?.(assistantTurn() as never, harness.context);
		const settling = harness.handlers.get("agent_settled")?.(
			{ type: "agent_settled" } as never,
			harness.context,
		) as Promise<void>;
		await vi.waitFor(() => expect(harness.dependencies.writeReceipt).toHaveBeenCalledOnce());

		const branchB = terminalState("branch-b", "C:/agent/runs/branch-b.json");
		harness.entries.push({
			type: "custom",
			id: "branch-b-receipt-entry",
			parentId: harness.entries.at(-1)?.id ?? null,
			timestamp: "2026-08-12T00:00:20.000Z",
			customType: GOAL_LOOP_ENTRY_TYPE,
			data: branchB,
		});
		await harness.handlers.get("session_tree")?.({ type: "session_tree" } as never, harness.context);
		resolveReceipt?.("C:/agent/runs/branch-a.json");
		await settling;

		expect(loadLatestGoalLoopState(harness.entries)).toMatchObject({
			runId: "branch-b",
			status: "verified",
			receiptPath: "C:/agent/runs/branch-b.json",
		});
	});

	it("checkpoints tool budgets during a long Agent turn without logging every tool result", async () => {
		const harness = createHarness();
		await harness.commands.get("run")?.("执行包含很多工具调用的迁移", harness.context);
		const initialEntries = harness.entries.length;
		const handler = harness.handlers.get("tool_result");
		for (let index = 0; index < 9; index += 1) {
			await handler?.({ type: "tool_result", toolName: "read", isError: false } as never, harness.context);
		}
		expect(harness.entries).toHaveLength(initialEntries);

		await handler?.({ type: "tool_result", toolName: "read", isError: false } as never, harness.context);

		expect(harness.entries).toHaveLength(initialEntries + 1);
		expect(loadLatestGoalLoopState(harness.entries)).toMatchObject({ metrics: { toolCalls: { read: 10 } } });
	});

	it("flushes the final partial tool checkpoint on a clean session shutdown", async () => {
		const harness = createHarness();
		await harness.commands.get("run")?.("执行包含少量工具调用的任务", harness.context);
		const initialEntries = harness.entries.length;
		const handler = harness.handlers.get("tool_result");
		for (let index = 0; index < 3; index += 1) {
			await handler?.({ type: "tool_result", toolName: "read", isError: false } as never, harness.context);
		}
		expect(harness.entries).toHaveLength(initialEntries);

		await harness.handlers.get("session_shutdown")?.({ type: "session_shutdown" } as never, harness.context);

		expect(loadLatestGoalLoopState(harness.entries)).toMatchObject({ metrics: { toolCalls: { read: 3 } } });
	});

	it("charges context compaction to the frozen token budget and stops before retry", async () => {
		const harness = createHarness();
		await harness.commands.get("run")?.("持续执行直到上下文需要压缩", harness.context);

		await harness.handlers.get("session_compact")?.(
			{
				type: "session_compact",
				compactionEntry: {
					usage: {
						input: 399_000,
						output: 1_000,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 400_000,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
					},
				},
			} as never,
			harness.context,
		);

		expect(loadLatestGoalLoopState(harness.entries)).toMatchObject({
			status: "budget_exhausted",
			reason: "token_budget",
			metrics: { turns: 0, usage: { totalTokens: 400_000 } },
			receiptPath: "C:/agent/runs/receipt.json",
		});
		expect(harness.context.abort).toHaveBeenCalledOnce();
		expect(harness.dependencies.writeReceipt).toHaveBeenCalledOnce();
	});
});
