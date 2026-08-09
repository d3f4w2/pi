import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { RecoveredFailureTracker } from "../src/extensions/evals/failure-tracker.ts";
import { createEvalsExtension } from "../src/extensions/evals/index.ts";
import {
	formatRegressionDraftPreview,
	RegressionCaseStore,
	RegressionCaseWriter,
	validateRegressionDraft,
} from "../src/extensions/evals/regression-cases.ts";
import type {
	RecoveredFailureSignal,
	RegressionCaseStoreLike,
	RegressionCaseWriterLike,
	RegressionTestDraft,
} from "../src/extensions/evals/types.ts";
import { setLanguageSetting } from "../src/modes/interactive/i18n/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

function tool(toolName: string, isError: boolean, details?: unknown, input: Record<string, unknown> = {}) {
	return { toolName, isError, details, input };
}

function signal(): RecoveredFailureSignal {
	return {
		fingerprint: "tool_error-read",
		kind: "tool_error",
		toolName: "read",
		summary: "读取工具失败后任务恢复",
		detectedAt: "2026-08-09T00:00:00.000Z",
		recoveredAt: "2026-08-09T00:00:01.000Z",
	};
}

function draft(overrides: Partial<RegressionTestDraft> = {}): RegressionTestDraft {
	return {
		title: "读取失败不会拖垮任务",
		category: "fallback",
		reproduction: ["让读取工具返回一次可恢复错误", "继续使用已有上下文完成任务"],
		expectedFailure: "代理重复读取或终止任务",
		expectedSuccess: "代理停止重试并继续任务",
		files: [
			{
				path: "test/regressions/read-fallback.test.ts",
				content: 'import { test } from "vitest";\n\ntest("fallback", () => {});\n',
			},
		],
		...overrides,
	};
}

describe("recovered failure tracker", () => {
	it("emits a sanitized signal only after a tool error is recovered", () => {
		const tracker = new RecoveredFailureTracker();
		tracker.start(1_000);
		tracker.recordTool(tool("read", true, { secret: "never retain" }, { path: "private/file.ts" }));
		tracker.recordTurn("stop");
		const result = tracker.finish(2_000);
		expect(result).toMatchObject({ kind: "tool_error", toolName: "read" });
		expect(JSON.stringify(result)).not.toContain("private/file.ts");
		expect(JSON.stringify(result)).not.toContain("never retain");
	});

	it("carries an unresolved failure into the next successful run", () => {
		const tracker = new RecoveredFailureTracker();
		tracker.start(1_000);
		tracker.recordTool(tool("verify", false, { passed: false, checks: [{ status: "failed" }] }));
		tracker.recordTurn("error");
		expect(tracker.finish(2_000)).toBeUndefined();
		tracker.start(3_000);
		tracker.recordTurn("stop");
		expect(tracker.finish(4_000)).toMatchObject({ kind: "verification_failure", toolName: "verify" });
	});

	it("does not turn a user abort into a regression candidate", () => {
		const tracker = new RecoveredFailureTracker();
		tracker.start(1_000);
		tracker.recordTool(tool("read", true));
		tracker.recordTurn("aborted");
		expect(tracker.finish(2_000)).toBeUndefined();
		tracker.start(3_000);
		tracker.recordTurn("stop");
		expect(tracker.finish(4_000)).toBeUndefined();
	});

	it("does not call an unfinished run a recovery", () => {
		const tracker = new RecoveredFailureTracker();
		tracker.start(1_000);
		tracker.recordTool(tool("read", true));
		expect(tracker.finish(2_000)).toBeUndefined();
	});
});

describe("regression draft validation", () => {
	it("accepts a small new test and renders the complete content for review", () => {
		const value = draft();
		expect(validateRegressionDraft(value)).toEqual(value);
		const preview = formatRegressionDraftPreview(value, signal());
		expect(preview).toContain("read-fallback.test.ts");
		expect(preview).toContain('test("fallback"');
		expect(preview).toContain("读取工具失败后任务恢复");
	});

	it.each([
		["path traversal", draft({ files: [{ path: "../escape.test.ts", content: "test" }] })],
		["non-test path", draft({ files: [{ path: "src/feature.ts", content: "test" }] })],
		[
			"secret",
			draft({ files: [{ path: "test/secret.test.ts", content: 'const apiKey = "sk-12345678901234567890";' }] }),
		],
		["control character", draft({ files: [{ path: "test/control.test.ts", content: "safe\u001b[2J" }] })],
	])("rejects %s", (_name, value) => {
		expect(() => validateRegressionDraft(value)).toThrow();
	});
});

describe("approved regression writer", () => {
	it("creates only new test files and records approval metadata", async () => {
		const workspace = await mkdtemp(path.join(tmpdir(), "pi-regression-workspace-"));
		const agentDirectory = await mkdtemp(path.join(tmpdir(), "pi-regression-agent-"));
		temporaryDirectories.push(workspace, agentDirectory);
		const store = new RegressionCaseStore(agentDirectory);
		const result = await new RegressionCaseWriter(store).write(
			workspace,
			draft(),
			signal(),
			new Date("2026-08-09T00:00:02.000Z"),
		);
		expect(await readFile(path.join(workspace, "test/regressions/read-fallback.test.ts"), "utf8")).toContain(
			"fallback",
		);
		expect(await store.listApproved()).toEqual([result]);
	});

	it("rejects overwrite and rolls back files when metadata persistence fails", async () => {
		const workspace = await mkdtemp(path.join(tmpdir(), "pi-regression-workspace-"));
		temporaryDirectories.push(workspace);
		const existing = path.join(workspace, "test/regressions/existing.test.ts");
		await mkdir(path.dirname(existing), { recursive: true });
		await writeFile(existing, "existing", { encoding: "utf8", flag: "wx" });
		const rejectingStore: RegressionCaseStoreLike = {
			isSuppressed: async () => false,
			suppress: async () => {},
			saveApproved: async () => {
				throw new Error("metadata failed");
			},
			listApproved: async () => [],
		};
		const writer = new RegressionCaseWriter(rejectingStore);
		await expect(
			writer.write(
				workspace,
				draft({ files: [{ path: "test/regressions/existing.test.ts", content: "new" }] }),
				signal(),
			),
		).rejects.toThrow("已经存在");
		const createdPath = path.join(workspace, "test/regressions/rollback.test.ts");
		await expect(
			writer.write(
				workspace,
				draft({ files: [{ path: "test/regressions/rollback.test.ts", content: "test" }] }),
				signal(),
			),
		).rejects.toThrow("metadata failed");
		await expect(access(createdPath)).rejects.toThrow();
	});

	it("persists suppression by failure fingerprint", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "pi-regression-agent-"));
		temporaryDirectories.push(directory);
		const store = new RegressionCaseStore(directory);
		expect(await store.isSuppressed(signal().fingerprint)).toBe(false);
		await store.suppress(signal().fingerprint);
		expect(await store.isSuppressed(signal().fingerprint)).toBe(true);
	});
});

interface CaptureHarness {
	activeTools: string[];
	confirmations: boolean[];
	context: ExtensionContext;
	handlers: Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;
	notifications: string[];
	selections: Array<string | undefined>;
	sentMessages: string[];
	store: RegressionCaseStoreLike;
	tool: ToolDefinition;
	writer: RegressionCaseWriterLike;
}

function createCaptureHarness(language: "zh-CN" | "en" = "zh-CN"): CaptureHarness {
	setLanguageSetting(language);
	const activeTools = ["read", "eval_case"];
	const confirmations: boolean[] = [];
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const notifications: string[] = [];
	const selections: Array<string | undefined> = [];
	const sentMessages: string[] = [];
	let toolDefinition: ToolDefinition | undefined;
	const store: RegressionCaseStoreLike = {
		isSuppressed: vi.fn(async () => false),
		suppress: vi.fn(async () => {}),
		saveApproved: vi.fn(async () => {}),
		listApproved: vi.fn(async () => []),
	};
	const writeCase: RegressionCaseWriterLike["write"] = async (_cwd, value, source, now) => ({
		version: 1,
		id: "approved-case",
		title: value.title,
		category: value.category,
		approvedAt: (now ?? new Date()).toISOString(),
		source,
		reproduction: value.reproduction,
		expectedFailure: value.expectedFailure,
		expectedSuccess: value.expectedSuccess,
		files: value.files.map((file) => ({ path: file.path, bytes: file.content.length, digest: "digest" })),
	});
	const writer: RegressionCaseWriterLike = {
		write: vi.fn(writeCase),
	};
	const context = {
		hasUI: true,
		mode: "tui",
		cwd: "C:/repo",
		ui: {
			select: async () => selections.shift(),
			confirm: async () => confirmations.shift() ?? false,
			notify: (message: string) => notifications.push(message),
		},
	} as unknown as ExtensionContext;
	const api = {
		registerCommand: vi.fn(),
		registerTool: (tool: ToolDefinition) => {
			toolDefinition = tool;
		},
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => {
			activeTools.splice(0, activeTools.length, ...names);
		},
		sendUserMessage: (message: string) => sentMessages.push(message),
	} as unknown as ExtensionAPI;
	createEvalsExtension(
		{
			append: async () => {},
			read: async () => [],
			saveBaseline: async () => {},
			readBaseline: async () => undefined,
		},
		() => new Date("2026-08-09T00:00:02.000Z"),
		store,
		writer,
	)(api);
	if (!toolDefinition) throw new Error("eval_case tool was not registered");
	return {
		activeTools,
		confirmations,
		context,
		handlers,
		notifications,
		selections,
		sentMessages,
		store,
		tool: toolDefinition,
		writer,
	};
}

async function emitRecoveredReadFailure(harness: CaptureHarness): Promise<void> {
	await harness.handlers.get("agent_start")?.({ type: "agent_start" }, harness.context);
	await harness.handlers.get("tool_result")?.(
		{ type: "tool_result", toolName: "read", input: { path: "private.ts" }, details: {}, isError: true },
		harness.context,
	);
	await harness.handlers.get("turn_end")?.(
		{ type: "turn_end", message: { role: "assistant", stopReason: "stop" }, toolResults: [] },
		harness.context,
	);
	await harness.handlers.get("agent_end")?.({ type: "agent_end", messages: [] }, harness.context);
	await harness.handlers.get("agent_settled")?.({ type: "agent_settled" }, harness.context);
}

describe("agent regression capture approvals", () => {
	it("keeps the internal tool inactive until the user approves generation", async () => {
		const harness = createCaptureHarness();
		expect(harness.activeTools).toEqual(["read"]);
		harness.selections.push("允许制作");
		await emitRecoveredReadFailure(harness);
		expect(harness.activeTools).toContain("eval_case");
		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.sentMessages[0]).toContain("不得读取额外文件");
	});

	it("blocks other tools and writes only after the second approval", async () => {
		const harness = createCaptureHarness();
		harness.selections.push("允许制作");
		harness.confirmations.push(true);
		await emitRecoveredReadFailure(harness);
		await harness.handlers.get("agent_start")?.({ type: "agent_start" }, harness.context);
		const blocked = await harness.handlers.get("tool_call")?.(
			{ type: "tool_call", toolCallId: "read-1", toolName: "read", input: { path: "extra.ts" } },
			harness.context,
		);
		expect(blocked).toMatchObject({ block: true });
		const grantId = harness.sentMessages[0]?.match(/grantId：([^\s]+)/)?.[1];
		if (!grantId) throw new Error("grant id missing");
		const result = await harness.tool.execute(
			"case-1",
			{ grantId, ...draft() },
			undefined,
			undefined,
			harness.context,
		);
		expect(result.content).toContainEqual(
			expect.objectContaining({ type: "text", text: expect.stringContaining("approved-case") }),
		);
		expect(harness.writer.write).toHaveBeenCalledOnce();
		expect(harness.activeTools).toEqual(["read"]);
	});

	it("discards a generated candidate when the second approval is rejected", async () => {
		const harness = createCaptureHarness();
		harness.selections.push("允许制作");
		harness.confirmations.push(false);
		await emitRecoveredReadFailure(harness);
		const grantId = harness.sentMessages[0]?.match(/grantId：([^\s]+)/)?.[1];
		if (!grantId) throw new Error("grant id missing");
		await harness.tool.execute("case-1", { grantId, ...draft() }, undefined, undefined, harness.context);
		expect(harness.writer.write).not.toHaveBeenCalled();
		expect(harness.activeTools).toEqual(["read"]);
	});

	it("persists suppression without generating a model turn", async () => {
		const harness = createCaptureHarness();
		harness.selections.push("不再提示此类错误");
		await emitRecoveredReadFailure(harness);
		expect(harness.store.suppress).toHaveBeenCalledOnce();
		expect(harness.sentMessages).toHaveLength(0);
		expect(harness.activeTools).toEqual(["read"]);
	});

	it("does nothing when the host cannot ask for approval", async () => {
		const harness = createCaptureHarness();
		const headless = { ...harness.context, hasUI: false, mode: "print" } as ExtensionContext;
		harness.context = headless;
		await emitRecoveredReadFailure(harness);
		expect(harness.sentMessages).toHaveLength(0);
		expect(harness.activeTools).toEqual(["read"]);
	});

	it("uses the configured English interface language", async () => {
		const harness = createCaptureHarness("en");
		harness.selections.push("Allow generation");
		await emitRecoveredReadFailure(harness);
		expect(harness.sentMessages[0]).toContain("Do not read files");
	});
});
