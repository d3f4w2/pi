import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../src/core/extensions/types.ts";
import { createTurnUndoExtension } from "../src/extensions/turn-undo/index.ts";
import type { TurnUndoCapture, TurnUndoSnapshot } from "../src/extensions/turn-undo/types.ts";

const capture = {
	id: "capture-1",
	root: "/repo",
	realRoot: "/repo",
	sessionId: "session-1",
	startedAt: "2026-08-09T00:00:00.000Z",
	headRef: "head",
	baseRef: "base",
	directory: "/storage/pending",
	workspaceDirectory: "/storage/workspace",
	lockToken: "lock",
	untracked: [],
	trackedOverrides: [],
} satisfies TurnUndoCapture;

const snapshot = {
	version: 1,
	id: "snapshot-1",
	root: "/repo",
	sessionId: "session-1",
	headRef: "head",
	createdAt: "2026-08-09T00:01:00.000Z",
	state: "ready",
	files: [
		{ path: "src/changed.ts", kind: "modified", beforeFile: "before-0000.bin", afterState: "hash-1" },
		{ path: "src/new.ts", kind: "created", afterState: "hash-2" },
	],
} satisfies TurnUndoSnapshot;

function createHarness(confirmResult = true) {
	const handlers = new Map<string, (event: never, ctx: ExtensionContext) => Promise<void>>();
	let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	const begin = vi.fn(async () => ({ status: "started" as const, capture }));
	const finalize = vi.fn(async () => ({ status: "saved" as const, snapshot }));
	const getLatest = vi.fn(async () => snapshot);
	const undoLatest = vi.fn(async () => ({
		status: "restored" as const,
		snapshot: { ...snapshot, state: "undone" as const },
	}));
	const release = vi.fn();
	const api = {
		on: (event: string, handler: (event: never, ctx: ExtensionContext) => Promise<void>) =>
			handlers.set(event, handler),
		registerCommand: (
			name: string,
			options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
		) => {
			if (name === "undo-turn") command = options.handler;
		},
	} as unknown as ExtensionAPI;
	createTurnUndoExtension({ begin, finalize, getLatest, undoLatest, release })(api);
	const notify = vi.fn();
	const confirm = vi.fn(async () => confirmResult);
	const context = {
		cwd: "/repo",
		hasUI: true,
		ui: { notify, confirm },
		isIdle: () => true,
		isProjectTrusted: () => true,
		waitForIdle: vi.fn(async () => {}),
		sessionManager: { getSessionId: () => "session-1" },
	} as unknown as ExtensionCommandContext;
	return {
		handlers,
		command: () => command,
		begin,
		finalize,
		getLatest,
		undoLatest,
		release,
		notify,
		confirm,
		context,
	};
}

describe("turn undo extension", () => {
	it("captures one settled agent run and tells the user how to undo it", async () => {
		const harness = createHarness();
		await harness.handlers.get("agent_start")?.({} as never, harness.context);
		await harness.handlers.get("agent_start")?.({} as never, harness.context);
		await harness.handlers.get("agent_settled")?.({} as never, harness.context);

		expect(harness.begin).toHaveBeenCalledOnce();
		expect(harness.begin).toHaveBeenCalledWith("/repo", "session-1");
		expect(harness.finalize).toHaveBeenCalledWith(capture);
		expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("2 个文件"), "info");
		expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("/undo-turn"), "info");
	});

	it("shows the file list and only restores after confirmation", async () => {
		const harness = createHarness(true);
		await harness.command()?.("", harness.context);

		expect(harness.confirm).toHaveBeenCalledWith(
			"撤销最近一次代理修改？",
			expect.stringContaining("修改  src/changed.ts"),
		);
		expect(harness.confirm).toHaveBeenCalledWith(
			"撤销最近一次代理修改？",
			expect.stringContaining("新建  src/new.ts（撤销时删除）"),
		);
		expect(harness.undoLatest).toHaveBeenCalledWith("/repo");
		expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("已撤销"), "info");
	});

	it("does not restore when the user cancels", async () => {
		const harness = createHarness(false);
		await harness.command()?.("", harness.context);
		expect(harness.undoLatest).not.toHaveBeenCalled();
	});

	it("refuses to restore without an interactive confirmation UI", async () => {
		const harness = createHarness();
		const context = { ...harness.context, hasUI: false } as ExtensionCommandContext;
		await harness.command()?.("", context);
		expect(harness.getLatest).not.toHaveBeenCalled();
		expect(harness.undoLatest).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("交互界面"), "error");
	});

	it("does not run Git snapshot commands for an untrusted project", async () => {
		const harness = createHarness();
		const context = { ...harness.context, isProjectTrusted: () => false } as ExtensionCommandContext;
		await harness.handlers.get("agent_start")?.({} as never, context);
		expect(harness.begin).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("尚未被信任"), "warning");
	});
});
