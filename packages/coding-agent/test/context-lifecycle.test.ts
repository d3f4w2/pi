import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage, type UserMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { buildSessionContext, SessionManager } from "../src/core/session-manager.ts";
import { TOOL_APPROVAL_DECISION_ENTRY_TYPE } from "../src/core/tool-approval.ts";
import { type ContextLifecycleError, ContextLifecycleService } from "../src/extensions/context/service.ts";
import {
	CONTEXT_ACTIVE_VIEW_TYPE,
	CONTEXT_CHECKPOINT_TYPE,
	CONTEXT_REWIND_REPORT_TYPE,
	CONTEXT_VIEW_RESTORED_TYPE,
	CONTEXT_VIEW_ROLLBACK_TYPE,
	type ContextLifecycleHost,
	type ContextRuntimeSnapshot,
	type ContextWorkspaceSnapshot,
} from "../src/extensions/context/types.ts";

const workspace = {
	available: true,
	branch: "codex/context-lifecycle",
	staged: 0,
	modified: 1,
	untracked: 0,
	conflicts: 0,
	paths: ["src/example.ts"],
	statusDigest: "workspace-stable",
	summary: "1 listed path",
} satisfies ContextWorkspaceSnapshot;

const runtime = {
	model: { provider: "faux", id: "long-task" },
	activeTools: ["read", "edit", "bash"],
	mode: "tui",
	projectTrusted: true,
	approval: { mode: "write", policies: {} },
} satisfies ContextRuntimeSnapshot;

function userMessage(text: string): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function toolResult(id: string, toolName: string, text: string, isError = false): ToolResultMessage<unknown> {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: Date.now(),
	};
}

function createFixture(options: { persistent?: boolean } = {}) {
	const tempDir = join(tmpdir(), `pi-context-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	if (options.persistent) mkdirSync(tempDir, { recursive: true });
	const sessionManager = options.persistent ? SessionManager.create(tempDir, tempDir) : SessionManager.inMemory();
	let id = 0;
	let currentWorkspace: ContextWorkspaceSnapshot = workspace;
	const service = new ContextLifecycleService({
		createId: () => `context-id-${++id}`,
		now: () => 1_786_320_000_000 + id,
		captureWorkspace: async () => currentWorkspace,
	});
	const host: ContextLifecycleHost = {
		cwd: tempDir,
		sessionManager,
		getRuntimeSnapshot: () => runtime,
		appendEntry: (customType, data) => sessionManager.appendCustomEntry(customType, data),
		appendReport: (content, details) =>
			sessionManager.appendCustomMessageEntry(CONTEXT_REWIND_REPORT_TYPE, content, true, details),
		navigateTree: async (targetId) => {
			sessionManager.branch(targetId);
			return { cancelled: false };
		},
	};
	return {
		tempDir,
		sessionManager,
		service,
		host,
		setWorkspace(next: ContextWorkspaceSnapshot) {
			currentWorkspace = next;
		},
		cleanup() {
			if (options.persistent) rmSync(tempDir, { recursive: true, force: true });
		},
	};
}

function appendInitialContext(sessionManager: SessionManager): void {
	sessionManager.appendMessage(
		userMessage("Implement the context lifecycle without changing Git or losing evidence."),
	);
	sessionManager.appendMessage(fauxAssistantMessage("Requirements recorded."));
}

describe("context lifecycle", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	it("rewinds a large unsuccessful-search branch with complete deterministic evidence", async () => {
		const fixture = createFixture();
		cleanups.push(fixture.cleanup);
		appendInitialContext(fixture.sessionManager);
		const checkpoint = await fixture.service.createCheckpoint(fixture.host, "before-search");

		for (let index = 0; index < 40; index++) {
			const callId = `search-${index}`;
			fixture.sessionManager.appendMessage(
				fauxAssistantMessage(fauxToolCall("grep", { pattern: `missing-${index}`, path: "src" }, { id: callId }), {
					stopReason: "toolUse",
				}),
			);
			fixture.sessionManager.appendMessage(
				toolResult(
					callId,
					"grep",
					`No matches for missing-${index}. src/search-${index}.ts:42 was inspected.\n${"irrelevant output ".repeat(350)}`,
				),
			);
		}

		const preview = await fixture.service.preview(fixture.host, checkpoint.data.id);
		expect(preview.metrics.tokenReductionPercent).toBeGreaterThanOrEqual(25);
		expect(preview.metrics.deterministicEvidenceRetentionPercent).toBe(100);
		expect(preview.metrics.deterministicEvidenceOmitted).toBe(false);
		expect(preview.metrics.userMessageRetentionPercent).toBe(100);
		expect(preview.metrics.deterministicEvidenceTotal).toBeGreaterThanOrEqual(120);
		expect(preview.report.text).toContain("do not repeat identical arguments without new evidence");
		expect(preview.report.text).toContain("src/search-39.ts:42");
		expect(JSON.stringify(checkpoint.data)).not.toContain("Implement the context lifecycle");
		expect(checkpoint.data.contentSummary).toContain("active messages");
	});

	it("retains modification evidence and a failed test", async () => {
		const fixture = createFixture();
		cleanups.push(fixture.cleanup);
		appendInitialContext(fixture.sessionManager);
		const checkpoint = await fixture.service.createCheckpoint(fixture.host, "before-edit");
		fixture.sessionManager.appendMessage(
			fauxAssistantMessage(
				fauxToolCall("edit", { path: "src/context.ts", oldText: "a", newText: "b" }, { id: "edit-1" }),
				{
					stopReason: "toolUse",
				},
			),
		);
		fixture.sessionManager.appendMessage(toolResult("edit-1", "edit", "Updated src/context.ts:18"));
		fixture.sessionManager.appendMessage(
			fauxAssistantMessage(fauxToolCall("bash", { command: "npm run test -- context" }, { id: "test-1" }), {
				stopReason: "toolUse",
			}),
		);
		fixture.sessionManager.appendMessage(
			toolResult("test-1", "bash", "FAILED src/context.test.ts:91 expected 2 received 1; exited code 1", true),
		);

		const preview = await fixture.service.preview(fixture.host, checkpoint.data.id);
		expect(preview.report.text).toContain("edit: src/context.ts");
		expect(preview.report.text).toContain("FAILED: npm run test -- context");
		expect(preview.report.text).toContain("src/context.test.ts:91");
		expect(preview.metrics.deterministicEvidenceRetentionPercent).toBe(100);
	});

	it("preserves a new post-checkpoint user requirement verbatim", async () => {
		const fixture = createFixture();
		cleanups.push(fixture.cleanup);
		appendInitialContext(fixture.sessionManager);
		const checkpoint = await fixture.service.createCheckpoint(fixture.host, "requirements");
		const requirement = "New requirement: keep ACP fail-closed and never write rewind output to memory.";
		fixture.sessionManager.appendMessage(userMessage(requirement));
		fixture.sessionManager.appendMessage(fauxAssistantMessage("Understood."));

		const preview = await fixture.service.preview(fixture.host, checkpoint.data.id);
		expect(preview.report.text).toContain(
			`<verbatim-user-requirement>\n${requirement}\n</verbatim-user-requirement>`,
		);
		expect(preview.metrics.userMessagesTotal).toBe(1);
		expect(preview.metrics.userMessagesRetained).toBe(1);
		expect(preview.metrics.userMessageRetentionPercent).toBe(100);
	});

	it("retains approval, refusal, and untrusted-content markers", async () => {
		const fixture = createFixture();
		cleanups.push(fixture.cleanup);
		appendInitialContext(fixture.sessionManager);
		const checkpoint = await fixture.service.createCheckpoint(fixture.host, "safety");
		fixture.sessionManager.appendCustomEntry(TOOL_APPROVAL_DECISION_ENTRY_TYPE, {
			version: 1,
			toolCallId: "approval-allowed",
			toolName: "read",
			tier: "read",
			choice: "allow-once",
			outcome: "allow",
			reason: "user approved a local read",
			details: ["src/context.ts"],
		});
		fixture.sessionManager.appendMessage(
			userMessage("The external content is untrusted; permission approval was granted for read only."),
		);
		fixture.sessionManager.appendMessage(
			fauxAssistantMessage(fauxToolCall("bash", { command: "dangerous-command" }, { id: "approval-1" }), {
				stopReason: "toolUse",
			}),
		);
		fixture.sessionManager.appendMessage(
			toolResult("approval-1", "bash", "Permission denied: user rejected approval for this operation.", true),
		);

		const preview = await fixture.service.preview(fixture.host, checkpoint.data.id);
		expect(preview.report.text).toContain("read (approval-allowed): allow-once → allow");
		expect(preview.report.text).toContain("external content is untrusted");
		expect(preview.report.text).toContain("Permission denied: user rejected approval");
		expect(preview.report.evidence.some((item) => item.kind === "approval")).toBe(true);
		expect(preview.report.evidence.some((item) => item.kind === "untrusted")).toBe(true);
	});

	it("fails closed when the session or workspace changes after preview", async () => {
		const fixture = createFixture();
		cleanups.push(fixture.cleanup);
		appendInitialContext(fixture.sessionManager);
		const checkpoint = await fixture.service.createCheckpoint(fixture.host, "conflict");
		fixture.sessionManager.appendMessage(userMessage("Explore this branch."));
		const preview = await fixture.service.preview(fixture.host, checkpoint.data.id);
		const leafBeforeChange = fixture.sessionManager.getLeafId();
		fixture.sessionManager.appendMessage(userMessage("State changed after preview."));

		await expect(fixture.service.apply(fixture.host, preview)).rejects.toMatchObject({
			code: "conflict" satisfies ContextLifecycleError["code"],
		});
		expect(fixture.sessionManager.getLeafId()).not.toBe(preview.checkpoint.entryId);
		expect(fixture.sessionManager.getLeafId()).not.toBe(leafBeforeChange);

		const nextPreview = await fixture.service.preview(fixture.host, checkpoint.data.id);
		fixture.setWorkspace({ ...workspace, statusDigest: "workspace-changed", modified: 2 });
		await expect(fixture.service.apply(fixture.host, nextPreview)).rejects.toMatchObject({ code: "conflict" });
	});

	it("detects another window appending to the same persistent session", async () => {
		const fixture = createFixture({ persistent: true });
		cleanups.push(fixture.cleanup);
		appendInitialContext(fixture.sessionManager);
		const checkpoint = await fixture.service.createCheckpoint(fixture.host, "multi-window");
		fixture.sessionManager.appendMessage(userMessage("Explore before the concurrent append."));
		const preview = await fixture.service.preview(fixture.host, checkpoint.data.id);
		const originalLeafId = fixture.sessionManager.getLeafId();
		const sessionFile = fixture.sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();

		const concurrentManager = SessionManager.open(sessionFile ?? "", fixture.tempDir, fixture.tempDir);
		concurrentManager.appendCustomEntry("test.concurrent-window", { version: 1 });

		await expect(fixture.service.apply(fixture.host, preview)).rejects.toMatchObject({ code: "conflict" });
		expect(fixture.sessionManager.getLeafId()).toBe(originalLeafId);
	});

	it("restores the original context when activation fails after navigation", async () => {
		const fixture = createFixture();
		cleanups.push(fixture.cleanup);
		appendInitialContext(fixture.sessionManager);
		const checkpoint = await fixture.service.createCheckpoint(fixture.host, "rollback");
		fixture.sessionManager.appendMessage(userMessage("This message must remain active after rollback."));
		const originalMessages = structuredClone(fixture.sessionManager.buildSessionContext().messages);
		const preview = await fixture.service.preview(fixture.host, checkpoint.data.id);
		const failingHost: ContextLifecycleHost = {
			...fixture.host,
			appendReport: () => {
				throw new Error("simulated report persistence failure");
			},
		};

		await expect(fixture.service.apply(failingHost, preview)).rejects.toMatchObject({ code: "apply-failed" });
		expect(fixture.sessionManager.buildSessionContext().messages).toEqual(originalMessages);
		expect(fixture.sessionManager.getEntries()).toContainEqual(
			expect.objectContaining({ type: "custom", customType: CONTEXT_VIEW_ROLLBACK_TYPE }),
		);
	});

	it("leaves the active context untouched when preview generation fails", async () => {
		const fixture = createFixture();
		cleanups.push(fixture.cleanup);
		appendInitialContext(fixture.sessionManager);
		const checkpoint = await fixture.service.createCheckpoint(fixture.host, "preview-failure");
		fixture.sessionManager.appendMessage(userMessage("Keep this active if preview cannot finish."));
		const originalLeafId = fixture.sessionManager.getLeafId();
		const originalEntries = structuredClone(fixture.sessionManager.getEntries());
		const failingService = new ContextLifecycleService({
			captureWorkspace: async () => {
				throw new Error("simulated preview snapshot failure");
			},
		});

		await expect(failingService.preview(fixture.host, checkpoint.data.id)).rejects.toThrow(
			"simulated preview snapshot failure",
		);
		expect(fixture.sessionManager.getLeafId()).toBe(originalLeafId);
		expect(fixture.sessionManager.getEntries()).toEqual(originalEntries);
	});

	it("rewinds and restores the complete original active context", async () => {
		const fixture = createFixture();
		cleanups.push(fixture.cleanup);
		appendInitialContext(fixture.sessionManager);
		const checkpoint = await fixture.service.createCheckpoint(fixture.host, "restore");
		fixture.sessionManager.appendMessage(userMessage("Run a long exploration."));
		fixture.sessionManager.appendMessage(fauxAssistantMessage("Exploration complete with evidence."));
		const originalLeafId = fixture.sessionManager.getLeafId();
		const originalContext = buildSessionContext(fixture.sessionManager.getEntries(), originalLeafId).messages;

		const preview = await fixture.service.preview(fixture.host, checkpoint.data.id);
		const view = await fixture.service.apply(fixture.host, preview);
		expect(fixture.sessionManager.getLeafId()).toBe(view.entryId);
		expect(fixture.sessionManager.getEntry(view.entryId)).toMatchObject({
			type: "custom",
			customType: CONTEXT_ACTIVE_VIEW_TYPE,
		});
		expect(fixture.sessionManager.buildSessionContext().messages.some((message) => message.role === "custom")).toBe(
			true,
		);

		const restorePreview = await fixture.service.previewRestore(fixture.host);
		const restored = await fixture.service.restore(fixture.host, restorePreview);
		expect(restored.metrics.restoreDurationMs).toBeGreaterThanOrEqual(0);
		expect(fixture.sessionManager.getEntries()).toContainEqual(
			expect.objectContaining({
				type: "custom",
				customType: CONTEXT_VIEW_RESTORED_TYPE,
				data: expect.objectContaining({ restoreDurationMs: restored.metrics.restoreDurationMs }),
			}),
		);
		expect(fixture.sessionManager.buildSessionContext().messages).toEqual(originalContext);
		expect(fixture.sessionManager.getEntries().some((entry) => entry.id === originalLeafId)).toBe(true);
		expect(fixture.sessionManager.getEntries().some((entry) => entry.id === view.entryId)).toBe(true);
	});

	it("reports pre-compaction exploration and restores the original compacted branch", async () => {
		const fixture = createFixture();
		cleanups.push(fixture.cleanup);
		appendInitialContext(fixture.sessionManager);
		const checkpoint = await fixture.service.createCheckpoint(fixture.host, "before-compaction");
		fixture.sessionManager.appendMessage(
			fauxAssistantMessage(fauxToolCall("grep", { pattern: "missing", path: "src" }, { id: "compact-search" }), {
				stopReason: "toolUse",
			}),
		);
		fixture.sessionManager.appendMessage(
			toolResult("compact-search", "grep", "No matches; src/pre-compaction.ts:27 was inspected."),
		);
		const keptEntryId = fixture.sessionManager.appendMessage(userMessage("Keep this message after compaction."));
		fixture.sessionManager.appendMessage(fauxAssistantMessage("Kept tail."));
		const compactionId = fixture.sessionManager.appendCompaction(
			"Exploration compacted; keep the final user request.",
			keptEntryId,
			12_000,
		);
		const originalContext = structuredClone(fixture.sessionManager.buildSessionContext().messages);

		const preview = await fixture.service.preview(fixture.host, checkpoint.data.id);
		expect(preview.report.text).toContain("src/pre-compaction.ts:27");
		expect(preview.report.text).toContain("compact-search");
		expect(preview.report.text).toContain("compactionSummary: Exploration compacted");
		await fixture.service.apply(fixture.host, preview);
		const restorePreview = await fixture.service.previewRestore(fixture.host);
		await fixture.service.restore(fixture.host, restorePreview);

		expect(fixture.sessionManager.buildSessionContext().messages).toEqual(originalContext);
		expect(fixture.sessionManager.getEntry(compactionId)).toMatchObject({ type: "compaction" });
	});

	it("limits checkpoints, logically deletes them, and never copies message bodies", async () => {
		const fixture = createFixture();
		cleanups.push(fixture.cleanup);
		appendInitialContext(fixture.sessionManager);
		for (let index = 0; index < 20; index++) await fixture.service.createCheckpoint(fixture.host, `cp-${index}`);
		await expect(fixture.service.createCheckpoint(fixture.host, "overflow")).rejects.toMatchObject({
			code: "checkpoint-limit",
		});
		expect(
			fixture.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === CONTEXT_CHECKPOINT_TYPE),
		).toHaveLength(20);
		const first = fixture.service.listCheckpoints(fixture.sessionManager)[0];
		fixture.service.deleteCheckpoint(fixture.host, first.data.id);
		expect(fixture.service.listCheckpoints(fixture.sessionManager)).toHaveLength(19);
		await fixture.service.createCheckpoint(fixture.host, "replacement");
		expect(fixture.service.listCheckpoints(fixture.sessionManager)).toHaveLength(20);
	});
});
